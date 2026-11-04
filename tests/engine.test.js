import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { CompactionPlusEngine } from "../lib/index.js";

class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm");
    this.calls = [];
  }
  async *stream(options) {
    this.calls.push(options);
    yield { type: "text-delta", index: 0, text: "Summary: user asked about pruning." };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

class FakeTokenMeter extends Service {
  constructor(ctx) { super(ctx, "tokenMeter"); }
}
class FakeSessions extends Service {
  constructor(ctx) { super(ctx, "sessions"); }
}

const text = (t) => ({ type: "text", text: t });

test("summarize spills original text and returns LLM summary with honest spilled marker", async (t) => {
  const spillDir = mkdtempSync(join(tmpdir(), "compaction-plus-engine-"));
  t.after(() => rmSync(spillDir, { recursive: true, force: true }));

  const ctx = new Context();
  const llm = new FakeLlm(ctx);
  new FakeTokenMeter(ctx);
  new FakeSessions(ctx);

  const fiber = ctx.plugin(CompactionPlusEngine, {
    auto: false,
    spillDir,
    summarizationProvider: "fake-provider",
    summarizationModel: "fake-mini",
    keepLastToolResults: 0,
    toolResultChars: 256,
  });
  await fiber;
  const engine = ctx.compaction;

  const longToolText = "x".repeat(5000);
  const input = {
    messages: [
      { id: "u1", role: "user", content: [text("please prune this")], source: { kind: "user" } },
      { id: "t1", role: "tool", content: [text(longToolText)], source: { kind: "tool" } },
      { id: "m1", role: "assistant", content: [text("done")], source: { kind: "model" } },
    ],
  };
  const agent = {
    id: "agent-1",
    options: { provider: "fake-provider", model: "fake-mini" },
    session: {
      id: "sess-1",
      requestHeader: () => undefined,
      toolHistory: () => [],
    },
  };

  const result = await engine.summarize(input, agent);

  // LLM path taken (not fallback)
  assert.equal(result.llmStreamCall, true);
  assert.equal(result.provider, "fake-provider");
  assert.equal(result.model, "fake-mini");
  assert.ok(result.summary.some((b) => b.text.includes("Summary: user asked about pruning")));

  // Fake LLM received a pruned input: stale tool result truncated with honest spilled marker
  assert.equal(llm.calls.length, 1);
  const sentMessages = llm.calls[0].messages;
  const sentTool = sentMessages.find((m) => m.role === "tool");
  assert.ok(sentTool.content[0].text.includes("tool result truncated by compaction-plus"));
  assert.ok(sentTool.content[0].text.includes("full text spilled to the local store"));

  // Spill file exists under spillDir and holds original text
  assert.ok(existsSync(spillDir));
  const files = readdirSync(spillDir);
  assert.ok(files.length >= 1, `expected spill file, got ${files}`);
  const spilled = files.map((f) => readFileSync(join(spillDir, f), "utf8")).join("\n");
  assert.ok(spilled.includes("please prune this"));
  assert.ok(spilled.includes(longToolText.slice(0, 100)));
});

test("summarize with spillDir null marks prune as not-spilled honestly", async (t) => {
  const ctx = new Context();
  const llm = new FakeLlm(ctx);
  new FakeTokenMeter(ctx);
  new FakeSessions(ctx);

  const fiber = ctx.plugin(CompactionPlusEngine, {
    auto: false,
    spillDir: null,
    summarizationProvider: "fake-provider",
    summarizationModel: "fake-mini",
    keepLastToolResults: 0,
    toolResultChars: 256,
  });
  await fiber;
  const engine = ctx.compaction;
  assert.equal(engine.spillStore, null);

  const input = {
    messages: [
      { id: "t1", role: "tool", content: [text("y".repeat(5000))], source: { kind: "tool" } },
    ],
  };
  const agent = {
    id: "agent-2",
    options: { provider: "fake-provider", model: "fake-mini" },
    session: { id: "sess-2", requestHeader: () => undefined, toolHistory: () => [] },
  };

  const result = await engine.summarize(input, agent);
  assert.equal(result.llmStreamCall, true);
  const sentTool = llm.calls[0].messages.find((m) => m.role === "tool");
  assert.ok(sentTool.content[0].text.includes("not spilled; full text not retained"));
  assert.ok(!sentTool.content[0].text.includes("full text spilled to the local store"));
});
