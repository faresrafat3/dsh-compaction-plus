import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SpillStore } from "../lib/spill.js";

function freshStore(t, maxBytes) {
  const dir = mkdtempSync(join(tmpdir(), "compaction-plus-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store: new SpillStore(dir, maxBytes), dir };
}

test("append and read round-trip in order", (t) => {
  const { store } = freshStore(t);
  store.append("sess-1", [
    { ts: 1, role: "user", text: "fix the parser" },
    { ts: 2, role: "model", text: "done" },
  ]);
  assert.equal(store.count("sess-1"), 2);
  assert.deepEqual(store.read("sess-1").map((e) => e.text), ["fix the parser", "done"]);
  assert.equal(store.count("nope"), 0);
});

test("filename is sanitized per session", (t) => {
  const { store, dir } = freshStore(t);
  store.append("a/b?c", [{ ts: 1, role: "user", text: "hi" }]);
  assert.ok(statSync(join(dir, "a_b_c.jsonl")).isFile());
});

test("search ranks by query token overlap, newest wins ties", (t) => {
  const { store } = freshStore(t);
  store.append("s", [
    { ts: 1, role: "user", text: "deploy the schema migration" },
    { ts: 2, role: "model", text: "schema migration finished" },
    { ts: 3, role: "user", text: "unrelated weather question" },
  ]);
  const hits = store.search("s", "schema migration", 5);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.score === 2));
  assert.equal(hits[0].ts, 2);
  assert.deepEqual(store.search("s", "", 5), []);
  assert.deepEqual(store.search("s", "absent"), []);
  const limited = store.search("s", "schema", 1);
  assert.equal(limited.length, 1);
});

test("corrupt lines are skipped, never thrown", (t) => {
  const { store, dir } = freshStore(t);
  store.append("s", [{ ts: 1, role: "user", text: "good" }]);
  appendFileSync(join(dir, "s.jsonl"), "{not json\n", "utf8");
  assert.equal(store.count("s"), 1); // the corrupt line is skipped, not counted
});

test("byte cap drops oldest entries and keeps the tail", (t) => {
  const { store, dir } = freshStore(t, 512);
  const entries = Array.from({ length: 20 }, (_, i) => ({
    ts: i + 1,
    role: "user",
    text: `entry number ${i} ${"pad".repeat(3)}`,
  }));
  store.append("s", entries);
  const remaining = store.read("s");
  assert.ok(remaining.length < 20 && remaining.length > 0, `kept ${remaining.length} entries`);
  assert.equal(remaining[remaining.length - 1].ts, 20);
  assert.ok(statSync(join(dir, "s.jsonl")).size <= 512);
});

// ILL-06: the atomic tmp+rename rewrite fails with EISDIR when a directory
// obstructs <session>.jsonl.tmp; the byte cap must still be enforced.
test("byte cap is enforced even when the tmp rewrite is obstructed", (t) => {
  const { store, dir } = freshStore(t, 300);
  mkdirSync(join(dir, "s.jsonl.tmp")); // plant obstruction at the atomic-rewrite path
  const entries = Array.from({ length: 20 }, (_, i) => ({
    ts: i + 1,
    role: "user",
    text: `entry number ${i} ${"pad".repeat(3)}`,
  }));
  store.append("s", entries);
  // RED on unpatched code: the EISDIR is swallowed and the file stays over cap.
  const size = statSync(join(dir, "s.jsonl")).size;
  assert.ok(size <= 300, `file is ${size} bytes, cap is 300`);
  const remaining = store.read("s");
  assert.ok(remaining.length > 0, `kept ${remaining.length} entries`);
  assert.equal(remaining[remaining.length - 1].ts, 20);
});
