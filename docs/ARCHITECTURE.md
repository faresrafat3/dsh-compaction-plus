# Architecture

`CompactionPlusEngine` (`src/engine.ts`) is a Cordis plugin that registers
the `"compaction"` service. It extends `BasicCompactionEngine` from
`@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2` and overrides exactly one
method — the protected `summarize()` — so the harness contract (service
registration, `compactIfNeeded` / `compactRegion` / `compactNow`, the
`compaction/start|summary|end|prune` events, `CompactionResult`, threshold
math, automatic step-boundary and overflow listeners, replay-based durable
mutation) is inherited unchanged from the base engine.

The base defaults are `thresholdRatio: 0.8`, `retainRatio: 0.16`,
`headroomTokens: 65536`. The plus-only knobs (spill directory and caps,
tool-result truncation budget, reasoning stripping, image offload, fallback
retention) are destructured in the subclass constructor so the base
constructor's key validation never sees them.

## Four stages

Every call to `summarize()` runs:

1. **Free pruning** (`src/prune.ts`). Reasoning blocks are stripped from
   assistant messages (a placeholder is kept if a message becomes empty),
   and stale tool results — all but the newest `keepLastToolResults` —
   are truncated to `toolResultChars` with a marker naming how many
   characters were removed. Message order and identity are preserved, so
   system, pinned, and last-N retention behave exactly as the base defines.
2. **Structured summarization** by delegating to `super.summarize()`, which
   calls the configured summarizer route (`summarizationProvider` /
   `summarizationModel`, or the per-model `modelPolicies` entry, or the
   conversation target).
3. **Spill** (`src/spill.ts`). Before any transform, the region's text is
   appended to a per-session JSONL store (`<spillDir>/<sessionId>.jsonl`,
   sessionId sanitized). `SpillStore.search()` provides a keyword-overlap
   retrieval index over those lines. A per-file byte cap drops the oldest
   lines first. Spill failures are logged and never fail compaction.
4. **Image offload by reference** (`src/image.ts`). Image blocks in the
   summarizer input become short text handles naming the attachment; the
   original blocks are untouched in the live history.

## Failure handling

Abort is always rethrown. Any other summarizer failure degrades to a
deterministic prune-only summary (`src/fallback.ts`, provider
`plus-local`, model `plus-local-fallback`) containing the newest retained
user messages and a spill pointer, instead of losing the region.

## Notes on what is not claimed

- There is no dynamic "cheapest model by price" selection: the inspected
  LLM metadata exposes no cost field, so cheap summarization is achieved
  only by pinning `summarizationProvider` / `summarizationModel`.
- The fallback summary is a safety net, not a summarizer; results that
  needed the fallback should be treated as lower quality.

## Open decisions

- Retrieval (`SpillStore.search`) is currently exposed on the engine but
  not yet consumed by any caller; wiring it into fallback summaries or a
  recall tool is future work.
- Whether truncation should prefer preserving tool-result heads only, or
  keep a tail too, is left as-is (head + tail with marker).
