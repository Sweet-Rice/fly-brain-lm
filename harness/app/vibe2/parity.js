import { loadManifest, loadTokenizerFile, loadWeights } from "./assets.js";
import { createTokenizer } from "./tokenizer.js";
import { createVibe2Engine } from "./engine.js";
import { sampleToken } from "./sampler.js";

/** Compare a fresh GPU engine with committed float32 PyTorch step vectors. */
export async function runVibe2Parity(baseUrl) {
  const manifest = await loadManifest(baseUrl, fetch);
  const tokenizer = createTokenizer(await loadTokenizerFile(baseUrl, fetch));
  const weights = await loadWeights(baseUrl, manifest, fetch);
  const response = await fetch(`${baseUrl.replace(/\/?$/, "/")}golden.json`);
  if (!response.ok) throw new Error("Golden parity vectors not found");
  const golden = await response.json();
  const tokenizerFailures = golden.tokenizer_cases.filter(c => JSON.stringify(tokenizer.encodeOrdinary(c.text)) !== JSON.stringify(c.ids)).map(c => c.text);
  const engine = await createVibe2Engine({ manifest, weights });
  let maxTopLogitDiff = 0, count = 0;
  const kcMismatchSteps = [];
  const started = performance.now();
  try {
    engine.reset();
    for (let i = 0; i < golden.steps.length; i++) {
      const expected = golden.steps[i];
      const { logits, code } = await engine.step(expected.token_id, { logits: true }); count++;
      for (const [id, value] of expected.top_logits) maxTopLogitDiff = Math.max(maxTopLogitDiff, Math.abs(logits[id] - value));
      const active = Array.from(code).flatMap((value, k) => value > 0 ? [k] : []);
      if (JSON.stringify(active) !== JSON.stringify(expected.active_kcs)) kcMismatchSteps.push(i);
    }
    engine.reset();
    let logits;
    for (const token of golden.prompt_ids) { ({ logits } = await engine.step(token, { logits: true })); count++; }
    const ids = [];
    for (let i = 0; i < golden.greedy_ids.length; i++) {
      const token = sampleToken(logits, 0); ids.push(token);
      if (i + 1 < golden.greedy_ids.length) { ({ logits } = await engine.step(token, { logits: true })); count++; }
    }
    const mismatch = ids.findIndex((id, i) => id !== golden.greedy_ids[i]);
    return { tokenizerFailures, greedyMatch: mismatch < 0, firstGreedyMismatch: mismatch < 0 ? null : mismatch,
      maxTopLogitDiff, kcMismatchSteps, tokensPerSecond: count * 1000 / (performance.now() - started) };
  } finally { engine.destroy(); }
}
