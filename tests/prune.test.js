import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectSpillTexts,
  lastUserTexts,
  messageText,
  pruneForSummarization,
} from "../lib/prune.js";

const text = (t) => ({ type: "text", text: t });
const user = (id, t) => ({ id, role: "user", content: [text(t)], source: { kind: "user" } });
const model = (id, blocks) => ({ id, role: "assistant", content: blocks, source: { kind: "model" } });
const tool = (id, t) => ({ id, role: "tool", content: [text(t)], source: { kind: "tool" } });
const big = (n) => "x".repeat(n);

test("messageText joins text blocks only", () => {
  const msg = model("m1", [text("a"), { type: "reasoning", text: "hidden" }, text("b")]);
  assert.equal(messageText(msg), "a\nb");
});

test("reasoning blocks are stripped and never leak into the input", () => {
  const messages = [
    model("m1", [text("answer"), { type: "reasoning", text: "secret chain" }]),
    model("m2", [{ type: "reasoning", text: "only thinking" }]),
  ];
  const before = JSON.stringify(messages);
  const pruned = pruneForSummarization(messages, { stripReasoning: true });
  assert.equal(pruned[0].content.length, 1);
  assert.equal(pruned[0].content[0].text, "answer");
  assert.equal(pruned[1].content[0].text, "(reasoning omitted by compaction-plus)");
  assert.equal(JSON.stringify(messages), before);
});

test("stripReasoning false leaves blocks alone", () => {
  const messages = [model("m1", [{ type: "reasoning", text: "keep me" }])];
  const out = pruneForSummarization(messages, { stripReasoning: false });
  assert.equal(out[0].content[0].type, "reasoning");
});

test("stale tool results are truncated with a marker naming the removed chars", () => {
  const messages = [
    tool("t1", big(5000)),
    tool("t2", big(5000)),
    tool("t3", "short"),
  ];
  const out = pruneForSummarization(messages, {
    keepLastToolResults: 1,
    toolResultChars: 1000,
    stripReasoning: false,
  });
  assert.equal(out[2].content[0].text, "short");
  for (const stale of out.slice(0, 2)) {
    assert.match(stale.content[0].text, /tool result truncated by compaction-plus/);
    assert.match(stale.content[0].text, /full text spilled to the local store/);
    assert.ok(stale.content[0].text.length <= 1000 + 200, `head/tail budget, got ${stale.content[0].text.length}`);
  }
  // non-tool messages are untouched in content
  assert.ok(out.every((m) => m.role === "tool"));
});

test("collectSpillTexts skips system-prompt messages and keeps order", () => {
  const messages = [
    { id: "s1", role: "system", content: [text("policy")], source: { kind: "system-prompt" } },
    user("u1", "hello"),
    model("m1", [text("world")]),
  ];
  assert.deepEqual(collectSpillTexts(messages), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "world" },
  ]);
});

test("lastUserTexts returns the newest N capped by chars", () => {
  const messages = [user("u1", "first"), user("u2", "second"), model("m1", [text("mid")]), user("u3", "third")];
  assert.deepEqual(lastUserTexts(messages, 2, 1000), ["second", "third"]);
  const capped = lastUserTexts([user("u1", big(5000))], 5, 100);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].length, 100);
});
