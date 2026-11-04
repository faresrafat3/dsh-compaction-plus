/**
 * Stage 1 of the compaction-plus architecture: free, lossy input pruning that
 * runs inside `CompactionPlusEngine.summarize()` before the LLM summarizer
 * sees the compacting region.
 *
 * Two transforms, both pure over `readonly Message[]`:
 *  - reasoning blocks are dropped (they were already consumed to produce the
 *    visible assistant text, and the summarizer cannot spend tokens on them);
 *    an assistant message left with no blocks keeps a placeholder so no
 *    adapter ever receives an empty content array.
 *  - tool-result text older than the newest `keepLastToolResults` tool
 *    messages is truncated to a head/middle/tail window. Messages are never
 *    removed and `tool-call` blocks are never touched, so tool call/result
 *    pairing stays balanced by construction.
 *
 * The engine spills the original texts to the local store (stage 3) before
 * these transforms run and passes the resulting SpillStatus in, so truncation
 * markers only claim a spill when one actually happened.
 */

import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";

/** Where the full text of truncated messages actually lives after pruning. */
export type SpillStatus = "spilled" | "not-spilled" | "failed";

export interface PruneOptions {
  /** Newest tool results kept verbatim; all older ones are truncated. */
  keepLastToolResults: number;
  /** Character budget for one truncated tool-result text block. */
  toolResultChars: number;
  /** Whether reasoning blocks are dropped from the summarizer input. */
  stripReasoning: boolean;
  /**
   * Honest spill provenance for truncation markers. Defaults to
   * "not-spilled" (marker never claims a copy exists when it doesn't).
   */
  spillStatus?: SpillStatus;
}

export const DEFAULT_PRUNE_OPTIONS: Readonly<PruneOptions> = Object.freeze({
  keepLastToolResults: 2,
  toolResultChars: 1200,
  stripReasoning: true,
});

function makeMarker(removed: number, spillStatus: SpillStatus): string {
  const tail =
    spillStatus === "spilled"
      ? "full text spilled to the local store"
      : spillStatus === "failed"
        ? "spill failed; full text not retained"
        : "not spilled; full text not retained";
  return `\n[…tool result truncated by compaction-plus: ${removed} chars removed; ${tail}…]\n`;
}

const TRUNCATION_MARKER = (removed: number): string => makeMarker(removed, "not-spilled");

/**
 * Truncate one long text value to a head/middle/tail window inside
 * `budget` chars. Values already inside the budget are returned unchanged.
 * The marker claims a spill only when `spillStatus` is "spilled".
 */
export function truncateText(text: string, budget: number, spillStatus: SpillStatus = "not-spilled"): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.6);
  const tail = Math.max(0, budget - head);
  return text.slice(0, head) + makeMarker(text.length - head - tail, spillStatus) + text.slice(text.length - tail);
}

/** Index of the first tool message inside the verbatim tail, or the message count when none. */
function verbatimToolStart(messages: readonly Message[], keepLast: number): number {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "tool") {
      seen += 1;
      if (seen > keepLast) return index + 1;
    }
  }
  return 0;
}

/**
 * Rewrite one tool message so each long text block is truncated. Returns the
 * same object reference when nothing needed changing.
 */
function pruneToolMessage(message: Message, budget: number, spillStatus: SpillStatus = "not-spilled"): Message {
  const blocks = message.content.map((block) =>
    block.type === "text" ? { ...block, text: truncateText(block.text, budget, spillStatus) } : block,
  );
  const changed = blocks.some((block, index) => block !== message.content[index]);
  return changed ? { ...message, content: blocks } : message;
}

/**
 * Apply stage-1 transforms to the messages handed to the summarizer.
 * Order and identity of messages are preserved; only content blocks change.
 */
export function pruneForSummarization(
  messages: readonly Message[],
  options: PruneOptions = DEFAULT_PRUNE_OPTIONS,
): Message[] {
  const tailStart = verbatimToolStart(messages, Math.max(0, options.keepLastToolResults));
  return messages.map((message, index) => {
    let current: Message = message;
    if (options.stripReasoning && current.role === "assistant") {
      const blocks = current.content.filter((block) => block.type !== "reasoning");
      current =
        blocks.length === 0
          ? { ...current, content: [{ type: "text", text: "(reasoning omitted by compaction-plus)" }] }
          : blocks.length !== current.content.length
            ? { ...current, content: blocks }
            : current;
    }
    if (current.role === "tool" && index < tailStart) {
      current = pruneToolMessage(current, options.toolResultChars, options.spillStatus ?? "not-spilled");
    }
    return current;
  });
}

/**
 * Extract the plain text of a message for the spill store: text blocks joined
 * in order. Images and tool calls are not spilled as text (images offload by
 * durable reference in stage 4; tool calls are part of the durable log).
 */
export function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Collect spill-worthy texts from every non-system message, in order. */
export function collectSpillTexts(messages: readonly Message[]): Array<{ role: string; text: string }> {
  const texts: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = messageText(message);
    if (text.length > 0) texts.push({ role: message.role, text });
  }
  return texts;
}

/**
 * The plain texts of the newest `count` user messages, newest last, each
 * capped at `maxChars`. Used by the prune-only fallback summary.
 */
export function lastUserTexts(messages: readonly Message[], count: number, maxChars: number): string[] {
  const texts: string[] = [];
  for (let index = messages.length - 1; index >= 0 && texts.length < count; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = messageText(message);
    if (text.length === 0) continue;
    texts.unshift(text.slice(0, maxChars));
  }
  return texts;
}
