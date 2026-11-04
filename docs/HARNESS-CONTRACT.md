# Custom compaction backend: harness contract

DSH install root: `/home/fares/.nvm/versions/node/v26.12.0/lib/node_modules/@deepseek-ai/dsh/` (ver `0.2.1-rc.2`).
Below, `NM` means `<DSH root>/node_modules/@deepseek-ai/`.

## 1. Registration and DI

- `CompactionEngine extends Service` registers itself as service name `"compaction"` (`NM/dsh-compaction/lib/index.js:170-173`, `super(ctx, "compaction")`). One instance per context; that is `ctx.compaction`.
- Module augmentation `Context { compaction: CompactionEngine }` (`NM/dsh-compaction/lib/types/index.d.ts:69`) and `MessageSourceMap { 'compact-checkpoint': CompactionCheckpointSource }` (`:21`).
- `BasicCompactionEngine` declares `static inject = ["llm", "tokenMeter", "sessions"]` (`NM/dsh-compaction-basic/lib/index.js:801-805`). Constructor `(ctx, config = {})`, calls `super(ctx)` (inherits the `"compaction"` name), resolves config, and if `auto` registers automatic compaction (`:820-828`).
- Cordis loads the package `main` (`lib/index.js`, `package.json:14`; no `cordis` export field, `NM/dsh-compaction-basic/package.json:14-24`). Export tail: `export { BasicCompactionEngine, BasicCompactionEngine as default }` (`lib/index.js:1027`).
- Session events in `NM/dsh-compaction/lib/types/types.d.ts`: `compaction/start` (`:21`), `compaction/summary` (`:35`), `compaction/end` (`:73`), `compaction/prune` (`:88`). Same file defines `CompactionResult { compactionId, sourceCommandId?, startSeq, summarySeq, endSeq, summary, shadowedRange, shadowedSeqs, shadowedTokenCount }` (`:102-130`).
- `/compact` command is backend-independent: `apply(ctx)` registers the command and calls `ctx.compaction.compactNow(agent, signal, commandId)` (`NM/dsh-command-compact/lib/index.js:55`, `apply` at `:78`), with `inject = ["commands", "compaction"]` (`:9`).

## 2. Backend interface a replacement must satisfy

`BasicCompactionEngine extends CompactionEngine` (`NM/dsh-compaction-basic/lib/types/index.d.ts`). Required surface:

| Method | Signature | Notes |
|---|---|---|
| `compactIfNeeded` | `(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) => Promise<CompactionResult \| null>` | Auto path. Called on `agent/pre-step` with `"pressure"` and on `agent/request-error` overflow with `"context-overflow"`. `CompactionTrigger = 'pressure' \| 'context-overflow'` (`NM/dsh-compaction/lib/types/index.d.ts:23`). |
| `compactRegion` | `(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal) => Promise<CompactionResult>` | Inclusive positional range on the surface. |
| `compactNow` | `(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId) => Promise<CompactionResult \| null>` | Manual `/compact` path; throws `ManualCompactionError` (`code: 'busy'\|'cancelled'\|'changed'\|'summary'\|'commit'\|'persistence'`, same file `:31`) on expected failures. |
| `summarize` | `protected (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>` | Sole subclass hook (doc comment in basic types). Frame output with `frameSummary`; build input with `buildSummarizationInput`. |

Token meter seam: `Context { tokenMeter: TokenMeter }`, core `measure(session, requestHeader?): TokenMeasurement` (`NM/dsh-token-meter/lib/types/index.d.ts:46`), `estimateMessage(message): number` (`:57`).

## 3. Defaults (`NM/dsh-compaction-basic/lib/index.js`)

- `DEFAULT_THRESHOLD_RATIO = .8` (`:15`), `DEFAULT_RETAIN_RATIO = .16` (`:17`).
- `headroomTokens = config.headroomTokens ?? 65536` (`:63`); `maxTokens = config.maxTokens ?? headroomTokens` (`:64`); `thresholdRatio = config.thresholdRatio ?? .8` (`:66`).
- `compactionRetries = ?? 1` (`:82`), `maxOverflowRetries = ?? 1` (`:83`), `auto = ?? true` (`:85`).
- Spec math (`:124-145`): `messageBudgetTokens = contextWindow - reservedCompletionTokens`; `pressureBudgetTokens = messageBudgetTokens - headroomTokens`; `thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudgetTokens))`; `retainTokens = retainTokens ?? floor(messageBudgetTokens * retainRatio)`; rejects when `retainTokens >= thresholdTokens` (`TargetPressureConfigError`, `:156`).
- Summarizer: one-shot `ctx.llm.stream()` with `COMPACTION_INSTRUCTION`, `maxTokens: config.maxTokens`, `purpose: "compaction"`; target order: config `summarizationProvider`/`summarizationModel` → latest durable routed request → `agent.options.provider/model`. Errors: max-tokens truncation maps to `code = "MAX_TOKENS"`; image output rejected (`summaryText`).

## 4. `reservedCompletionTokens` interaction

`reservedCompletionTokens(agent, defaultMaxTokens)` (`NM/dsh-compaction-basic/lib/index.js:757-759`):

```js
return agent.session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0;
```

The request envelope's own `maxTokens` wins. Fallback is the adapter's per-request `defaultMaxTokens` (`NM/dsh-llm/lib/types/types.d.ts:398`: "Adapter-configured per-request output cap materialized when callers omit one"), which the adapter materializes into the envelope. No declared cap means no reservation (`0`). `contextWindow` comes from the model declaration (`NM/dsh-llm/lib/types/types.d.ts:314,336`); session header type at `NM/dsh-session/lib/types/types.d.ts:218`.

## 5. How this plugin is mounted (not a host-plane swap)

The host-plane `compaction-basic` row in `NM/dsh-base/cordis.patch.yml:351-352` is disabled by `dsh-web-app` (`NM/dsh-web-app/cordis.patch.yml:532-545`); agents run the preset-declared `compaction-basic` rows instead. Swapping or patching the host-plane row therefore does not affect the compaction instance agents actually use. A one-line row targeting that host-plane `id` is stale and is rejected with a "name mismatch" error.

The real mount is the bundle shipped by this package:

- `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`;
- that bundle patch carries four wholesale preset overrides — `preset-standard`, `preset-ptc`, `preset-minimal`, and `preset-cordis` — each pointing its preset `compaction-basic` entry at `@fares/dsh-compaction-plus`;
- installation is via a link dependency plus a `bundles` profile entry, not by editing host compositions or the profile's host-plane rows.

For the profile-side example rows, see [docs/EXAMPLE-PROFILE-PATCH.md](EXAMPLE-PROFILE-PATCH.md). For the shipped preset overrides themselves, see the bundle [cordis.patch.yml](../cordis.patch.yml).

Token meter stays on the host plane: the web preset disables only `compaction-basic`, `command-compact`, `tool-result-pruner` (`NM/dsh-web-app/cordis.patch.yml:532-545`), and the comment there says the meter stays host-side by design.

## 6. Extension without replacing

- Subclass `BasicCompactionEngine` and override only `summarize()` ("the sole subclass customization hook"; the replay and durable mutation strategy stays fixed). Plugin entry convention: default-export the class from `main`, set `static inject` to include what you need beyond `["llm", "tokenMeter", "sessions"]`, and call `super(ctx, config)`.
- Overlay services that join the same seam instead of replacing it (all load alongside basic):
  - `dsh-compaction-tool-result-pruner`: `Context { toolResultPruner: ToolResultPruner }`, deterministic head/middle/tail pruning (`NM/dsh-compaction-tool-result-pruner/lib/types/index.d.ts`). Base config: `thresholdChars: 8192, headChars: 4096, tailChars: 1024` (`NM/dsh-base/cordis.patch.yml:425-430`).
  - `dsh-compaction-image-offload`: `name = "compaction-image-offload"`, `apply(ctx)` only, no config (`NM/dsh-compaction-image-offload/lib/types/index.d.ts`); retries on `IMAGE_OFFLOAD_REQUIRED` / the summary-error waterfall.
  - `session-checkpoint-policy`: `apply(ctx)` installs semantic durability checkpoints (`NM/dsh-session-checkpoint-policy/lib/types/index.d.ts:8-10`).
  - `spill-policy`: `Config { maxInlineTokens? }` (`NM/dsh-spill-policy/lib/types/index.d.ts:17-19`).

## 7. Open points not settled from files read

- Loader package-specifier resolution rules for a local path (anchoring beside the patch file is confirmed by the composition reference; exact resolver behavior not read).
- `EventOrder` declaration site (not found under `dsh-agent*`/`dsh-session` types; the events basic subscribes to are `agent/pre-step`, `agent/status`, `session/event`, `agent/request-error`).
