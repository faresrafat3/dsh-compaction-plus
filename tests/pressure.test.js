import assert from "node:assert/strict";
import { test } from "node:test";

import { computePressureThresholdTokens } from "../lib/pressure.js";

test("computePressureThresholdTokens clamps the output reservation", () => {
  // maxTokens close to the window must not collapse the threshold.
  const t = computePressureThresholdTokens(1048576, 0.8, 65536, 943718);
  assert.ok(t > 800000, `expected window-fraction threshold, got ${t}`);
});

test("computePressureThresholdTokens returns non-positive for bad inputs", () => {
  assert.equal(computePressureThresholdTokens(0, 0.8, 0, 0), 0);
  assert.equal(computePressureThresholdTokens(100, 0.8, -1, 0), 0);
  assert.equal(computePressureThresholdTokens(100, NaN, 0, 0), 0);
});

test("computePressureThresholdTokens matches the upstream formula when reservation is small", () => {
  // reserved small: threshold = min(window*ratio, window - reserved - headroom)
  const t = computePressureThresholdTokens(1000, 0.5, 100, 10);
  assert.equal(t, Math.floor(Math.min(500, 1000 - 10 - 100)));
});