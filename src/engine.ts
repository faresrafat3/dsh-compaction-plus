/**
 * CompactionPlusEngine — the service registered as Cordis service
 * "compaction", built directly on BasicCompactionEngine.
 *
 * BasicCompactionEngine already owns the full harness contract: the
 * "compaction" service registration, `compactIfNeeded` / `compactRegion` /
 * `compactNow`, the `compaction/start|summary|end|prune` events, `CompactionResult`,
 * the threshold math (threshold = min(window * thresholdRatio,
 * window - reservedCompletionTokens - headroomTokens), rejected when
 * retainTokens >= thresholdTokens), the automatic step-boundary and overflow
 * listeners, and the replay-based durable mutation. This engine overrides
 * exactly one hook — the protected `summarize()` — to run the four research
 * stages on the summarization input before the LLM call:
 *
 *   1. free tool-result/reasoning pruning        (prune.ts)
 *   2. structured summarization by the base        (super.summarize)
 *   3. spill of the original region to a local store (spill.ts)
 *   4. image offload by reference                  (image.ts)
 *
 * The summarizer route is whatever the caller configured
 * (`summarizationProvider`/`summarizationModel`, or the conversation target);
 * no per-price "cheapest model" lookup exists because the LLM metadata API
 * exposes no cost field. Any non-abort summarizer failure returns a
 * deterministic prune-only summary instead of losing the region.
 */

import type { Context } from "@deepseek-ai/cordis";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { CompactionResult, CompactionTrigger } from "@deepseek-ai/dsh-compaction";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, Message, TokenUsage, ToolSchema } from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-token-meter";
import z from "@deepseek-ai/schemastery";

import { buildPruneOnlySummary } from "./fallback.js";
import { evaluatePressureGuard } from "./pressure.js";
import { offloadImagesInContent } from "./image.js";
import {
  collectSpillTexts,
  pruneForSummarization,
  type SpillStatus,
} from "./prune.js";
import { SpillStore, defaultSpillDir } from "./spill.js";

/** Structural mirror of the summarizer input type (the package root does not re-export it). */
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[];
  readonly messages: readonly Message[];
}

/** Structural mirror of the summarization result type (the package root does not re-export it). */
export type SummaryResult =
  | {
      readonly summary: ContentBlock[];
      readonly provider: string;
      readonly model: string;
      readonly maxTokens?: number;
      readonly usage?: TokenUsage;
      readonly rawOutput: ContentBlock[];
      readonly llmStreamCall: true;
    }
  | {
      readonly summary: ContentBlock[];
      readonly provider: string;
      readonly model: string;
      readonly maxTokens?: number;
      readonly usage?: TokenUsage;
      readonly rawOutput?: ContentBlock[];
      readonly llmStreamCall?: never;
    };

/** Exact provider/model override, mirroring BasicCompactionEngine's modelPolicies. */
export interface ModelCompactPolicyConfig {
  provider: string;
  model: string;
  thresholdRatio?: number;
  headroomTokens?: number;
  retainRatio?: number;
  retainTokens?: number;
  summarizationProvider?: string;
  summarizationModel?: string;
  maxTokens?: number;
  compactionRetries?: number;
  maxOverflowRetries?: number;
}

/**
 * Plugin configuration: every BasicCompactionConfig field, plus the
 * compaction-plus knobs. All fields are optional; the base defaults apply
 * (thresholdRatio 0.8, retainRatio 0.16, headroomTokens 65536, auto true).
 */
export interface CompactionPlusConfig {
  thresholdRatio?: number;
  headroomTokens?: number;
  retainRatio?: number;
  retainTokens?: number;
  summarizationProvider?: string;
  summarizationModel?: string;
  maxTokens?: number;
  compactionRetries?: number;
  maxOverflowRetries?: number;
  modelPolicies?: ModelCompactPolicyConfig[];
  auto?: boolean;
  /** Spill-store directory. Defaults to ~/.dsh/compaction-spill (or env DSH_COMPACT_PLUS_SPILL_DIR). null disables spill. */
  spillDir?: string | null;
  /** Per-session spill byte cap (oldest entries dropped first). Defaults to 4 MiB. */
  spillMaxBytes?: number;
  /** Redact secret-looking values before writing spill files. Defaults to true. */
  spillSecrets?: boolean;
  /** Newest tool results kept verbatim in the summarizer input. Defaults to 2. */
  keepLastToolResults?: number;
  /** Character budget for one truncated stale tool result. Defaults to 1200. */
  toolResultChars?: number;
  /** Strip reasoning blocks from the summarizer input. Defaults to true. */
  stripReasoning?: boolean;
  /** Replace image blocks with offload handles in the summarizer input. Defaults to true. */
  offloadImages?: boolean;
  /** User messages retained in the prune-only fallback summary. Defaults to 3. */
  lastUserMessages?: number;
}

export const DEFAULT_SPILL_MAX_BYTES = 4 * 1024 * 1024;

const thresholdRatioSchema = z.number();
const headroomTokensSchema = z.number().step(1).min(0);
const retainRatioSchema = z.number();
const retainTokensSchema = z.number().step(1).min(0);
const summarizationProviderSchema = z.string();
const summarizationModelSchema = z.string();
const maxTokensSchema = z.number().step(1).min(1);
const compactionRetriesSchema = z.number().step(1).min(0);
const maxOverflowRetriesSchema = z.number().step(1).min(0);

const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
});

export class CompactionPlusEngine extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];

  static Config = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    spillDir: z.union([z.string(), z.const(null)]),
    spillMaxBytes: z.number().step(1).min(1024),
    spillSecrets: z.boolean(),
    keepLastToolResults: z.number().step(1).min(0),
    toolResultChars: z.number().step(1).min(256),
    stripReasoning: z.boolean(),
    offloadImages: z.boolean(),
    lastUserMessages: z.number().step(1).min(0),
  });

  // Public readonly fields (not #private): Cordis service access goes
  // through a Reflect proxy, and private fields fail through that receiver.
  readonly spillStore: SpillStore | null;
  readonly spillSecrets: boolean;
  readonly keepLastToolResults: number;
  readonly toolResultChars: number;
  readonly stripReasoning: boolean;
  readonly offloadImages: boolean;
  readonly lastUserMessages: number;

  constructor(context: Context, config?: CompactionPlusConfig) {
    // Extra keys must be stripped BEFORE super(): the base constructor
    // validates config keys against its own vocabulary and would reject them.
    const {
      spillDir,
      spillMaxBytes,
      spillSecrets,
      keepLastToolResults,
      toolResultChars,
      stripReasoning,
      offloadImages,
      lastUserMessages,
      ...baseConfig
    } = config ?? {};
    super(context, baseConfig);

    this.spillSecrets = spillSecrets ?? true;
    this.spillStore = spillDir === null
      ? null
      : new SpillStore(spillDir ?? defaultSpillDir(), spillMaxBytes ?? DEFAULT_SPILL_MAX_BYTES, this.spillSecrets);
    this.keepLastToolResults = keepLastToolResults ?? 2;
    this.toolResultChars = toolResultChars ?? 1200;
    this.stripReasoning = stripReasoning ?? true;
    this.offloadImages = offloadImages ?? true;
    this.lastUserMessages = lastUserMessages ?? 3;
  }

  /**
   * Pressure guard with a clamped output reservation.
   *
   * Delegates to the base engine for every non-pressure trigger and for any
   * resolution/measurement failure; only skips compaction when the (clamped)
   * threshold says the session is below pressure. The heavy lifting lives in
   * `pressure.ts` so this method stays a thin, readable seam.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (trigger !== "pressure") {
      return super.compactIfNeeded(agent, trigger, signal);
    }
    const decision = await evaluatePressureGuard(
      this.ctx as unknown as import("./pressure.js").PressureGuardContext,
      agent as unknown as import("./pressure.js").PressureGuardAgent,
      this.config as unknown as import("./pressure.js").PressureGuardConfig,
      signal,
    );
    if (decision === "skip") return null;
    return super.compactIfNeeded(agent, trigger, signal);
  }

  /**
   * Run stages 1/3/4 on the replayed region, then delegate to the base LLM
   * summarizer. Abort is always rethrown; every other summarizer failure
   * degrades to the deterministic prune-only summary. Spill failures are
   * logged and never fail compaction.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // Stage 3 first: spill the original region text (a superset of what the
    // summarizer will see) so pristine text survives every later transform.
    // The prune markers below must honestly reflect what actually happened:
    // "spilled" only when a write succeeded, "failed" when it threw, and
    // "not-spilled" when there was nothing to write or spill is disabled.
    let spillStatus: SpillStatus = "not-spilled";
    try {
      const texts = collectSpillTexts(input.messages);
      if (texts.length > 0 && this.spillStore) {
        this.spillStore.append(
          String(agent.id),
          texts.map((entry) => ({ ts: Date.now(), role: entry.role, text: entry.text })),
        );
        spillStatus = "spilled";
      }
    } catch (error) {
      spillStatus = "failed";
      console.warn("[dsh-compaction-plus] spill failed; compaction continues", error);
    }

    // Stages 1 + 4: prune the summarizer input and offload images by
    // reference. Order and identity of messages are preserved, so system,
    // pinned, and last-N retention behavior stays exactly as the base defines.
    const pruned = pruneForSummarization(input.messages, {
      keepLastToolResults: this.keepLastToolResults,
      toolResultChars: this.toolResultChars,
      stripReasoning: this.stripReasoning,
      spillStatus,
    });
    const processed = this.offloadImages
      ? pruned.map((message) => {
          const blocks = offloadImagesInContent(message.content);
          return blocks === message.content ? message : ({ ...message, content: blocks } as Message);
        })
      : pruned;

    try {
      return await super.summarize({ ...input, messages: processed }, agent, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[dsh-compaction-plus] summarizer failed; prune-only fallback", error);
      return buildPruneOnlySummary({
        messages: input.messages,
        agentId: String(agent.id),
        keepLastUserMessages: this.lastUserMessages,
        maxTokens: this.config.maxTokens,
      });
    }
  }
}
