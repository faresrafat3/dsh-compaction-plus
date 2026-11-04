/**
 * @fares/dsh-compaction-plus — DSH compaction plugin implementing the
 * four-stage research architecture on top of BasicCompactionEngine:
 *   1. free tool-result/thinking pruning  (prune.ts)
 *   2. threshold-triggered structured summarization (via the base engine)
 *   3. local spill store with RAPTOR-lite retrieval (spill.ts)
 *   4. image offload by reference (image.ts)
 *
 * The engine class registers Cordis service "compaction"; see README.md and
 * docs/ARCHITECTURE.md for installation and configuration.
 */
export { CompactionPlusEngine, CompactionPlusEngine as default } from "./engine.js";
export type { CompactionPlusConfig, ModelCompactPolicyConfig, SummarizationInput, SummaryResult } from "./engine.js";
export { DEFAULT_SPILL_MAX_BYTES } from "./engine.js";

export * from "./prune.js";
export * from "./spill.js";
export * from "./image.js";
export { buildPruneOnlySummary, FALLBACK_PROVIDER, FALLBACK_MODEL } from "./fallback.js";
export type { FallbackSummaryResult } from "./fallback.js";
