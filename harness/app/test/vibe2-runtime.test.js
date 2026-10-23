import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createVibe2Runtime } from "../vibe2/runtime.js";
import { GenerationController } from "../generation.js";
import { ProtocolReceiver } from "../protocol.js";
const manifest = JSON.parse(await readFile(new URL("../../../frontend/public/models/vibe2-tinystories/manifest.json", import.meta.url), "utf8"));
const tokens = Array.from({ length: 50256 }, (_, i) => btoa(`unused${i}`));
tokens[0] = btoa("a"); tokens[1] = btoa(String.fromCharCode(0xe2, 0x82)); tokens[2] = btoa(String.fromCharCode(0xac)); tokens[3] = btoa("b");
const tokenizer = { format: "gpt2-bpe", version: 1, eot: 50256, tokens };
const zeros = new Uint8Array(manifest.weights.bytes);
function fixture(script, options = {}) {
  const calls = [], events = [];
  let clock = 1000;
  const runtime = createVibe2Runtime({ baseUrl: "/assets/", now: () => clock++,
    fetch: async url => {
      if (url.endsWith("manifest.json")) return Response.json(manifest);
      if (url.endsWith("tokenizer.json")) return Response.json(tokenizer);
      return new Response(options.pointer ? "version https://git-lfs.github.com/spec/v1\n" : new ReadableStream({ start(c) { c.enqueue(zeros); c.close(); } }));
    },
    createEngine: async () => ({ reset() {}, destroy() {}, async step(id, opts) {
      calls.push({ id, ...opts });
      if (options.beforeStep) await options.beforeStep(calls.length);
      const logits = new Float32Array(50257).fill(-100);
      logits[script[Math.min(calls.length - 1, script.length - 1)]] = 100;
      const code = new Float32Array(manifest.config.n_kc);
      if (calls.length % 2) code[0] = 1;
      return { logits: opts.logits ? logits : null, code };
    } }),
  });
  runtime.subscribeTelemetry(m => events.push(m));
  const ready = new Promise(resolve => {
    const off = runtime.subscribeStatus(s => { if (s.state !== "loading") { off(); resolve(s); } });
  });
  return { runtime, calls, events, ready };
}
const request = { prompt: "a", maxTokens: 8, temperature: 0, topK: 50 };

test("real controller consumes split UTF-8, EOT usage, lifecycle and graph telemetry", async () => {
  const { runtime, calls, events, ready } = fixture([1, 2, 50256]);
  const controller = new GenerationController({ fetch: runtime.fetch });
  try {
    assert.equal((await controller.checkHealth()).status, "loading");
    assert.equal((await ready).state, "ready");
    assert.equal((await controller.checkHealth()).ready, true);
    const observed = [];
    controller.subscribe(s => { if (s.text) observed.push(s.text); });
    const result = await controller.submit(request);
    assert.equal(result.success, true);
    const state = controller.getState();
    assert.equal(state.text, "€");
    assert.equal(state.finishReason, "stop");
    assert.deepEqual(state.usage, { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 });
    assert.ok(observed.every(s => s === "€"));
    assert.deepEqual(calls.map(c => c.id), [0, 1, 2]);
    assert.deepEqual(events.filter(e => e.type === "request_lifecycle").map(e => e.phase), ["queued", "prefill", "decode", "completed"]);
    const steps = events.filter(e => e.type === "token_step");
    assert.deepEqual(steps.map(e => [e.kind, e.token_id, e.step_status]), [["prompt", 0, "stepped_fired"], ["completion", 1, "stepped_silent"], ["completion", 2, "stepped_fired"], ["completion", 50256, "unprocessed"]]);
    assert.equal(steps.at(-1).t, -1);
    const seq = events.filter(e => "seq" in e).map(e => e.seq);
    assert.ok(seq.every((s, i) => !i || s > seq[i - 1]));
    assert.deepEqual(events.filter(e => e.type === "fire").map(e => e.t), [0, 2]);
    const receiver = new ProtocolReceiver();
    for (const e of events) assert.equal(receiver.process(JSON.stringify(e)).action, e.type === "mapping" ? "replace_mapping" : e.type === "fire" ? "accept_fire" : "accept_telemetry");
    const late = [];
    const off = runtime.subscribeTelemetry(m => late.push(m)); off();
    assert.equal(late[0].type, "mapping");
  } finally { controller.dispose(); runtime.dispose(); }
});

test("length leaves the last completion unprocessed", async () => {
  const { runtime, events, calls, ready } = fixture([3]);
  const controller = new GenerationController({ fetch: runtime.fetch });
  try {
    await ready; await controller.checkHealth();
    await controller.submit({ ...request, maxTokens: 2 });
    assert.equal(controller.getState().text, "bb");
    assert.equal(controller.getState().finishReason, "length");
    assert.equal(controller.getState().usage.completion_tokens, 2);
    assert.equal(calls.length, 2);
    assert.equal(events.filter(e => e.step_status === "unprocessed").length, 1);
  } finally { controller.dispose(); runtime.dispose(); }
});

test("cancelling during a GPU step preserves text and stops further stepping", async () => {
  let entered, release;
  const inStep = new Promise(r => { entered = r; });
  const gate = new Promise(r => { release = r; });
  const { runtime, calls, events, ready } = fixture([3], { beforeStep: async n => { if (n === 2) { entered(); await gate; } } });
  const controller = new GenerationController({ fetch: runtime.fetch });
  try {
    await ready; await controller.checkHealth();
    const pending = controller.submit({ ...request, maxTokens: 128 });
    await inStep; controller.cancel(); release(); await pending;
    await new Promise(r => setImmediate(r));
    assert.equal(controller.getState().state, "cancelled");
    assert.equal(controller.getState().text, "b");
    assert.equal(calls.length, 2);
    assert.equal(events.at(-1).phase, "cancelled");
    assert.equal(events.filter(e => e.step_status === "unprocessed").length, 1);
  } finally { controller.dispose(); runtime.dispose(); }
});

test("unhydrated LFS weights become an actionable loading error", async () => {
  const { runtime, ready } = fixture([], { pointer: true });
  try {
    const status = await ready;
    assert.equal(status.state, "error");
    assert.equal(status.message, "weights.bin is a Git LFS pointer; run git lfs pull");
  } finally { runtime.dispose(); }
});

test("concurrent transports serialize recurrent state and keep graph time monotonic", async () => {
  let entered, release;
  const inStep = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime, calls, events, ready } = fixture([3], {
    beforeStep: async n => { if (n === 1) { entered(); await gate; } },
  });
  try {
    await ready;
    const init = { method: "POST", body: JSON.stringify({ prompt: "a", max_tokens: 1, temperature: 0 }) };
    const first = await runtime.fetch("/v1/completions", init);
    await inStep;
    const second = await runtime.fetch("/v1/completions", init);
    const one = first.text(), two = second.text();
    assert.equal(calls.length, 1);
    assert.deepEqual(events.filter(e => e.phase).map(e => e.phase), ["queued", "prefill", "queued"]);
    release();
    await Promise.all([one, two]);
    assert.equal(calls.length, 2);
    assert.deepEqual(events.filter(e => e.phase === "prefill").map(e => e.t_start), [0, 1]);
    assert.deepEqual(events.filter(e => e.type === "token_step" && e.kind === "prompt").map(e => e.t), [0, 1]);
  } finally { release(); runtime.dispose(); }
});

test("engine failure terminates the stream and emits failed lifecycle", async () => {
  const failure = new Error("GPU execution failed");
  const { runtime, events, ready } = fixture([3], { beforeStep: () => { throw failure; } });
  try {
    await ready;
    const response = await runtime.fetch("/v1/completions", { method: "POST", body: JSON.stringify({ prompt: "a" }) });
    await assert.rejects(response.text(), error => error === failure);
    assert.equal(events.at(-1).phase, "failed");
    assert.equal(events.at(-1).finish_reason, "error");
  } finally { runtime.dispose(); }
});
