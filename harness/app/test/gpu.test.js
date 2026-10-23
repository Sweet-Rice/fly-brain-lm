import assert from "node:assert/strict";
import test from "node:test";
import { initializeGPU, pickNode } from "../gpu.js";
import { buildGraph } from "../layout.js";
import { Camera } from "../camera.js";

function platform(t, gpu = {}) {
  const previous = new Map();
  const statuses = [];
  const calls = { submissions: 0, disconnects: 0, destroys: 0, draws: [], writes: [], buffers: [], listeners: new Set() };
  const frames = new Map();
  let nextFrame = 0;
  let resize;
  let loseDevice;
  let now = 1000;
  const motion = Object.assign(new EventTarget(), { matches: false });
  const device = {
    limits: { maxTextureDimension2D: 2048, maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 },
    lost: new Promise(resolve => { loseDevice = resolve; }),
    addEventListener() {},
    destroy() { calls.destroys += 1; },
    queue: {
      submit() { calls.submissions += 1; },
      writeBuffer(buffer, offset, data) { calls.writes.push({ buffer, data: [...data] }); },
      onSubmittedWorkDone: async () => {},
    },
    createShaderModule: options => options,
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: options => options,
    createBuffer(options) {
      const buffer = { ...options, destroys: 0, destroy() { this.destroys += 1; } };
      calls.buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder() {
      return {
        beginRenderPass() {
          let vertexBuffer;
          return { end() {}, setPipeline() {}, setBindGroup() {},
            setVertexBuffer(slot, buffer) { vertexBuffer = buffer; },
            draw(count) { calls.draws.push({ buffer: vertexBuffer, count }); } };
        },
        finish() { return {}; },
      };
    },
  };
  const context = {
    configure(options) { calls.configuration = options; },
    unconfigure() { calls.unconfigured = true; },
    getCurrentTexture() { return { createView() { return {}; } }; },
  };
  class Canvas extends EventTarget {
    clientWidth = 800;
    clientHeight = 600;
    dataset = {};
    getContext() { return context; }
    getBoundingClientRect() { return { left: 10, top: 20 }; }
    focus() { calls.focused = true; }
    setPointerCapture(id) { calls.captured = id; }
    addEventListener(type, listener, options) {
      calls.listeners.add(listener);
      super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
      calls.listeners.delete(listener);
      super.removeEventListener(type, listener, options);
    }
  }
  const canvas = new Canvas();
  const values = {
    isSecureContext: true,
    navigator: { gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
      ...gpu,
    } },
    window: { devicePixelRatio: 2 },
    performance: { now: () => now },
    matchMedia: () => motion,
    GPUBufferUsage: { UNIFORM: 1, VERTEX: 2, COPY_DST: 4, STORAGE: 8 },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    document: Object.assign(new EventTarget(), { visibilityState: "visible", createElement: () => ({ style: {} }) }),
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe(target) { calls.observed = target; }
      disconnect() { calls.disconnects += 1; }
    },
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const labels = { children: [], replaceChildren(...children) { this.children = children; } };
  return { canvas, context, device, calls, statuses, labels, frames, motion,
    status: value => statuses.push(value), resize: () => resize(), loseDevice,
    advance(milliseconds) { now += milliseconds; },
    emit(type, properties = {}) { canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties)); },
    async flush(at = now) {
      now = at;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
      await Promise.resolve();
    },
  };
}

const mapping = {
  groups: [{ id: 10, name: "Left" }, { id: 30, name: "Right" }],
  nodes: [{ id: 2, group: 10 }, { id: 99, group: 30 }], edges: [[2, 99]],
};

test("unsupported browsers keep stream inspection available without GPU setup", async t => {
  const mock = platform(t, { requestAdapter: () => assert.fail("must not request a device") });
  globalThis.isSecureContext = false;
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  assert.equal(mock.calls.submissions, 0);
  dispose();
});

test("missing adapters and device failures produce usable fallback status", async t => {
  for (const [name, requestAdapter, expected] of [
    ["no adapter", async () => null, /No WebGPU adapter/],
    ["device refused", async () => ({ requestDevice: async () => { throw new Error("permission refused"); } }), /permission refused/],
  ]) {
    await t.test(name, async t => {
      const mock = platform(t, { requestAdapter });
      const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
      assert.match(mock.statuses.at(-1), expected);
      assert.match(mock.statuses.at(-1), /Stream inspection still works/);
      assert.equal(mock.calls.submissions, 0);
      dispose();
    });
  }
});

test("viewport configures, draws and resizes within device limits, then disposes", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  assert.equal(mock.calls.configuration.device, mock.device);
  assert.equal(mock.calls.configuration.format, "bgra8unorm");
  assert.equal(mock.calls.observed, mock.canvas);
  assert.equal(mock.calls.submissions, 1);
  assert.equal(mock.canvas.width, 1600);
  assert.equal(mock.canvas.height, 1200);

  mock.canvas.clientWidth = 10000;
  mock.canvas.clientHeight = 5000;
  mock.resize();
  await mock.flush();
  assert.equal(mock.canvas.width, 2048);
  assert.equal(mock.canvas.height, 1024);
  mock.canvas.clientWidth = mock.canvas.clientHeight = 0;
  mock.resize();
  await mock.flush();
  assert.equal(mock.canvas.width, 1);
  assert.equal(mock.canvas.height, 1);
  assert.equal(mock.calls.submissions, 3);

  dispose();
  assert.equal(mock.calls.listeners.size, 0);
  assert.equal(mock.frames.size, 0);
  assert.equal(mock.calls.unconfigured, true);
  assert.ok(mock.calls.buffers.every(buffer => buffer.destroys === 1));
  mock.resize();
  await mock.flush();
  assert.equal(mock.calls.submissions, 3);
  assert.equal(mock.calls.disconnects, 1);
  assert.equal(mock.calls.destroys, 1);
  const statusesBeforeLoss = mock.statuses.length;
  mock.loseDevice();
  await Promise.resolve();
  assert.equal(mock.statuses.length, statusesBeforeLoss);
});

test("device loss disconnects resizing and reports recovery without more draws", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.loseDevice();
  await Promise.resolve();
  assert.match(mock.statuses.at(-1), /device lost.*stream inspection still works/);
  assert.equal(mock.calls.disconnects, 1);
  assert.equal(mock.calls.listeners.size, 0);
  assert.equal(mock.frames.size, 0);
  mock.resize();
  await mock.flush();
  assert.equal(mock.calls.submissions, 1);
  dispose();
  assert.equal(mock.calls.destroys, 1);
});

test("initial frame failures report recovery and keep disposal available", async t => {
  const mock = platform(t);
  mock.context.getCurrentTexture = () => { throw new Error("canvas failed"); };
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  assert.match(mock.statuses.at(-1), /rendering failed.*Reload to retry/);
  dispose();
  assert.equal(mock.calls.disconnects, 1);
  assert.equal(mock.calls.destroys, 1);
  mock.resize();
  await mock.flush();
  assert.equal(mock.calls.submissions, 0);
});

test("resize drawing failures report recovery and keep disposal available", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  await mock.flush();
  mock.context.getCurrentTexture = () => { throw new Error("surface unavailable"); };
  assert.doesNotThrow(() => mock.resize());
  await mock.flush();
  assert.match(mock.statuses.at(-1), /rendering failed.*Reload to retry/);
  assert.equal(mock.calls.destroys, 0);
  dispose();
  assert.equal(mock.calls.destroys, 1);
});

test("mapping received before adapter resolution is retained and drawn with safe labels", async t => {
  const mock = platform(t);
  let ready;
  navigator.gpu.requestAdapter = () => new Promise(resolve => { ready = resolve; });
  const initialization = initializeGPU(mock.canvas, mock.status, mock.labels);
  mock.emit("mapping", { detail: mapping });
  ready({ requestDevice: async () => mock.device });
  const dispose = await initialization;
  await mock.flush();
  assert.match(mock.statuses.at(-1), /Drawing 2 nodes and 1 directed edges/);
  assert.equal(mock.calls.draws.length, 2);
  assert.deepEqual(mock.labels.children.map(label => label.textContent), ["Left", "Right"]);
  assert.match(mock.labels.children[0].style.transform, /translate\([\d.-]+px, [\d.-]+px\)/);
  dispose();
});

test("replacement and reset remove the previous geometry and labels", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  const previous = mock.calls.draws.map(draw => draw.buffer);
  mock.emit("mapping", { detail: {
    groups: [{ id: 70, name: "<script>not HTML</script>" }],
    nodes: [{ id: 400, group: 70 }], edges: [],
  } });
  await mock.flush();
  await Promise.resolve();
  assert.ok(previous.every(buffer => buffer.destroys === 1));
  assert.equal(mock.calls.draws.length, 3);
  assert.ok(!previous.includes(mock.calls.draws.at(-1).buffer));
  assert.deepEqual(mock.labels.children.map(label => label.textContent), ["<script>not HTML</script>"]);
  const drawCount = mock.calls.draws.length;
  mock.emit("reset");
  await mock.flush();
  await Promise.resolve();
  assert.equal(mock.calls.draws.length, drawCount);
  assert.equal(mock.labels.children.length, 0);
  assert.match(mock.statuses.at(-1), /Waiting for a mapping/);
  dispose();
  assert.ok(mock.calls.buffers.every(buffer => buffer.destroys === 1));
});

test("the canvas layout marker follows the drawn template through replacement and reset", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels);
  await mock.flush();
  assert.equal(mock.canvas.dataset.layout, undefined);
  mock.emit("mapping", { detail: {
    groups: [{ id: 0, name: "Glomerulus" }, { id: 1, name: "KC_gamma" }],
    nodes: [{ id: 0, group: 0 }, { id: 1, group: 1 }], edges: [[0, 1]],
  } });
  await mock.flush();
  assert.equal(mock.canvas.dataset.layout, "brain");
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  assert.equal(mock.canvas.dataset.layout, "grid");
  mock.emit("reset");
  await mock.flush();
  assert.equal(mock.canvas.dataset.layout, undefined);
  dispose();
});

test("pointer, wheel and keyboard navigation update uniforms without geometry uploads", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  const bufferCount = mock.calls.buffers.length;
  const geometryWrites = () => mock.calls.writes.filter(write => write.buffer.usage & GPUBufferUsage.VERTEX).length;
  const initialUploads = geometryWrites();
  const uniform = () => mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.UNIFORM).data;
  const original = [...uniform()];
  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  mock.emit("pointermove", { pointerId: 1, clientX: 140, clientY: 120 });
  mock.emit("pointerup");
  await mock.flush();
  assert.equal(mock.calls.focused, true);
  assert.equal(mock.calls.captured, 1);
  assert.ok(uniform()[0] < original[0]);
  assert.ok(uniform()[1] < original[1]);
  const panned = [...uniform()];
  mock.emit("pointermove", { pointerId: 1, clientX: 200, clientY: 200 });
  await mock.flush();
  assert.deepEqual(uniform(), panned);
  mock.emit("wheel", { deltaY: -100, clientX: 240, clientY: 230 });
  await mock.flush();
  assert.ok(uniform()[2] > panned[2]);
  mock.emit("keydown", { key: "Home" });
  await mock.flush();
  assert.deepEqual(uniform(), original);
  mock.emit("keydown", { key: "ArrowRight" });
  mock.emit("zoom", { detail: 1.25 });
  await mock.flush();
  assert.ok(uniform()[0] > original[0]);
  assert.ok(uniform()[2] > original[2]);
  mock.emit("fit");
  await mock.flush();
  assert.deepEqual(uniform(), original);
  mock.canvas.clientWidth = 400;
  mock.canvas.clientHeight = 300;
  mock.resize();
  await mock.flush();
  assert.deepEqual(uniform().slice(0, 3), original.slice(0, 3));
  assert.deepEqual(uniform().slice(4, 6), [400, 300]);
  assert.equal(geometryWrites(), initialUploads);
  assert.equal(mock.calls.buffers.length, bufferCount);
  dispose();
  assert.equal(mock.calls.listeners.size, 0);
  const writes = mock.calls.writes.length;
  mock.emit("mapping", { detail: mapping });
  mock.emit("zoom", { detail: 2 });
  await mock.flush();
  assert.equal(mock.calls.writes.length, writes);
});

test("fires animate immediately across step gaps, stop at expiry and reuse graph buffers", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  assert.equal(mock.frames.size, 0);
  const buffers = mock.calls.buffers.length;
  const geometryWrites = () => mock.calls.writes.filter(write => write.buffer.usage & GPUBufferUsage.VERTEX).length;
  const uploads = geometryWrites();
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  mock.emit("fire", { detail: { t: 1000000, pairs: [[2, 99]] } });
  assert.equal(mock.frames.size, 1, "bursts share one scheduled frame");
  await mock.flush(1300);
  const uniform = mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.UNIFORM).data;
  assert.equal(uniform[3], 1300, "local elapsed time, not protocol t, drives the highlight");
  assert.equal(uniform[6], 600);
  assert.equal(mock.frames.size, 1);
  await mock.flush(1599);
  assert.equal(mock.frames.size, 1);
  await mock.flush(1600);
  assert.equal(mock.frames.size, 0, "the final frame restores base appearance and stops");
  assert.equal(geometryWrites(), uploads);
  assert.equal(mock.calls.buffers.length, buffers);
  dispose();
});

test("repeated activity restarts expiry while empty and unknown pairs stay idle", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  mock.emit("fire", { detail: { t: 0, pairs: [] } });
  mock.emit("fire", { detail: { t: 1, pairs: [[99, 2]] } });
  assert.equal(mock.frames.size, 0);
  mock.emit("fire", { detail: { t: 2, pairs: [[2, 99], [99, 2]] } });
  await mock.flush(1500);
  mock.emit("fire", { detail: { t: 500, pairs: [[2, 99]] } });
  await mock.flush(1600);
  const activity = mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.STORAGE).data;
  assert.equal(activity[0], 1500);
  assert.equal(mock.frames.size, 1);
  await mock.flush(2100);
  assert.equal(mock.frames.size, 0);
  dispose();
});

test("crossing expiry during submission still schedules a frame to clear reduced-motion highlights", async t => {
  const mock = platform(t);
  mock.motion.matches = true;
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  const submit = mock.device.queue.submit;
  mock.device.queue.submit = () => { submit(); mock.advance(2); };
  await mock.flush(1599);
  const uniform = () => mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.UNIFORM).data;
  assert.equal(uniform()[3], 1599);
  assert.equal(uniform()[7], 1);
  assert.equal(mock.frames.size, 1, "the last active frame must not leave a full highlight on screen");
  await mock.flush(1601);
  assert.equal(uniform()[3], 1601);
  assert.equal(mock.frames.size, 0);
  dispose();
});

test("mapping replacement and source reset clear highlights even when ids are reused", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  await mock.flush(1100);
  assert.equal(mock.frames.size, 1);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  assert.equal(mock.frames.size, 0);
  const activity = mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.STORAGE).data;
  assert.ok(activity[0] < 0, "reused edges have no inherited start time");
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  await mock.flush(1200);
  assert.equal(mock.frames.size, 1);
  mock.emit("reset");
  await mock.flush();
  assert.equal(mock.frames.size, 0);
  assert.match(mock.statuses.at(-1), /Waiting for a mapping/);
  mock.emit("fire", { detail: { t: 1, pairs: [[2, 99]] } });
  assert.equal(mock.frames.size, 0);
  dispose();
});

test("recent fires received before GPU initialization retain their original start time", async t => {
  const mock = platform(t);
  let ready;
  navigator.gpu.requestAdapter = () => new Promise(resolve => { ready = resolve; });
  const initialization = initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  mock.emit("fire", { detail: { t: 900, pairs: [[2, 99]] } });
  ready({ requestDevice: async () => mock.device });
  const dispose = await initialization;
  await mock.flush(1100);
  const activity = mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.STORAGE).data;
  assert.equal(activity[0], 1000);
  assert.equal(mock.frames.size, 1);
  await mock.flush(1600);
  assert.equal(mock.frames.size, 0);
  dispose();
});

test("reset before GPU initialization discards pending fires", async t => {
  const mock = platform(t);
  let ready;
  navigator.gpu.requestAdapter = () => new Promise(resolve => { ready = resolve; });
  const initialization = initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  mock.emit("reset");
  mock.emit("mapping", { detail: mapping });
  ready({ requestDevice: async () => mock.device });
  const dispose = await initialization;
  await mock.flush();
  assert.equal(mock.frames.size, 0);
  const activity = mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.STORAGE).data;
  assert.ok(activity[0] < 0);
  dispose();
});

test("reduced-motion preference reaches drawing and changes during active highlights", async t => {
  const mock = platform(t);
  mock.motion.matches = true;
  const dispose = await initializeGPU(mock.canvas, mock.status);
  await mock.flush();
  mock.emit("mapping", { detail: mapping });
  mock.emit("fire", { detail: { t: 0, pairs: [[2, 99]] } });
  await mock.flush(1100);
  const uniform = () => mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.UNIFORM).data;
  assert.equal(uniform()[7], 1);
  mock.motion.matches = false;
  mock.motion.dispatchEvent(new Event("change"));
  await mock.flush(1200);
  assert.equal(uniform()[7], 0);
  await mock.flush(1600);
  assert.equal(mock.frames.size, 0);
  mock.motion.matches = true;
  mock.motion.dispatchEvent(new Event("change"));
  assert.equal(mock.frames.size, 1);
  dispose();
  assert.equal(mock.frames.size, 0);
  mock.motion.matches = false;
  mock.motion.dispatchEvent(new Event("change"));
  assert.equal(mock.frames.size, 0);
});


test("stalled GPU work coalesces thousands of fires, mappings, resizes, and camera changes", async t => {
  const mock = platform(t);
  const fences = [];
  mock.device.queue.onSubmittedWorkDone = () => new Promise(resolve => fences.push(resolve));
  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  assert.equal(mock.calls.submissions, 1);
  const buffers = mock.calls.buffers.length;
  const writes = mock.calls.writes.length;
  for (let index = 0; index < 1000; index++) {
    mock.emit("mapping", { detail: mapping });
    for (let fire = 0; fire < 10; fire++) mock.emit("fire", { detail: { pairs: [[2, 99]] } });
    mock.emit("zoom", { detail: 1.01 });
    mock.canvas.clientWidth = 400;
    mock.resize();
  }
  assert.equal(mock.frames.size, 0);
  assert.equal(mock.calls.buffers.length, buffers);
  assert.equal(mock.calls.writes.length, writes);
  assert.equal(mock.calls.submissions, 1, "one unresolved submission at most");
  assert.equal(mock.canvas.width, 1600, "surface reconfiguration waits for the frame boundary");
  fences.shift()();
  await Promise.resolve();
  assert.equal(mock.frames.size, 1);
  await mock.flush(1100);
  assert.equal(mock.calls.submissions, 2);
  assert.equal(mock.calls.buffers.length, buffers + 3, "only the latest mapping is built and uploaded");
  assert.equal(mock.calls.buffers.filter(buffer => !buffer.destroys).length, 4);
  assert.equal(mock.canvas.width, 800);
  dispose();
  fences.shift()();
  await Promise.resolve();
  assert.equal(mock.frames.size, 0);
  assert.ok(mock.calls.buffers.every(buffer => buffer.destroys === 1));
});

test("hidden documents retain latest state without GPU work and resume without stale highlights", async t => {
  const mock = platform(t);
  document.visibilityState = "hidden";
  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels);
  for (let index = 0; index < 1000; index++) {
    mock.emit("mapping", { detail: mapping });
    mock.emit("fire", { detail: { pairs: [[2, 99]] } });
    mock.resize();
  }
  await mock.flush(100000);
  assert.equal(mock.frames.size, 0);
  assert.equal(mock.calls.submissions, 0);
  assert.equal(mock.calls.buffers.length, 1, "no geometry is allocated while hidden");
  assert.equal(mock.calls.writes.length, 0);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await mock.flush();
  assert.equal(mock.calls.submissions, 1);
  assert.equal(mock.calls.buffers.length, 4);
  assert.equal(mock.frames.size, 0, "expired highlights do not replay on returning");
  mock.emit("fire", { detail: { pairs: [[2, 99]] } });
  assert.equal(mock.frames.size, 1);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(mock.frames.size, 0, "visibility transition cancels pending RAF");
  mock.emit("reset");
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await mock.flush();
  assert.match(mock.statuses.at(-1), /Waiting for a mapping/);
  assert.equal(mock.labels.children.length, 0);
  dispose();
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(mock.frames.size, 0);
});

test("pickNode picks correct node under transform and returns null for background", () => {
  const graph = buildGraph(mapping);
  const camera = new Camera(800, 600);
  camera.fit(graph.bounds);
  const pos2 = graph.positions.get(2);
  const pos99 = graph.positions.get(99);
  const screen2 = camera.worldToScreen(pos2.x, pos2.y);
  const rect = { left: 10, top: 20 };

  assert.equal(pickNode(graph, camera, screen2.x + rect.left, screen2.y + rect.top, rect), 2);

  camera.pan(120, -50);
  camera.zoom(2.5, 400, 300);
  const screen99 = camera.worldToScreen(pos99.x, pos99.y);
  assert.equal(pickNode(graph, camera, screen99.x + rect.left, screen99.y + rect.top, rect), 99);

  assert.equal(pickNode(graph, camera, -500, -500, rect), null);
});

test("node click emits node-select with runtime ID and highlights neighborhood under transform", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  const selections = [];
  mock.canvas.addEventListener("node-select", (e) => selections.push(e.detail));

  const graph = buildGraph(mapping);
  const camera = new Camera(mock.canvas.clientWidth, mock.canvas.clientHeight);
  camera.fit(graph.bounds);
  const pos2 = graph.positions.get(2);
  const screen2 = camera.worldToScreen(pos2.x, pos2.y);

  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen2.x + 10, clientY: screen2.y + 20 });
  mock.emit("pointerup", { pointerId: 1, clientX: screen2.x + 10, clientY: screen2.y + 20 });
  await mock.flush();
  assert.equal(selections.length, 1);
  assert.equal(selections[0].id, 2);
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5, "overlay buffer allocated");

  mock.emit("keydown", { key: "ArrowLeft" });
  mock.emit("keydown", { key: "+" });
  await mock.flush();

  const uniforms = mock.calls.writes.findLast(w => w.buffer.usage & GPUBufferUsage.UNIFORM).data;
  camera.centerX = uniforms[0];
  camera.centerY = uniforms[1];
  camera.scale = uniforms[2];

  const pos99 = graph.positions.get(99);
  const screen99 = camera.worldToScreen(pos99.x, pos99.y);

  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen99.x + 10, clientY: screen99.y + 20 });
  mock.emit("pointerup", { pointerId: 1, clientX: screen99.x + 10, clientY: screen99.y + 20 });
  await mock.flush();
  assert.equal(selections.length, 2);
  assert.equal(selections[1].id, 99);
  dispose();
});

test("drag vs click: dragging pans camera and prevents node selection", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  const selections = [];
  mock.canvas.addEventListener("node-select", (e) => selections.push(e.detail));
  const uniform = () => mock.calls.writes.findLast(w => w.buffer.usage & GPUBufferUsage.UNIFORM).data;
  const initialCam = [...uniform()];

  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  mock.emit("pointermove", { pointerId: 1, clientX: 150, clientY: 130 });
  mock.emit("pointerup", { pointerId: 1, clientX: 150, clientY: 130 });
  await mock.flush();
  assert.equal(selections.length, 0, "drag must not emit node-select");
  assert.notDeepEqual(uniform(), initialCam, "drag must pan camera");

  const graph = buildGraph(mapping);
  const camera = new Camera(mock.canvas.clientWidth, mock.canvas.clientHeight);
  camera.fit(graph.bounds);
  mock.emit("keydown", { key: "Home" });
  await mock.flush();
  const screen2 = camera.worldToScreen(graph.positions.get(2).x, graph.positions.get(2).y);
  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: screen2.x + 10, clientY: screen2.y + 20 });
  mock.emit("pointerup", { pointerId: 1, clientX: screen2.x + 10, clientY: screen2.y + 20 });
  await mock.flush();
  assert.equal(selections.length, 1);
  assert.equal(selections[0].id, 2);
  dispose();
});

test("background click clears selection and emits node-select with null", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  const selections = [];
  mock.canvas.addEventListener("node-select", (e) => selections.push(e.detail));

  mock.emit("select-node", { detail: { id: 2 } });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5);

  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: -500, clientY: -500 });
  mock.emit("pointerup", { pointerId: 1, clientX: -500, clientY: -500 });
  await mock.flush();
  assert.equal(selections.length, 1);
  assert.equal(selections[0].id, null);
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 4, "background click clears overlay");
  dispose();
});

test("select-node event before and after GPU initialization updates selection", async t => {
  const mock = platform(t);
  let ready;
  navigator.gpu.requestAdapter = () => new Promise(resolve => { ready = resolve; });
  const initialization = initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  mock.emit("select-node", { detail: { id: 2 } });
  ready({ requestDevice: async () => mock.device });
  const dispose = await initialization;
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5, "selection retained and drawn on initial frame");
  mock.emit("select-node", { detail: { id: 99 } });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5);
  mock.emit("select-node", { detail: { id: null } });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 4, "null id clears selection overlay");
  dispose();
});

test("mapping replacement and reset clear selection overlay", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  mock.emit("select-node", { detail: { id: 2 } });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 4, "mapping replacement clears selection overlay");
  mock.emit("select-node", { detail: { id: 2 } });
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 5);
  mock.emit("reset");
  await mock.flush();
  assert.equal(mock.calls.buffers.filter(b => !b.destroys).length, 1, "reset destroys graph and selection overlay");
  dispose();
});

test("no buffer allocations per fire while a node is selected", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();
  mock.emit("select-node", { detail: { id: 2 } });
  await mock.flush();
  const bufferCount = mock.calls.buffers.length;
  const geometryWrites = () => mock.calls.writes.filter(w => w.buffer.usage & GPUBufferUsage.VERTEX).length;
  const initialWrites = geometryWrites();
  mock.emit("fire", { detail: { pairs: [[2, 99]] } });
  await mock.flush(1100);
  assert.equal(mock.calls.buffers.length, bufferCount, "no new buffers allocated on fire");
  assert.equal(geometryWrites(), initialWrites, "no geometry uploaded on fire");
  dispose();
});

test("when WebGPU unavailable or graph not installed, blank canvas click does not clear inspector selection", async t => {
  // 1. WebGPU unavailable: inspector selected an ID, clicking canvas must not emit node-select: null
  const mockUnavailable = platform(t, { requestAdapter: () => assert.fail("must not request a device") });
  globalThis.isSecureContext = false;
  const disposeUnavailable = await initializeGPU(mockUnavailable.canvas, mockUnavailable.status);
  const selectionsUnavailable = [];
  mockUnavailable.canvas.addEventListener("node-select", (e) => selectionsUnavailable.push(e.detail));

  mockUnavailable.emit("select-node", { detail: { id: 2 } });
  mockUnavailable.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  mockUnavailable.emit("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
  mockUnavailable.emit("click", { clientX: 100, clientY: 100 });
  await mockUnavailable.flush();
  assert.equal(selectionsUnavailable.length, 0, "blank canvas click with unavailable WebGPU must not clear selection");
  disposeUnavailable();

  // 2. WebGPU available but graph not installed: clicking canvas must not emit node-select: null
  const mockNoGraph = platform(t);
  const disposeNoGraph = await initializeGPU(mockNoGraph.canvas, mockNoGraph.status);
  const selectionsNoGraph = [];
  mockNoGraph.canvas.addEventListener("node-select", (e) => selectionsNoGraph.push(e.detail));

  mockNoGraph.emit("select-node", { detail: { id: 2 } });
  await mockNoGraph.flush();

  mockNoGraph.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  mockNoGraph.emit("pointerup", { pointerId: 1, clientX: 100, clientY: 100 });
  mockNoGraph.emit("click", { clientX: 100, clientY: 100 });
  await mockNoGraph.flush();
  assert.equal(selectionsNoGraph.length, 0, "blank canvas click with uninstalled graph must not clear selection");

  // 3. Picking real background with loaded graph still clears
  mockNoGraph.emit("mapping", { detail: mapping });
  await mockNoGraph.flush();
  mockNoGraph.emit("pointerdown", { button: 0, pointerId: 1, clientX: -500, clientY: -500 });
  mockNoGraph.emit("pointerup", { pointerId: 1, clientX: -500, clientY: -500 });
  await mockNoGraph.flush();
  assert.equal(selectionsNoGraph.length, 1);
  assert.equal(selectionsNoGraph[0].id, null, "clicking background with loaded graph clears selection");
  disposeNoGraph();
});

test("errors allocating selection preserve prior valid render and cleanup", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  await mock.flush();

  mock.emit("select-node", { detail: { id: 2 } });
  await mock.flush();
  const initialActive = mock.calls.buffers.filter(b => !b.destroys);
  assert.equal(initialActive.length, 5, "overlay buffer allocated for node 2");
  const overlayBuffer2 = initialActive.at(-1);

  const origCreateBuffer = mock.device.createBuffer;
  mock.device.createBuffer = (options) => {
    if (options.usage & GPUBufferUsage.VERTEX) {
      throw new Error("GPU allocation failure");
    }
    return origCreateBuffer.call(mock.device, options);
  };

  mock.emit("select-node", { detail: { id: 99 } });
  await mock.flush();

  assert.equal(overlayBuffer2.destroys, 0, "node 2 overlay buffer preserved on allocation error");
  const activeBuffers = mock.calls.buffers.filter(b => !b.destroys);
  assert.equal(activeBuffers.length, 5, "active buffer count unchanged");
  assert.equal(activeBuffers.at(-1), overlayBuffer2, "prior valid overlay remains active");

  mock.device.createBuffer = origCreateBuffer;
  dispose();
  assert.equal(overlayBuffer2.destroys, 1, "preserved buffer destroyed on cleanup");
});

test("a mapping received in a hidden workspace fits when the graph is first shown", async t => {
  const mock = platform(t);
  mock.canvas.clientWidth = mock.canvas.clientHeight = 0;
  const mbonMapping = { ...mapping, groups: [{ id: 10, name: "MBON" }, mapping.groups[1]] };
  let projected;
  mock.canvas.addEventListener("readout-layout", event => { projected = event.detail; });
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mbonMapping });
  await mock.flush();
  mock.canvas.clientWidth = 320;
  mock.canvas.clientHeight = 280;
  mock.resize();
  await mock.flush();
  const graph = buildGraph(mbonMapping);
  const camera = new Camera(320, 280);
  camera.fit(graph.bounds);
  const position = graph.positions.get(2);
  const expected = camera.worldToScreen(position.x, position.y);
  assert.equal(projected.nodes[0].id, 2);
  assert.equal(projected.nodes[0].x, expected.x);
  assert.equal(projected.nodes[0].y, expected.y);
  dispose();
});

test("abort signal during pending adapter request synchronously removes listeners and prevents device request", async t => {
  let resolveAdapter;
  const adapterPromise = new Promise(resolve => { resolveAdapter = resolve; });
  let deviceRequested = false;
  const mockAdapter = {
    requestDevice: async () => {
      deviceRequested = true;
      return mock.device;
    },
  };
  const mock = platform(t, {
    requestAdapter: () => adapterPromise,
  });

  const controller = new AbortController();
  const initPromise = initializeGPU(mock.canvas, mock.status, mock.labels, { signal: controller.signal });

  assert.ok(mock.calls.listeners.size > 0, "listeners registered on canvas before adapter resolution");

  controller.abort();
  assert.equal(mock.calls.listeners.size, 0, "listeners removed synchronously upon abort");

  resolveAdapter(mockAdapter);
  const dispose = await initPromise;
  assert.equal(typeof dispose, "function");
  assert.equal(deviceRequested, false, "requestDevice was never called after abort");
  assert.equal(mock.calls.configuration, undefined, "context was not configured");
  assert.equal(mock.statuses.length, 0, "no error status reported for aborted initialization");
});

test("abort signal during pending device request synchronously removes listeners and destroys late-resolving device without configuring canvas", async t => {
  let resolveDevice;
  const devicePromise = new Promise(resolve => { resolveDevice = resolve; });
  const mock = platform(t, {
    requestAdapter: async () => ({
      requestDevice: () => devicePromise,
    }),
  });

  const controller = new AbortController();
  const initPromise = initializeGPU(mock.canvas, mock.status, mock.labels, { signal: controller.signal });

  await Promise.resolve();
  await Promise.resolve();

  assert.ok(mock.calls.listeners.size > 0, "listeners registered while waiting for device");

  controller.abort();
  assert.equal(mock.calls.listeners.size, 0, "listeners removed synchronously upon abort");

  resolveDevice(mock.device);
  const dispose = await initPromise;
  assert.equal(typeof dispose, "function");

  assert.equal(mock.calls.destroys, 1, "late-resolving device is destroyed immediately");
  assert.equal(mock.calls.configuration, undefined, "context was not configured");
  assert.equal(mock.statuses.length, 0, "no error status reported for aborted initialization");
});

test("pre-aborted signal disposes synchronously without querying WebGPU", async t => {
  let adapterCalled = false;
  const mock = platform(t, {
    requestAdapter: async () => {
      adapterCalled = true;
      return { requestDevice: async () => mock.device };
    },
  });

  const controller = new AbortController();
  controller.abort();

  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels, { signal: controller.signal });
  assert.equal(typeof dispose, "function");
  assert.equal(adapterCalled, false, "adapter was never requested");
  assert.equal(mock.calls.listeners.size, 0, "no listeners retained");
  assert.equal(mock.statuses.length, 0, "no error status reported");
});
