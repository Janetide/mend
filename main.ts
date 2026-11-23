// mend — one patch tool for every AI edit format.
//
// Applies an AI-written edit — a unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON edits — to a tree of text files. Every edit in the patch is
// applied, or nothing is written at all. Implements SPEC.md v1 for
// hidden-spec-cli-01-run-20261122. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set and
// this file hands over to runner.ts (kept as the kit has it).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A usage / no-patch / format / parse error: exit 2, exactly one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: exit 1, reported as `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** Split patch text into lines: split at \n, one trailing \r removed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe tree path: non-empty, no leading /, no backslash, no empty, . or .. segments. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Remove surrounding spaces and tabs. */
function trimEdges(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// ---- text files as lines ----

interface FileModel {
  lines: string[];
  br: string; // the file's line break: \r\n when the first \n follows a \r, else \n
  eol: boolean; // true when the file ends with a break
}

/** Parse a file's bytes: split at its own line break, remember the final break. */
function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(lines[i + j], tier) !== normLine(oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) that has an occurrence. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, oldLines, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * One line of the replacement text: a context line (written as the file's own
 * matched line) or a new line. oIdx indexes into the matched old lines.
 */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Build the replacement lines for a match at position `at`. At tier 2 every
 * other new line that is non-empty, not whitespace-only and starts with the
 * old block's first line's leading whitespace has that prefix replaced by the
 * file's first matched line's leading whitespace.
 */
function buildNew(fileLines: string[], at: number, nLines: NLine[], tier: number, oldLines: string[]): string[] {
  const out: string[] = [];
  const f = at < fileLines.length ? leadWs(fileLines[at]) : '';
  const p = oldLines.length > 0 ? leadWs(oldLines[0]) : '';
  for (const nl of nLines) {
    if (nl.ctx) {
      out.push(fileLines[at + nl.oIdx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split a hunk/chunk body into its old lines and its replacement lines. */
function splitBody(body: string[]): { oLines: string[]; nLines: NLine[] } {
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const text = l.slice(1);
      oLines.push(text);
      nLines.push({ text, ctx: true, oIdx: oLines.length - 1 });
    } else if (l.startsWith('-')) {
      oLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      nLines.push({ text: l.slice(1), ctx: false, oIdx: -1 });
    } else if (l === '') {
      oLines.push('');
      nLines.push({ text: '', ctx: true, oIdx: oLines.length - 1 });
    }
    // a \ line is not part of the old or new text; it only marks no-newline
  }
  return { oLines, nLines };
}

// ---- the tree under edit ----

/**
 * The tree as the edits leave it. `now` holds only the paths this run has
 * touched (null = deleted); everything else is read from disk on demand and
 * cached, so the on-disk tree is never written until every edit has passed.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** True when the path names something that exists, file or directory. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }

  model(p: string): FileModel | null {
    const t = this.get(p);
    return t === null ? null : parseFile(t);
  }

  setModel(p: string, m: FileModel): void {
    this.now.set(p, serializeFile(m));
  }

  /** Remember a successful move, composing chains (A->B then B->C is A->C). */
  recordMove(from: string, to: string): void {
    const idx = this.moves.findIndex((m) => m.to === from);
    let origin = from;
    if (idx >= 0) {
      origin = this.moves[idx].from;
      this.moves.splice(idx, 1);
    }
    if (origin === to) return;
    this.moves.push({ from: origin, to });
  }

  checkpoint(): { now: Map<string, string | null>; moves: { from: string; to: string }[] } {
    return { now: new Map(this.now), moves: this.moves.map((m) => ({ from: m.from, to: m.to })) };
  }

  restore(cp: { now: Map<string, string | null>; moves: { from: string; to: string }[] }): void {
    this.now.clear();
    for (const [k, v] of cp.now) this.now.set(k, v);
    this.moves = cp.moves.map((m) => ({ from: m.from, to: m.to }));
  }
}

type Edit = (tree: Tree) => void;

/** The rows printed on success: A/D/M per changed file, R for a successful move. */
function computeRows(tree: Tree): string[] {
  const rMoves: { from: string; to: string }[] = [];
  for (const m of tree.moves) {
    if (tree.original(m.from) !== null && tree.original(m.to) === null && tree.get(m.from) === null && tree.get(m.to) !== null) {
      rMoves.push(m);
    }
  }
  const rFroms = new Set(rMoves.map((m) => m.from));
  const rTos = new Set(rMoves.map((m) => m.to));
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rFroms.has(p) || rTos.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of rMoves) rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.line);
}

// ---- format detection (SPEC section 4) ----

function detect(lines: string[]): 'unified' | 'search-replace' | 'v4a' | 'json' | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- JSON edits (SPEC section 9) ----

/** A wrong command, or a missing or mistyped key, is a parse fault. */
function validateJson(v: unknown, parseLine: number): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Exit2(`error: parse ${parseLine}`);
  const o = v as Record<string, unknown>;
  if (o.command === 'create') {
    if (typeof o.path !== 'string' || typeof o.file_text !== 'string') throw new Exit2(`error: parse ${parseLine}`);
    return;
  }
  if (o.command === 'str_replace') {
    if (typeof o.path !== 'string' || typeof o.old_str !== 'string' || o.old_str === '' || (o.new_str !== undefined && typeof o.new_str !== 'string')) {
      throw new Exit2(`error: parse ${parseLine}`);
    }
    return;
  }
  if (o.command === 'insert') {
    if (typeof o.path !== 'string' || typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') {
      throw new Exit2(`error: parse ${parseLine}`);
    }
    return;
  }
  throw new Exit2(`error: parse ${parseLine}`);
}

function jsonEdit(v: unknown, tree: Tree): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
  const o = v as Record<string, unknown>;
  if (o.command === 'create') {
    if (typeof o.path !== 'string' || typeof o.file_text !== 'string') return;
    if (!safe(o.path)) throw new Fail('unsafe', o.path);
    if (tree.exists(o.path)) throw new Fail('exists', o.path);
    tree.now.set(o.path, o.file_text);
    return;
  }
  if (o.command === 'str_replace') {
    if (typeof o.path !== 'string' || typeof o.old_str !== 'string' || o.old_str === '' || (o.new_str !== undefined && typeof o.new_str !== 'string')) return;
    if (!safe(o.path)) throw new Fail('unsafe', o.path);
    const t = tree.get(o.path);
    if (t === null) throw new Fail('missing', o.path);
    const isCrlf = t.includes('\r\n');
    const text = isCrlf ? t.split('\r\n').join('\n') : t;
    const n = (o.new_str ?? '') as string;
    let count = 0;
    for (let k = 0; ; ) {
      const idx = text.indexOf(o.old_str, k);
      if (idx < 0) break;
      count++;
      k = idx + 1;
    }
    if (count === 0) throw new Fail('no-match', o.path);
    if (count > 1) throw new Fail('ambiguous', o.path);
    const done = text.replace(o.old_str, n);
    tree.now.set(o.path, isCrlf ? done.split('\n').join('\r\n') : done);
    return;
  }
  if (o.command === 'insert') {
    if (typeof o.path !== 'string' || typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') return;
    if (!safe(o.path)) throw new Fail('unsafe', o.path);
    const t = tree.get(o.path);
    if (t === null) throw new Fail('missing', o.path);
    const nl = t.indexOf('\n');
    const br = nl > 0 && t[nl - 1] === '\r' ? '\r\n' : '\n';
    const lines = t === '' ? [] : t.split(br);
    const finalBreak = t !== '' && t.endsWith(br);
    if (finalBreak) lines.pop();
    if (o.insert_line < 0 || o.insert_line > lines.length) throw new Fail('no-match', o.path);
    lines.splice(o.insert_line, 0, ...patchLines(o.new_str));
    tree.now.set(o.path, lines.length === 0 ? '' : lines.join(br) + (finalBreak ? br : ''));
    return;
  }
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const out: Edit[] = [];
    for (const e of v) {
      validateJson(e, first + 1);
      out.push((tree) => jsonEdit(e, tree));
    }
    return out;
  }
  const out: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i])) continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    validateJson(v, i + 1);
    out.push((tree) => jsonEdit(v, tree));
  }
  return out;
}

// ---- unified diffs (SPEC section 6) ----

interface UHunk {
  a: number; // the hunk's old start line (1-based)
  oLines: string[];
  nLines: NLine[];
  noNl: boolean; // a \ line follows the hunk's last context or + line
  lastPlusBs: boolean; // a \ line follows the hunk's last + line
  plusCount: number;
}

interface USection {
  oldPath: string | null; // null = /dev/null, no file
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** One leading a/ or b/ removed from a header path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after a --- or +++ header line: text after 4 chars, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string | null {
  const cut = line.slice(4).split('\t', 1)[0];
  const p = trimEdges(cut);
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function parseDiffGit(line: string, lineNo: number): { a: string; b: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const a = rest.slice(2, sep);
  const b = trimEdges(rest.slice(sep + 3));
  if (a === '' || b === '') throw new Exit2(`error: parse ${lineNo}`);
  return { a, b };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

/** A hunk body: its old and new lines, plus the two no-newline flags. */
function parseHunkBody(body: string[]): Omit<UHunk, 'a'> {
  let lastCtxNew = -1;
  let lastPlus = -1;
  let plusCount = 0;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.startsWith(' ') || l.startsWith('+') || l === '') lastCtxNew = i;
    if (l.startsWith('+')) {
      lastPlus = i;
      plusCount++;
    }
  }
  const noNl = lastCtxNew >= 0 && lastCtxNew + 1 < body.length && body[lastCtxNew + 1].startsWith('\\');
  const lastPlusBs = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1].startsWith('\\');
  const { oLines, nLines } = splitBody(body);
  return { oLines, nLines, noNl, lastPlusBs, plusCount };
}

/**
 * Parse one unified section's header lines and hunks, starting at `start`.
 * Returns the index of the next section's first line (or the patch end).
 */
function parseSectionBody(lines: string[], start: number, sec: USection): number {
  let i = start;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, i + 1);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push({ a, ...parseHunkBody(body) });
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.hunks.length === 0) {
          pairOld = headerPath(l);
          pairNew = headerPath(lines[i + 1]);
          i += 2;
          continue;
        }
        break; // the next section starts here
      }
      if (sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) renameFrom = trimEdges(l.slice('rename from '.length));
      else if (l.startsWith('rename to ')) renameTo = trimEdges(l.slice('rename to '.length));
      else if (l.startsWith('new file mode')) sec.isCreate = true;
      else if (l.startsWith('deleted file mode')) sec.isDelete = true;
      // index, old mode, new mode, similarity, dissimilarity, Index: and the
      // rest of the header are ignored
      i++;
      continue;
    }
    // after the hunks, prose and anything else are ignored
    i++;
  }
  const oldPath = pairOld !== undefined ? pairOld : renameFrom !== null ? renameFrom : sec.oldPath;
  const newPath = pairNew !== undefined ? pairNew : renameTo !== null ? renameTo : sec.newPath;
  sec.oldPath = oldPath;
  sec.newPath = newPath;
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l, i + 1);
      const sec: USection = { oldPath: dg.a, newPath: dg.b, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i = parseSectionBody(lines, i + 1, sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i = parseSectionBody(lines, i, sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks to a file model, in order. */
function applyUnifiedHunks(model: FileModel, hunks: UHunk[], strict: boolean, path: string): FileModel {
  const lines = [...model.lines];
  let eol = model.eol;
  let d = 0;
  for (const h of hunks) {
    if (h.oLines.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = at === lines.length;
      const ins = h.nLines.map((nl) => nl.text);
      lines.splice(at, 0, ...ins);
      if (atEnd) eol = !h.noNl;
      d += h.nLines.length;
      continue;
    }
    const found = findTier(lines, h.oLines, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0];
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + h.oLines.length === lines.length;
    const rep = buildNew(lines, best, h.nLines, found.tier, h.oLines);
    lines.splice(best, h.oLines.length, ...rep);
    if (atEnd) eol = !h.noNl;
    d += h.nLines.length - h.oLines.length;
  }
  return { lines, br: model.br, eol };
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    if (sec.oldPath !== null && !safe(sec.oldPath)) throw new Fail('unsafe', sec.oldPath);
    if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null || sec.isCreate) {
      // creation: the file is the + lines of every hunk, in order
      if (newP === null) return;
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const lines: string[] = [];
      let lastPlusBs = false;
      let anyPlus = false;
      for (const h of sec.hunks) {
        if (h.plusCount > 0) {
          lastPlusBs = h.lastPlusBs;
          anyPlus = true;
        }
        for (const nl of h.nLines) {
          if (!nl.ctx) lines.push(nl.text);
        }
      }
      tree.now.set(newP, lines.length === 0 ? '' : lines.join('\n') + (anyPlus && !lastPlusBs ? '\n' : ''));
      return;
    }
    if (newP === null || sec.isDelete) {
      // deletion: the hunks are not read
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      // move: the hunks apply to the old file, the result lands at the new path
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.exists(newP)) throw new Fail('exists', newP);
      const model = tree.model(oldP)!;
      const result = applyUnifiedHunks(model, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, serializeFile(result));
      tree.recordMove(oldP, newP);
      return;
    }
    // a change to the file in place
    const model = tree.model(oldP);
    if (model === null) throw new Fail('missing', oldP);
    tree.setModel(oldP, applyUnifiedHunks(model, sec.hunks, strict, oldP));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = trimEdges(lines[j]);
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    // the block's old lines, up to ======= then >>>>>>> REPLACE
    let j = i + 1;
    const oldLines: string[] = [];
    let foundSep = false;
    while (j < lines.length) {
      const t = lines[j].trimEnd();
      if (t === '=======') {
        foundSep = true;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      oldLines.push(lines[j]);
      j++;
    }
    if (!foundSep) throw new Exit2(`error: parse ${searchLine}`);
    j++;
    const newLines: string[] = [];
    let foundEnd = false;
    while (j < lines.length) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        foundEnd = true;
        break;
      }
      newLines.push(lines[j]);
      j++;
    }
    if (!foundEnd) throw new Exit2(`error: parse ${searchLine}`);
    const p = path;
    const o = oldLines;
    const nw = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, nw.length === 0 ? '' : nw.join('\n') + '\n');
        return;
      }
      const model = tree.model(p);
      if (model === null) throw new Fail('missing', p);
      const found = findTier(model.lines, o, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0];
      const nLines: NLine[] = nw.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildNew(model.lines, at, nLines, found.tier, o);
      const fileLines = [...model.lines];
      fileLines.splice(at, o.length, ...rep);
      tree.setModel(p, { lines: fileLines, br: model.br, eol: model.eol });
    });
    prevPath = path;
    prevEnd = j;
    i = j + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string; // '' = no anchor
  body: string[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = trimEdges(l.slice('*** Add File: '.length));
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const x = lines[i];
        if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          i++;
          continue;
        }
        if (x === '') {
          fileLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.exists(path)) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = trimEdges(l.slice('*** Delete File: '.length));
      i++;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = trimEdges(l.slice('*** Update File: '.length));
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        moveTo = trimEdges(lines[i].slice('*** Move to: '.length));
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      while (i < last) {
        const x = lines[i];
        if (x.startsWith('*** Add File: ') || x.startsWith('*** Delete File: ') || x.startsWith('*** Update File: ')) break;
        if (x.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          seenChunk = true;
          i++;
          continue;
        }
        if (x.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            seenChunk = true;
          }
          cur = { anchor: x.slice(2).trim(), body: [], eof: false };
          i++;
          continue;
        }
        if (x.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || x === '') {
          if (cur === null) {
            if (seenChunk) {
              // after the first chunk a body line has no chunk to belong to;
              // a blank one is a blank line at the end of the section, the
              // rest are not body lines here at all
              if (blank(x)) {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: '', body: [], eof: false };
          }
          cur.body.push(x);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const wasOpen = cur !== null;
      if (cur !== null) chunks.push(cur);
      if (wasOpen && chunks.length > 0) {
        // blank lines at the end of the section are not part of the last chunk
        const lastCh = chunks[chunks.length - 1];
        while (lastCh.body.length > 0 && blank(lastCh.body[lastCh.body.length - 1])) lastCh.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => v4aUpdate(tree, p, mt, chs, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** The first line at or after `from` equal to `anchor` at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i], t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of `oldLines` at or after `from`, at the first tier with one. */
function findTierFrom(
  lines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, oldLines, t).filter((p) => p >= from && (!eof || p + oldLines.length === lines.length));
    if (pos.length > 0) return { tier: t, pos: pos[0] };
  }
  return null;
}

function v4aUpdate(tree: Tree, path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): void {
  if (!safe(path)) throw new Fail('unsafe', path);
  if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
  const model = tree.model(path);
  if (model === null) throw new Fail('missing', path);
  if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
  const lines = [...model.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== '') {
      const a = findAnchor(lines, ch.anchor, cursor, strict);
      if (a === null) throw new Fail('no-match', path);
      cursor = a + 1;
    }
    const { oLines, nLines } = splitBody(ch.body);
    if (oLines.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      const ins = nLines.map((nl) => nl.text);
      lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = findTierFrom(lines, oLines, cursor, strict, ch.eof);
    if (!found) throw new Fail('no-match', path);
    const rep = buildNew(lines, found.pos, nLines, found.tier, oLines);
    lines.splice(found.pos, oLines.length, ...rep);
    cursor = found.pos + rep.length;
  }
  const result: FileModel = { lines, br: model.br, eol: model.eol };
  if (moveTo !== null) {
    tree.now.set(path, null);
    tree.now.set(moveTo, serializeFile(result));
    tree.recordMove(path, moveTo);
  } else {
    tree.setModel(path, result);
  }
}

// ---- main ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const pos: string[] = [];
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.checkpoint();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = computeRows(tree);
  if (!check) {
    // deletions first, so a file created under a deleted path has room
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
