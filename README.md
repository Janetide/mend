# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Janetide/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Janetide/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

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
