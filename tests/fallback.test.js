import assert from "node:assert/strict";
import { test } from "node:test";

import { FALLBACK_MODEL, FALLBACK_PROVIDER, buildPruneOnlySummary } from "../lib/fallback.js";

const text = (t) => ({ type: "text", text: t });
const user = (id, t) => ({ id, role: "user", content: [text(t)], source: { kind: "user" } });
const model = (id, t) => ({ id, role: "model", content: [text(t)], source: { kind: "model" } });

test("prune-only fallback is deterministic and honestly attributed", () => {
  const messages = [user("u1", "first ask"), model("m1", "reply"), user("u2", "second ask")];
  const input = { messages, agentId: "sess-9", keepLastUserMessages: 5, maxTokens: 4096 };
  const a = buildPruneOnlySummary(input);
  const b = buildPruneOnlySummary(input);
  assert.deepEqual(a, b);
  assert.equal(a.provider, FALLBACK_PROVIDER);
  assert.equal(a.provider, "plus-local");
  assert.equal(a.model, FALLBACK_MODEL);
  assert.equal(a.model, "plus-local-fallback");
  assert.equal(a.maxTokens, 4096);
  const summary = a.summary.map((block) => block.text).join("\n");
  assert.match(summary, /prune-only fallback/);
  assert.match(summary, /sess-9/);
  assert.match(summary, /first ask/);
  assert.match(summary, /second ask/);
});

test("fallback honors the last-user-messages cap", () => {
  const messages = [user("u1", "one"), user("u2", "two"), user("u3", "three")];
  const out = buildPruneOnlySummary({ messages, agentId: "s", keepLastUserMessages: 1, maxTokens: 1 });
  const summary = out.summary.map((block) => block.text).join("\n");
  assert.match(summary, /three/);
  assert.doesNotMatch(summary, /one/);
  assert.doesNotMatch(summary, /two/);
});
