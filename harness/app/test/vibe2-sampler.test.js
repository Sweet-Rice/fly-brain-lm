import test from "node:test";
import assert from "node:assert/strict";
import { sampleToken } from "../vibe2/sampler.js";
test("greedy chooses first maximum", () => assert.equal(sampleToken([1, 3, 3, 2], 0, 2), 1));
test("threshold retains ties, including ties beyond topK", () => {
  assert.equal(sampleToken([1, 3, 3, 2], 1, 2, () => 0.99), 2);
  assert.equal(sampleToken([3, 3, 3, 1], 1, 2, () => 0.99), 2);
});
test("temperature changes probabilities", () => {
  assert.equal(sampleToken([0, 2], 1, 2, () => 0.2), 1);
  assert.equal(sampleToken([0, 2], 10, 2, () => 0.2), 0);
});
test("zero draw returns first retained index", () => assert.equal(sampleToken([0, 4, 2], 1, 1, () => 0), 1));
