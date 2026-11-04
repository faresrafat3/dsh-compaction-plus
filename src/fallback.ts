/**
 * Deterministic prune-only fallback for the case the LLM summarizer fails.
 *
 * BasicCompactionEngine already guarantees the session never dies to a
 * summarizer error (it falls back to a local summary built only from the
 * request's message ids); this builder is what THIS engine returns instead of
 * calling `super.summarize` when that call throws for a non-abort reason.
 * It keeps the most useful raw material inside the region headroom: the
 * newest user requests, a spill-store pointer, and nothing else. Because the
 * host's `summarizeCompaction` frames every returned summary block inside a
 * session event, each block here is plain text only, ready to be framed.
 *
 * The provider/model pair is the literal fallback identity `"plus-local" /
 * "plus-local-fallback"`, never a configured route: this code never claims a
 * summary came from a model that did not produce it.
 */

import type { Message, TextBlock } from "@deepseek-ai/dsh-llm";

import { lastUserTexts } from "./prune.js";

/** Structural mirror of BasicCompactionEngine's `SummaryResult` (the package root does not re-export it). */
export interface FallbackSummaryResult {
  summary: TextBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  rawOutput?: TextBlock[];
}

export const FALLBACK_PROVIDER = "plus-local";
export const FALLBACK_MODEL = "plus-local-fallback";

/**
 * Build the prune-only summary. `agentId` is the spill-store file name for the
 * session, so the summary can point the next turn at the exact spilled text.
 */
export function buildPruneOnlySummary(input: {
  readonly messages: readonly Message[];
  readonly agentId: string;
  readonly keepLastUserMessages: number;
  readonly maxTokens: number;
}): FallbackSummaryResult {
  const userTexts = lastUserTexts(input.messages, Math.max(0, input.keepLastUserMessages), 2000);
  const text = [
    "Conversation compacted locally (summarizer unavailable; prune-only fallback).",
    `Spilled region text is in the local store under session ${input.agentId}.`,
    ...(userTexts.length > 0
      ? ["Recent user requests:", ...userTexts.map((t) => `- ${t}`)]
      : ["(no user text in the compacted region)"]),
  ].join("\n");
  const block: TextBlock[] = [{ type: "text", text }];
  return {
    summary: [...block],
    provider: FALLBACK_PROVIDER,
    model: FALLBACK_MODEL,
    maxTokens: input.maxTokens,
    // Deterministic blocks double as the raw output: byte-identical re-runs.
    rawOutput: [...block],
  };
}
