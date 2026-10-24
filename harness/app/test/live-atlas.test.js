import test from "node:test";
import assert from "node:assert/strict";
import { mountLiveAtlas } from "../live-atlas.js";

class MockElement extends EventTarget {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName;
    this.id = "";
    this.className = "";
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.type = "";
    this.min = "";
    this.placeholder = "";
    this.htmlFor = "";
    this.value = "";
    this._textContent = "";
    this.clientWidth = 800;
    this.clientHeight = 600;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(v) {
    this._textContent = String(v ?? "");
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = [...nodes];
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }

  getContext() {
    return null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }

  focus() {}
  blur() {}
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function setupHarness(t) {
  const handles = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    activeElement: null,
    createElement(tag) {
      return new MockElement(tag);
    },
  });
  globalThis.document = doc;

  t.after(async () => {
    for (const handle of handles) {
      handle.dispose();
    }
    await Promise.resolve();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });

  return {
    mount(options) {
      const handle = mountLiveAtlas(options);
      handles.push(handle);
      return handle;
    },
  };
}

const sampleMapping = {
  type: "mapping", version: 1,
  groups: [{ id: 10, name: "Antennal" }, { id: 20, name: "KC_gamma" }],
  nodes: [{ id: 1, group: 10 }, { id: 2, group: 20 }, { id: 3, group: 20 }],
  edges: [[1, 2], [2, 3]],
};

function mount(t) {
  const harness = setupHarness(t), canvas = new MockElement("canvas"), inspector = new MockElement();
  const snapshots = [], events = [];
  for (const kind of ["mapping", "fire", "telemetry", "reset"]) canvas.addEventListener(kind, e => events.push(e));
  const handle = harness.mount({ canvas, inspector, labels: new MockElement(), onState: s => snapshots.push(s) });
  return { handle, canvas, inspector, snapshots, events };
}

test("publishing topology updates graph, groups and neuron selection", t => {
  const { handle, canvas, inspector, snapshots, events } = mount(t);
  handle.publish(sampleMapping);
  const state = snapshots.at(-1);
  assert.equal(state.nodeCount, 3);
  assert.equal(state.edgeCount, 2);
  assert.deepEqual(state.groups.map(g => [g.name, g.count]), [["Antennal", 1], ["KC_gamma", 2]]);
  assert.equal(events.at(-1).type, "mapping");
  canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: 2 } }));
  assert.equal(findById(inspector, "neuron-id").textContent, "2");
  handle.publish({ type: "mapping", version: 1, groups: [{ id: 1, name: "New" }], nodes: [{ id: 5, group: 1 }], edges: [] });
  assert.equal(snapshots.at(-1).nodeCount, 1);
  assert.equal(findById(inspector, "neuron-details").hidden, true);
});

test("fires dispatch immediately and counter snapshots coalesce", async t => {
  const { handle, snapshots, events } = mount(t);
  handle.publish(sampleMapping);
  for (let i = 0; i < 8; i++) handle.publish({ type: "fire", t: i, pairs: [[1, 2]] });
  assert.equal(events.filter(e => e.type === "fire").length, 8);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(snapshots.at(-1).acceptedFires, 8);
  assert.equal(snapshots.at(-1).lastStep, 7);
});

test("token telemetry reaches the readout event path; invalid input clears the display", t => {
  const { handle, snapshots, events } = mount(t);
  handle.publish(sampleMapping);
  const token = { type: "token_step", run_id: "r", request_id: "q", epoch: 0, seq: 0,
    kind: "completion", token_index: 0, token_id: 3, token_text: "b", token_bytes: "62",
    step_status: "unprocessed", t: -1, step_rel_us: 0, emit_rel_us: 1, step_ns: "0", emit_ns: "1000" };
  handle.publish(token);
  assert.deepEqual(events.at(-1).detail, token);
  assert.equal(events.at(-1).type, "telemetry");
  handle.publish({ type: "fire", t: -2, pairs: [] });
  assert.equal(snapshots.at(-1).droppedMessages, 1);
  assert.equal(events.at(-1).type, "reset");
});

test("disposal prevents later events and state callbacks", async t => {
  const { handle, snapshots, events } = mount(t);
  handle.publish(sampleMapping);
  handle.publish({ type: "fire", t: 0, pairs: [[1, 2]] });
  const states = snapshots.length, count = events.length;
  handle.dispose();
  handle.publish(sampleMapping);
  handle.fit();
  handle.zoom(2);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(snapshots.length, states);
  assert.equal(events.length, count);
});
