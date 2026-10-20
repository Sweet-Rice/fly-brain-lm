import assert from "node:assert/strict";
import test from "node:test";
import { initializeGPU } from "../gpu.js";

function platform(t, gpu = {}) {
  const previous = new Map();
  const statuses = [];
  const calls = { submissions: 0, disconnects: 0, destroys: 0, draws: [], writes: [], buffers: [], listeners: new Set() };
  const frames = new Map();
  let nextFrame = 0;
  let resize;
  let loseDevice;
  const device = {
    limits: { maxTextureDimension2D: 2048, maxBufferSize: 1 << 28 },
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
    GPUBufferUsage: { UNIFORM: 1, VERTEX: 2, COPY_DST: 4 },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    document: { createElement: () => ({ style: {} }) },
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
  return { canvas, context, device, calls, statuses, labels, frames,
    status: value => statuses.push(value), resize: () => resize(), loseDevice,
    emit(type, properties = {}) { canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties)); },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
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
  assert.match(mock.statuses.at(-1), /WebGPU unavailable.*stream inspection still works/);
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
  assert.equal(mock.calls.configuration.device, mock.device);
  assert.equal(mock.calls.configuration.format, "bgra8unorm");
  assert.equal(mock.calls.observed, mock.canvas);
  assert.equal(mock.calls.submissions, 1);
  assert.equal(mock.canvas.width, 1600);
  assert.equal(mock.canvas.height, 1200);

  mock.canvas.clientWidth = 10000;
  mock.canvas.clientHeight = 5000;
  mock.resize();
  assert.equal(mock.canvas.width, 2048);
  assert.equal(mock.canvas.height, 1024);
  mock.canvas.clientWidth = mock.canvas.clientHeight = 0;
  mock.resize();
  assert.equal(mock.canvas.width, 1);
  assert.equal(mock.canvas.height, 1);
  assert.equal(mock.calls.submissions, 3);

  dispose();
  assert.equal(mock.calls.listeners.size, 0);
  assert.equal(mock.frames.size, 0);
  assert.equal(mock.calls.unconfigured, true);
  assert.ok(mock.calls.buffers.every(buffer => buffer.destroys === 1));
  mock.resize();
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
  mock.loseDevice();
  await Promise.resolve();
  assert.match(mock.statuses.at(-1), /device lost.*stream inspection still works/);
  assert.equal(mock.calls.disconnects, 1);
  assert.equal(mock.calls.listeners.size, 0);
  assert.equal(mock.frames.size, 0);
  mock.resize();
  assert.equal(mock.calls.submissions, 1);
  dispose();
  assert.equal(mock.calls.destroys, 1);
});

test("initial drawing failures release the acquired device and resize observer", async t => {
  const mock = platform(t);
  mock.context.getCurrentTexture = () => { throw new Error("canvas failed"); };
  await initializeGPU(mock.canvas, mock.status);
  assert.match(mock.statuses.at(-1), /canvas failed.*Stream inspection still works/);
  assert.equal(mock.calls.disconnects, 1);
  assert.equal(mock.calls.destroys, 1);
  mock.resize();
  assert.equal(mock.calls.submissions, 0);
});

test("resize drawing failures report recovery and keep disposal available", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.flush();
  mock.context.getCurrentTexture = () => { throw new Error("surface unavailable"); };
  assert.doesNotThrow(() => mock.resize());
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
  mock.flush();
  assert.match(mock.statuses.at(-1), /Drawing 2 nodes and 1 directed edges/);
  assert.equal(mock.calls.draws.length, 2);
  assert.deepEqual(mock.labels.children.map(label => label.textContent), ["Left", "Right"]);
  assert.match(mock.labels.children[0].style.transform, /translate\([\d.-]+px, [\d.-]+px\)/);
  dispose();
});

test("replacement and reset remove the previous geometry and labels", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status, mock.labels);
  mock.emit("mapping", { detail: mapping });
  mock.flush();
  const previous = mock.calls.draws.map(draw => draw.buffer);
  mock.emit("mapping", { detail: {
    groups: [{ id: 70, name: "<script>not HTML</script>" }],
    nodes: [{ id: 400, group: 70 }], edges: [],
  } });
  mock.flush();
  await Promise.resolve();
  assert.ok(previous.every(buffer => buffer.destroys === 1));
  assert.equal(mock.calls.draws.length, 3);
  assert.ok(!previous.includes(mock.calls.draws.at(-1).buffer));
  assert.deepEqual(mock.labels.children.map(label => label.textContent), ["<script>not HTML</script>"]);
  const drawCount = mock.calls.draws.length;
  mock.emit("reset");
  mock.flush();
  await Promise.resolve();
  assert.equal(mock.calls.draws.length, drawCount);
  assert.equal(mock.labels.children.length, 0);
  assert.match(mock.statuses.at(-1), /Waiting for a mapping/);
  dispose();
  assert.ok(mock.calls.buffers.every(buffer => buffer.destroys === 1));
});

test("pointer, wheel and keyboard navigation update uniforms without geometry uploads", async t => {
  const mock = platform(t);
  const dispose = await initializeGPU(mock.canvas, mock.status);
  mock.emit("mapping", { detail: mapping });
  mock.flush();
  const bufferCount = mock.calls.buffers.length;
  const geometryWrites = () => mock.calls.writes.filter(write => write.buffer.usage & GPUBufferUsage.VERTEX).length;
  const initialUploads = geometryWrites();
  const uniform = () => mock.calls.writes.findLast(write => write.buffer.usage & GPUBufferUsage.UNIFORM).data;
  const original = [...uniform()];
  mock.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  mock.emit("pointermove", { pointerId: 1, clientX: 140, clientY: 120 });
  mock.emit("pointerup");
  mock.flush();
  assert.equal(mock.calls.focused, true);
  assert.equal(mock.calls.captured, 1);
  assert.ok(uniform()[0] < original[0]);
  assert.ok(uniform()[1] < original[1]);
  const panned = [...uniform()];
  mock.emit("pointermove", { pointerId: 1, clientX: 200, clientY: 200 });
  mock.flush();
  assert.deepEqual(uniform(), panned);
  mock.emit("wheel", { deltaY: -100, clientX: 240, clientY: 230 });
  mock.flush();
  assert.ok(uniform()[2] > panned[2]);
  mock.emit("keydown", { key: "Home" });
  mock.flush();
  assert.deepEqual(uniform(), original);
  mock.emit("keydown", { key: "ArrowRight" });
  mock.emit("zoom", { detail: 1.25 });
  mock.flush();
  assert.ok(uniform()[0] > original[0]);
  assert.ok(uniform()[2] > original[2]);
  mock.emit("fit");
  mock.flush();
  assert.deepEqual(uniform(), original);
  mock.canvas.clientWidth = 400;
  mock.canvas.clientHeight = 300;
  mock.resize();
  assert.deepEqual(uniform().slice(0, 3), original.slice(0, 3));
  assert.deepEqual(uniform().slice(4, 6), [400, 300]);
  assert.equal(geometryWrites(), initialUploads);
  assert.equal(mock.calls.buffers.length, bufferCount);
  dispose();
  assert.equal(mock.calls.listeners.size, 0);
  const writes = mock.calls.writes.length;
  mock.emit("mapping", { detail: mapping });
  mock.emit("zoom", { detail: 2 });
  mock.flush();
  assert.equal(mock.calls.writes.length, writes);
});
