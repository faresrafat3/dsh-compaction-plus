/**
 * Stage 4 of the compaction-plus architecture: image offload by reference.
 *
 * Large image blocks are the most expensive content a summarizer can be shown.
 * For the summarization input only, each `image` block is replaced with a
 * short deterministic text handle that names the image and its durable
 * attachment reference. The durable session log is never rewritten here; the
 * host's `dsh-compaction-image-offload` service owns the durable event for
 * live traffic, and this transform only shrinks what the summarizer sees.
 *
 * The handle stays inside the same content array (as a `text` block) so the
 * message keeps its role and order and no adapter ever sees an empty array.
 */

import type { ContentBlock, ImageBlock } from "@deepseek-ai/dsh-llm";

/** One-line handle for a spilled image: name, type, size, dimensions, and the durable attachment id. */
export function imageHandleText(block: ImageBlock): string {
  const { attachment } = block;
  const name = attachment.name ?? attachment.attachmentId;
  return `[image offloaded to local store: ${name} (${attachment.mediaType}, ${attachment.bytes} bytes, ` +
    `${attachment.width}x${attachment.height}, attachment ${attachment.attachmentId})]`;
}

/**
 * Replace every image block in one content array with its handle text.
 * Returns the original array reference when it contains no image blocks, so
 * callers can distinguish "unchanged" cheaply.
 */
export function offloadImagesInContent(blocks: readonly ContentBlock[]): ContentBlock[] {
  if (!blocks.some((block) => block.type === "image")) return blocks as ContentBlock[];
  return blocks.map((block) =>
    block.type === "image" ? { type: "text", text: imageHandleText(block) } as ContentBlock : block,
  );
}
