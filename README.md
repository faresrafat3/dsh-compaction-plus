# dsh-compaction-plus

Context compaction plugin for Deepseek Harness (dsh). Extends the built-in
basic compaction engine with a four-stage pipeline: free tool-result and
reasoning pruning, structured summarization by the base engine, spill of
the original region to a local JSONL store with keyword retrieval, and
image offload by reference. Any summarizer failure degrades to a
deterministic prune-only fallback instead of losing the region.

*This README was written with AI assistance; verify claims against `src/`.*

## Status

Working 0.1.0: `npm run build`, `npm run typecheck`, and `npm test`
(17 tests, including one Cordis mount smoke test) pass. Browser-based
Playwright coverage is out of scope for this release.

## Layout

- `src/` — TypeScript source (entry: `src/index.ts`)
  - `engine.ts` — `CompactionPlusEngine`; registers service `"compaction"`,
    overrides `summarize()` and delegates the rest to the base engine
  - `prune.ts` — tool-result truncation and reasoning stripping
  - `spill.ts` — `SpillStore`, per-session JSONL spill with search
  - `image.ts` — image offload handles
  - `fallback.ts` — prune-only fallback summary
- `lib/` — build output (gitignored)
- `tests/` — `node --test` suites against `lib/`
- `docs/` — design and reference notes

## Build

Requires Node.js >= 22 (ver `0.2.1-rc.2` peer set; deps pinned in
`package.json`).

```sh
npm ci            # install
npm run typecheck # tsc --noEmit
npm run build     # tsc: src/ -> lib/ (+ lib/types/*.d.ts)
npm test          # rebuilds, then node --test tests/
```

## Configuration

All fields are optional; see [docs/EXAMPLE-PROFILE-PATCH.md](docs/EXAMPLE-PROFILE-PATCH.md)
for copy-paste profile rows. The spill directory defaults to
`~/.dsh/compaction-spill` (override with `spillDir`; a
`DSH_COMPACT_PLUS_SPILL_DIR` environment variable takes precedence over the
built-in default when `spillDir` is unset — so the effective directory
depends on the host environment, not only on config). Spill files are
`0600`, symlink targets are refused, and secret-looking values are redacted
by default (`spillSecrets: false` disables redaction). `spillDir: null`
disables spill entirely; prune markers then state honestly that the text
was not spilled rather than implying a store copy exists.

## Design docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/EXAMPLE-PROFILE-PATCH.md](docs/EXAMPLE-PROFILE-PATCH.md)
- [docs/RESEARCH.md](docs/RESEARCH.md)
- [docs/HARNESS-CONTRACT.md](docs/HARNESS-CONTRACT.md)

## License

MIT. See [LICENSE](LICENSE).
