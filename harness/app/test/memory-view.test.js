import test from "node:test";
import assert from "node:assert/strict";
import { mountMemory } from "../memory-view.js";

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
function body(root, id) { return byId(root, id).children[0].children[2]; }
function setup() {
  const document = { createElement: (tag) => new Element(tag, document) };
  const root = document.createElement("div");
  const canvas = new EventTarget();
  const dispose = mountMemory(root, canvas);
  let seq = 0;
  const send = (message) => {
    const event = new Event("telemetry");
    event.detail = { run_id: "run-memory", epoch: 2, seq: seq++, ...message };
    canvas.dispatchEvent(event);
  };
  return { root, canvas, dispose, send };
}
const common = { request_id: "req-memory", block: 0, t: 7, rev: 1, prev_rev: 0, scale: 1000000 };
const summary = (overrides = {}) => ({
  type: "memory_summary", ...common, t: (overrides.rev ?? 1) + 6, heads: 3, head_dim: 5, dtype: "float32",
  dopamine_gate: [1, -500000, 0], dopamine_cap: [500000, 500000, 500000],
  recovery_half_life: [4000000, "inf", 2], recovery_factor: [800000, "nan", 2],
  s_norm_before: [0, "missing", 0], s_norm_after: [2000, 3000, 1], s_delta_norm: [2000, "-inf", 1],
  ...overrides,
});
const slice = (overrides = {}) => ({
  type: "memory_slice", ...common, t: (overrides.rev ?? 1) + 6, lobe: 0, kc_id: 12, head: 0, k_activation: 1,
  s_before: [1, "nan", "inf", "-inf", "missing"], s_after: [2, 3, 4, 5, 6],
  delta_raw: [1, 2, 3, 4, 5], delta_net: [2, 3, 4, 5, 6], read_vector: [5, 4, 3, 2, 1],
  ...overrides,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
function choose(control, value) {
  control.value = value;
  control.dispatchEvent(new Event("change"));
}

test("empty, summary-only and orphan-slice states explicitly explain unavailable values", async () => {
  const { root, send, dispose } = setup();
  try {
    assert.equal(byId(root, "memory-write").disabled, true);
    assert.match(text(byId(root, "memory-empty")), /Legacy streams and models without memory telemetry/);
    send(summary());
    await flush();
    assert.equal(byId(root, "memory-empty").hidden, true);
    assert.equal(body(root, "memory-heads").children.length, 3);
    assert.equal(byId(root, "memory-features").hidden, true);
    assert.match(text(byId(root, "memory-slice-note")), /Summary only.*unobserved values are unavailable/);
    send(slice({ request_id: "slice-only" }));
    await flush();
    assert.match(text(byId(root, "memory-summary-note")), /Summary unavailable.*Slice-only/);
    assert.equal(byId(root, "memory-heads").hidden, true);
    assert.equal(byId(root, "memory-features").hidden, false);
    assert.equal(body(root, "memory-features").children.length, 5);
    assert.match(text(byId(root, "memory-details")), /slice-only · block 0 · t 7 · rev 0 → 1/);
  } finally { dispose(); }
});

test("fixed-point values preserve small magnitudes and all sentinels without HTML interpretation", async () => {
  const { root, send, dispose } = setup();
  try {
    const request_id = "<img src=x onerror=alert(1)>";
    send(summary({ request_id }));
    send(slice({ request_id }));
    await flush();
    const rows = body(root, "memory-features").children;
    assert.deepEqual(rows.map((row) => row.children[1].textContent), ["0.000001", "nan", "inf", "-inf", "missing"]);
    assert.equal(body(root, "memory-heads").children[0].children[1].textContent, "0.000001");
    assert.match(text(byId(root, "memory-slice-note")), /k_activation 0.000001/);
    assert.match(byId(root, "memory-details").textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(byId(root, "memory-details").children.length, 0);
    assert.match(text(byId(root, "memory-help")), /transient request-local recurrent state, not learned parameters/);
    assert.match(text(byId(root, "memory-help")), /Heads are computational units, not anatomical neurons/);
    assert.match(text(byId(root, "memory-help")), /KC IDs are model KC indices/);
    assert.equal(byId(root, "memory-heads").attributes.get("aria-live"), undefined);
    assert.equal(byId(root, "memory-features").tabIndex, 0);
    assert.equal(byId(root, "memory-features").attributes.get("role"), "region");
  } finally { dispose(); }
});

test("follow latest is default, explicit write and slice choices remain stable as telemetry arrives", async () => {
  const { root, send, dispose } = setup();
  try {
    send(summary());
    send(slice());
    send(slice({ kc_id: 13 }));
    await flush();
    const writes = byId(root, "memory-write");
    const slices = byId(root, "memory-slice");
    assert.equal(writes.value, "latest");
    choose(writes, writes.children[1].value);
    choose(slices, slices.children[1].value);
    send(summary({ rev: 2, prev_rev: 1, t: 8 }));
    send(slice({ rev: 2, prev_rev: 1, t: 8, kc_id: 15 }));
    await flush();
    assert.equal(byId(root, "memory-write"), writes);
    assert.equal(byId(root, "memory-slice"), slices);
    assert.match(text(byId(root, "memory-details")), /t 7 · rev 0 → 1/);
    assert.match(text(byId(root, "memory-slice-note")), /KC 13/);
    choose(writes, "latest");
    assert.match(text(byId(root, "memory-details")), /t 8 · rev 1 → 2/);
    assert.match(text(byId(root, "memory-slice-note")), /KC 15/);
  } finally { dispose(); }
});

test("revision gaps, message loss and retention remain visible with bounded rendering", async () => {
  const { root, send, dispose } = setup();
  try {
    send(summary({ rev: 5, prev_rev: 4 }));
    await flush();
    assert.match(text(byId(root, "memory-notice")), /first observed write is after revision 1/);
    send(summary({ rev: 7, prev_rev: 6 }));
    send({ type: "stream_status", event: "gap", dropped_steps: 3, server_time_ms: 100 });
    for (let kc_id = 0; kc_id < 35; kc_id++) send(slice({ rev: 7, prev_rev: 6, kc_id }));
    await flush();
    assert.match(text(byId(root, "memory-notice")), /3 messages lost/);
    assert.match(text(byId(root, "memory-notice")), /Revision gap/);
    assert.match(text(byId(root, "memory-notice")), /3 slices omitted/);
    assert.equal(byId(root, "memory-slice").children.length, 32);
    const writes = byId(root, "memory-write");
    choose(writes, writes.children[1].value);
    for (let rev = 8; rev <= 25; rev++) send(summary({ rev, prev_rev: rev - 1 }));
    await flush();
    assert.equal(writes.children.length, 17);
    assert.equal(writes.value, "latest");
    assert.match(text(byId(root, "memory-notice")), /Selected write is no longer retained/);
    assert.match(text(byId(root, "memory-notice")), /older writes omitted/);
  } finally { dispose(); }
});

test("mapping/reset events clear observations and disposal cancels pending renders", async () => {
  const { root, canvas, send, dispose } = setup();
  send(summary());
  await flush();
  canvas.dispatchEvent(new Event("mapping"));
  await flush();
  assert.equal(byId(root, "memory-empty").hidden, false);
  assert.equal(byId(root, "memory-write").disabled, true);
  assert.match(text(byId(root, "memory-identity")), /No memory telemetry/);
  send(slice());
  await flush();
  canvas.dispatchEvent(new Event("reset"));
  await flush();
  assert.equal(byId(root, "memory-features").hidden, true);
  send(summary());
  dispose();
  send(slice());
  await flush();
  assert.equal(root.children.length, 0);
});
