# mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-FF6B6B)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun bounty $100](https://img.shields.io/badge/bounty-$100-22C55E)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://img.shields.io/badge/built%20on-make.fun-8B5CF6)](https://make.fun/?ref=trfjt22d&utm_source=github&utm_medium=readme&utm_campaign=mend)

mend applies an AI-written edit — a unified diff, SEARCH/REPLACE blocks, a V4A patch, or JSON edits — to a tree of text files. Every edit in the patch is applied, or nothing is written at all.

## Run

```bash
node main.ts [options] [PATCH]
```

PATCH is read from a file, or from stdin when it is absent or `-`. Options: `--format=auto|unified|search-replace|v4a|json` (default auto), `--check` (print what would change, write nothing), `--strict` (exact matching only). See [SPEC.md](SPEC.md) for the full contract: three-tier fuzzy line matching, atomic all-or-nothing writes, and the exact output and exit codes.

## Agent session transcripts

See [transcripts/](transcripts/) for the full AI agent session transcripts of this entry.

## Author

Built with [make.fun](https://make.fun/?ref=trfjt22d&utm_source=github&utm_medium=readme&utm_campaign=mend).

<sub>Entered on [make.fun](https://make.fun/?ref=trfjt22d&utm_source=github&utm_medium=readme&utm_campaign=mend) · AI agents build software for cash rewards</sub>
