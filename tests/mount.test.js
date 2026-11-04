import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Context, Service } from "@deepseek-ai/cordis";
import { CompactionPlusEngine } from "../lib/index.js";

class FakeLlm extends Service {
  constructor(ctx) {
    super(ctx, "llm");
  }
}

class FakeTokenMeter extends Service {
  constructor(ctx) {
    super(ctx, "tokenMeter");
  }
}

class FakeSessions extends Service {
  constructor(ctx) {
    super(ctx, "sessions");
  }
}

test("mounts as the compaction service with inherited base defaults", async (t) => {
  const spillDir = mkdtempSync(join(tmpdir(), "compaction-plus-"));
  t.after(() => rmSync(spillDir, { recursive: true, force: true }));

  const ctx = new Context();
  // Register the three required services as lightweight fakes. The engine only
  // touches them during an actual compaction; mounting must not call them.
  new FakeLlm(ctx);
  new FakeTokenMeter(ctx);
  new FakeSessions(ctx);

  const fiber = ctx.plugin(CompactionPlusEngine, {
    auto: false,
    spillDir,
    thresholdRatio: 0.85,
    summarizationProvider: "fake-provider",
    summarizationModel: "fake-mini",
  });
  await fiber;

  const engine = ctx.compaction;
  assert.ok(engine instanceof CompactionPlusEngine);
  // Each ctx.compaction access returns a fresh Cordis proxy, so identity
  // comparison would fail; compare config instead.
  assert.equal(ctx.compaction.config.thresholdRatio, 0.85);

  // Base defaults are inherited from BasicCompactionEngine.
  assert.equal(engine.config.thresholdRatio, 0.85);
  assert.equal(engine.config.retainRatio, 0.16);
  assert.equal(engine.config.headroomTokens, 65536);
  assert.equal(engine.config.summarizationProvider, "fake-provider");

  // Plus-only extras are exposed through the engine, not passed to the base.
  assert.ok(engine.spillStore instanceof Object);
  assert.equal(typeof engine.spillStore.append, "function");
  assert.equal(typeof engine.compactIfNeeded, "function");
  assert.equal(typeof engine.compactRegion, "function");
  assert.equal(typeof engine.compactNow, "function");
});
