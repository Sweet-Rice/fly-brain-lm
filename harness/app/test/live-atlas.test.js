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

function createFakeSocketClass() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.closed = false;
      sockets.push(this);
    }
    open() {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }
    close(code = 1000, reason = "") {
      this.readyState = 3;
      this.closed = true;
      this.onclose?.({ code, reason });
    }
    message(data) {
      this.onmessage?.({ data });
    }
    error() {
      this.onerror?.();
    }
  }
  return { FakeSocket, sockets };
}

const sampleMapping = JSON.stringify({
  type: "mapping",
  version: 1,
  groups: [
    { id: 10, name: "Antennal" },
    { id: 20, name: "KC_gamma" },
  ],
  nodes: [
    { id: 1, group: 10 },
    { id: 2, group: 20 },
    { id: 3, group: 20 },
  ],
  edges: [
    [1, 2],
    [2, 3],
  ],
});

function fireMessage(t, pairs = [[1, 2]]) {
  return JSON.stringify({ type: "fire", t, pairs });
}

test("consumer-visible state transitions: connection, mapping arrival with real groups, and selection", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  const snapshots = [];
  const canvasEvents = [];

  canvas.addEventListener("mapping", (e) => canvasEvents.push(e));

  harness.mount({
    canvas,
    labels,
    inspector,
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  // Initial state before socket opens
  assert.equal(snapshots[0].connectionState, "connecting");
  assert.equal(snapshots[0].nodeCount, 0);

  const socket = sockets[0];
  socket.open();
  assert.equal(snapshots.at(-1).connectionState, "connected");

  // Receive mapping
  socket.message(sampleMapping);

  const mappingSnap = snapshots.at(-1);
  assert.equal(mappingSnap.nodeCount, 3);
  assert.equal(mappingSnap.edgeCount, 2);
  assert.equal(mappingSnap.groups.length, 2);

  const group10 = mappingSnap.groups.find((g) => g.id === 10);
  const group20 = mappingSnap.groups.find((g) => g.id === 20);
  assert.ok(group10 && group20);
  assert.equal(group10.name, "Antennal");
  assert.equal(group10.count, 1);
  assert.equal(group20.name, "KC_gamma");
  assert.equal(group20.count, 2);
  assert.ok(group20.color.startsWith("rgb"));

  assert.equal(Object.isFrozen(mappingSnap), true);
  assert.equal(Object.isFrozen(mappingSnap.groups), true);
  assert.equal(canvasEvents.length, 1);

  // Canvas selection through inspector event path
  canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: 2 } }));
  const details = findById(inspector, "neuron-details");
  const emptyNotice = findById(inspector, "inspector-empty");
  const neuronId = findById(inspector, "neuron-id");
  assert.ok(details && emptyNotice && neuronId);
  assert.equal(details.hidden, false, "inspector shows selected node details");
  assert.equal(emptyNotice.hidden, true, "empty state notice is hidden when node is selected");
  assert.equal(neuronId.textContent, "2", "inspector displays selected neuron ID");
});

test("coalesces counter publishes during generation while dispatching fires immediately to canvas", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  const snapshots = [];
  const canvasFires = [];

  canvas.addEventListener("fire", (e) => canvasFires.push(e));

  harness.mount({
    canvas,
    labels,
    inspector,
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  const socket = sockets[0];
  socket.open();
  socket.message(sampleMapping);

  const snapshotCountBeforeFires = snapshots.length;

  for (let i = 1; i <= 8; i++) {
    socket.message(fireMessage(i, [[1, 2]]));
  }

  // Canvas receives fires immediately
  assert.equal(canvasFires.length, 8);
  // React state updates coalesced outside per-fire loop
  assert.ok(snapshots.length - snapshotCountBeforeFires < 8);

  // Await coalescing frame/tick
  await new Promise((resolve) => setTimeout(resolve, 30));

  const finalSnap = snapshots.at(-1);
  assert.equal(finalSnap.acceptedFires, 8);
  assert.equal(finalSnap.lastStep, 8);
});

test("mapping replacement resets counters, topology, and previous selection", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  const snapshots = [];

  harness.mount({
    canvas,
    labels,
    inspector,
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  const socket = sockets[0];
  socket.open();
  socket.message(sampleMapping);
  socket.message(fireMessage(1, [[1, 2]]));

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(snapshots.at(-1).acceptedFires, 1);

  // Select node 2 before replacement
  canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: 2 } }));
  const details = findById(inspector, "neuron-details");
  const emptyNotice = findById(inspector, "inspector-empty");
  assert.ok(details && emptyNotice);
  assert.equal(details.hidden, false, "selected before replacement");
  assert.equal(emptyNotice.hidden, true);

  // Replacement mapping arrives
  const replacement = JSON.stringify({
    type: "mapping",
    version: 1,
    groups: [{ id: 99, name: "NewGroup" }],
    nodes: [{ id: 5, group: 99 }],
    edges: [],
  });
  socket.message(replacement);

  const replacedSnap = snapshots.at(-1);
  assert.equal(replacedSnap.acceptedFires, 0, "acceptedFires reset on replacement mapping");
  assert.equal(replacedSnap.nodeCount, 1);
  assert.equal(replacedSnap.edgeCount, 0);
  assert.equal(replacedSnap.groups[0].name, "NewGroup");

  // Selection is cleared by replacement mapping
  assert.equal(details.hidden, true, "selection cleared after mapping replacement");
  assert.equal(emptyNotice.hidden, false, "empty notice shown after mapping replacement");
});

test("disconnection and reconnection reset state and prevent stale data", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  const snapshots = [];
  const resetEvents = [];

  canvas.addEventListener("reset", (e) => resetEvents.push(e));

  const handle = harness.mount({
    canvas,
    labels,
    inspector,
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  const socket = sockets[0];
  socket.open();
  socket.message(sampleMapping);
  socket.message(fireMessage(1, [[1, 2]]));

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(snapshots.at(-1).nodeCount, 3);

  // Socket disconnects
  handle.disconnect();

  const disconnectedSnap = snapshots.at(-1);
  assert.equal(disconnectedSnap.connectionState, "disconnected");
  assert.equal(disconnectedSnap.nodeCount, 0, "stale nodeCount cleared");
  assert.equal(disconnectedSnap.edgeCount, 0, "stale edgeCount cleared");
  assert.deepEqual(disconnectedSnap.groups, [], "stale groups cleared");
  assert.equal(disconnectedSnap.acceptedFires, 0, "stale fires cleared");
  assert.ok(resetEvents.length >= 1, "reset dispatched to canvas to clear graph");
});

test("ensureConnected preserves active connection, reconnects when dropped, and surfaces errors", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  const snapshots = [];

  const handle = harness.mount({
    canvas,
    labels,
    inspector,
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  assert.equal(sockets.length, 1);
  sockets[0].open();

  // Active connection: ensureConnected preserves it
  handle.ensureConnected();
  assert.equal(sockets.length, 1, "open connection preserved");

  // Disconnect, then ensureConnected must reconnect
  handle.disconnect();
  assert.equal(sockets[0].closed, true);
  handle.ensureConnected();
  assert.equal(sockets.length, 2, "reconnected after disconnect");

  // If constructor throws, error is surfaced in snapshot without throwing
  class FailingSocket {
    constructor() { throw new Error("Connection refused"); }
  }
  const failingHandle = harness.mount({
    canvas: new MockElement("canvas"),
    labels: new MockElement("div"),
    inspector: new MockElement("div"),
    onState: (snap) => snapshots.push(snap),
    endpoint: "ws://invalid.test/stream",
    WebSocketType: FailingSocket,
  });

  assert.equal(snapshots.at(-1).connectionState, "error");
  assert.equal(snapshots.at(-1).connectionMessage, "Connection refused");

  // ensureConnected does not throw on error
  failingHandle.ensureConnected();
});

test("synchronous disposal cleans up resources and prevents post-disposal callbacks", async (t) => {
  const harness = setupHarness(t);
  const { FakeSocket, sockets } = createFakeSocketClass();
  const canvas = new MockElement("canvas");
  const labels = new MockElement("div");
  const inspector = new MockElement("div");
  let stateCalls = 0;

  const handle = harness.mount({
    canvas,
    labels,
    inspector,
    onState: () => { stateCalls++; },
    endpoint: "ws://example.test/stream",
    WebSocketType: FakeSocket,
  });

  const socket = sockets[0];
  socket.open();
  socket.message(sampleMapping);

  const callsBeforeDispose = stateCalls;
  handle.dispose();

  assert.equal(socket.closed, true, "websocket closed upon disposal");

  // Post-disposal activity
  socket.message(fireMessage(5));
  handle.connect();
  handle.ensureConnected();
  handle.dispose();

  assert.equal(stateCalls, callsBeforeDispose, "no state callbacks fired after disposal");
  assert.equal(sockets.length, 1, "no new sockets revived after disposal");
});
