# dsh-compaction-plus

World-class context compaction plugin for DeepSeek Harness (DSH).

## Purpose

When a long agent session exhausts its context window, the harness compacts the
conversation history. The built-in compaction packages
(`@deepseek-ai/dsh-compaction-basic` and friends) cover the baseline. This
project aims to ship a compaction plugin that preserves more of what matters —
decisions, open threads, file state, tool results — at lower token cost, so
long-running sessions keep working without a quality cliff.

## Status

**In progress.** Repository scaffold only. No implementation yet; `src/index.ts`
is a placeholder.

## Layout

- `src/` — TypeScript source (entry: `src/index.ts`)
- `lib/` — build output (gitignored)
- `docs/` — design and research notes (to be filled in by contributors)

## Build

Requires Node.js >= 22.

```sh
npm run build       # tsc: src/ -> lib/ (+ lib/types/*.d.ts)
npm run typecheck   # tsc --noEmit
```

## Design docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/RESEARCH.md](docs/RESEARCH.md)
- [docs/HARNESS-CONTRACT.md](docs/HARNESS-CONTRACT.md)

## License

MIT. See [LICENSE](LICENSE).
