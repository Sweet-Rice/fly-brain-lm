import assert from "node:assert/strict";
import test from "node:test";
import { initializeGPU } from "../gpu.js";

function platform(t, gpu = {}) {
  const previous = new Map();
  const statuses = [];
  const calls = { submissions: 0, disconnects: 0, destroys: 0 };
  let resize;
  let loseDevice;
  const device = {
    limits: { maxTextureDimension2D: 2048 },
    lost: new Promise(resolve => { loseDevice = resolve; }),
    addEventListener() {},
    destroy() { calls.destroys += 1; },
    queue: { submit() { calls.submissions += 1; } },
    createCommandEncoder() {
      return {
        beginRenderPass() { return { end() {} }; },
        finish() { return {}; },
      };
    },
  };
  const context = {
    configure(options) { calls.configuration = options; },
    getCurrentTexture() { return { createView() { return {}; } }; },
  };
  const canvas = { clientWidth: 800, clientHeight: 600, getContext: () => context };
  const values = {
    isSecureContext: true,
    navigator: { gpu: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => "bgra8unorm",
      ...gpu,
    } },
    window: { devicePixelRatio: 2 },
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
  return { canvas, context, device, calls, statuses, status: value => statuses.push(value),
    resize: () => resize(), loseDevice };
}

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
