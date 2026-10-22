import test from "node:test";
import assert from "node:assert/strict";
import { mountTimeline } from "../timeline-view.js";

class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = new Map();
    this.textContent = "";
    this.value = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, value); }
}
function byId(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = byId(child, id);
    if (found) return found;
  }
  return null;
}
function text(root) { return [root.textContent, ...root.children.map(text)].join(" "); }
function setup() {
  const document = { createElement: (tag) => new Element(tag, document) };
  const root = document.createElement("div");
  const canvas = new EventTarget();
  const dispose = mountTimeline(root, canvas);
  let seq = 0;
  const send = (message) => {
    const event = new Event("telemetry");
    event.detail = { run_id: "run-view", epoch: 2, seq: seq++, ...message };
    canvas.dispatchEvent(event);
  };
  return { root, canvas, dispose, send };
}
const lifecycle = (request_id = "req-view", phase = "queued") => ({
  type: "request_lifecycle", request_id, impl: "vibe2", model_id: "test",
  ckpt_digest: "sha256:0123456789ab", phase, t_start: -1,
  prompt_raw_tokens: 3, prompt_tokens: 0, max_tokens: 4, completion_tokens: 0,
  finish_reason: "none", server_time_ms: 100, timestamp_ns: "100000000",
});
const token = (overrides = {}) => ({
  type: "token_step", request_id: "req-view", kind: "completion", token_index: 0,
  token_id: 42, token_text: "<img src=x onerror=alert(1)>", token_bytes: "61",
  step_status: "unprocessed", t: -1, step_rel_us: 0, emit_rel_us: 1200,
  step_ns: "0", emit_ns: "100001200", ...overrides,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("timeline explains legacy streams and safely renders token semantics", async () => {
  const { root, send, dispose } = setup();
  try {
    assert.match(text(root), /Legacy mapping\/fire streams/);
    assert.equal(byId(root, "timeline-request").disabled, true);
    send(lifecycle());
    send(token());
    send(token({ kind: "prompt", token_index: 1, step_status: "stepped_silent",
      t: 7, step_rel_us: 900, emit_rel_us: 900, step_ns: "100000900", emit_ns: "100000900", token_text: "", token_bytes: "e2" }));
    await flush();
    assert.match(text(byId(root, "timeline-identity")), /run-view · epoch 2/);
    assert.match(text(byId(root, "timeline-summary")), /checkpoint sha256:0123456789ab/);
    const rows = byId(root, "timeline-tokens").children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].children[1].tagName, "code");
    assert.equal(rows[0].children[1].textContent, '"<img src=x onerror=alert(1)>"');
    assert.match(text(rows[0]), /t — · emit 1200 µs · step — \(unprocessed\)/);
    assert.match(text(rows[1]), /stepped_silent.*t 7.*raw bytes e2/);
    assert.equal(byId(root, "timeline-tokens").attributes.get("aria-live"), undefined);
    assert.match(text(byId(root, "timeline-help")), /same server run and epoch/);
    assert.match(text(byId(root, "timeline-help")), /not biological spikes/);
  } finally { dispose(); }
});

test("requests remain selectable during concurrent queue updates and reset clears history", async () => {
  const { root, canvas, send, dispose } = setup();
  try {
    send(lifecycle("req-first"));
    await flush();
    const select = byId(root, "timeline-request");
    assert.equal(select.value, "req-first");
    send(lifecycle("req-second"));
    await flush();
    assert.equal(select.value, "req-first");
    assert.equal(select.children.length, 2);
    select.value = "req-second";
    select.dispatchEvent(new Event("change"));
    send(lifecycle("req-second", "prefill"));
    await flush();
    assert.equal(select.value, "req-second");
    assert.match(text(byId(root, "timeline-phases")), /queued → prefill/);
    canvas.dispatchEvent(new Event("mapping"));
    await flush();
    assert.equal(select.children.length, 0);
    assert.equal(byId(root, "timeline-tokens").children.length, 0);
    assert.match(text(byId(root, "timeline-identity")), /No run telemetry/);
  } finally { dispose(); }
});

test("gaps and retention stay visible, token rendering is bounded, and disposal cancels updates", async () => {
  const { root, send, dispose } = setup();
  send(lifecycle());
  send({ type: "stream_status", event: "gap", dropped_steps: 3, server_time_ms: 100 });
  for (let index = 0; index < 258; index++) send(token({ token_index: index }));
  await flush();
  assert.equal(byId(root, "timeline-tokens").children.length, 256);
  assert.match(text(byId(root, "timeline-notice")), /3 messages lost/);
  assert.match(text(byId(root, "timeline-notice")), /2 older tokens omitted/);
  send(lifecycle("req-later"));
  dispose();
  send(token());
  await flush();
  assert.equal(root.children.length, 0);
});
