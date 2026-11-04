import assert from "node:assert/strict";
import { test } from "node:test";

import { imageHandleText, offloadImagesInContent } from "../lib/image.js";

const image = {
  type: "image",
  attachment: {
    attachmentId: "att-42",
    name: "chart.png",
    mediaType: "image/png",
    bytes: 512000,
    width: 1600,
    height: 900,
  },
};

test("imageHandleText names the durable reference", () => {
  const handle = imageHandleText(image);
  assert.match(handle, /offloaded to local store/);
  assert.match(handle, /chart\.png/);
  assert.match(handle, /image\/png/);
  assert.match(handle, /512000/);
  assert.match(handle, /1600x900/);
  assert.match(handle, /att-42/);
});

test("content without images returns the same array reference", () => {
  const blocks = [{ type: "text", text: "plain" }];
  assert.equal(offloadImagesInContent(blocks), blocks);
});

test("mixed content keeps order and non-image blocks", () => {
  const before = { type: "text", text: "look at this" };
  const blocks = offloadImagesInContent([before, image, { type: "reasoning", text: "hmm" }]);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], before);
  assert.equal(blocks[1].type, "text");
  assert.match(blocks[1].text, /offloaded to local store/);
  assert.equal(blocks[2].type, "reasoning");
});
