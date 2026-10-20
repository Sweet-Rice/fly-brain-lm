import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer } from '../renderer.js';

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 };
const camera = { centerX: 10, centerY: 20, scale: 2, width: 800, height: 600 };
const graph = (edges = 1, nodes = 2) => ({ edges: new Float32Array(edges * 18), nodes: new Float32Array(nodes * 18) });

function setup() {
  const buffers = [];
  const writes = [];
  const completions = [];
  const calls = [];
  const device = {
    limits: { maxBufferSize: 1024 },
    createShaderModule: (descriptor) => descriptor,
    createRenderPipeline(descriptor) {
      this.pipeline = descriptor;
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup: (descriptor) => descriptor,
    createBuffer(descriptor) {
      if (buffers.length === this.failAllocation) throw new Error('allocation failed');
      const buffer = { ...descriptor, destroyed: 0, destroy() { this.destroyed++; } };
      buffers.push(buffer);
      if (buffers.length === this.failUploadAllocation) this.failUpload = buffer;
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        if (device.failUpload === buffer) throw new Error('upload failed');
        writes.push({ buffer, offset, data: Array.from(data) });
      },
      onSubmittedWorkDone: () => new Promise((resolve, reject) => completions.push({ resolve, reject })),
    },
  };
  const pass = {
    setPipeline: () => {}, setBindGroup: () => {},
    setVertexBuffer: (_slot, buffer) => calls.push(buffer), draw: (count) => calls.push(count),
  };
  const renderer = createRenderer(device, 'bgra8unorm');
  return { device, buffers, writes, completions, calls, pass, renderer };
}

test('uploads geometry once, draws edges before nodes, and updates only the camera for navigation', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  assert.equal(s.buffers.length, 3);
  assert.equal(s.device.pipeline.primitive.topology, 'triangle-list');
  assert.equal(s.device.pipeline.vertex.buffers[0].arrayStride, 24);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
  assert.deepEqual(s.writes.at(-1).data, [10, 20, 2, 0, 800, 600, 0, 0]);
  s.renderer.draw(s.pass, { ...camera, width: 1200, scale: 4 });
  assert.equal(s.buffers.length, 3);
  assert.equal(s.writes.length, 4);
  assert.deepEqual(s.writes.at(-1).data, [10, 20, 4, 0, 1200, 600, 0, 0]);
  s.renderer.destroy();
});

test('replacement changes the complete scene and retires old buffers after submitted work', async () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph(2, 1));
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[3], 6, s.buffers[4], 3]);
  assert.equal(s.buffers[1].destroyed, 0);
  s.completions[0].resolve();
  await Promise.resolve();
  assert.equal(s.buffers[1].destroyed, 1);
  assert.equal(s.buffers[2].destroyed, 1);
  assert.equal(s.buffers[3].destroyed, 0);
  s.renderer.destroy();
});

test('empty mappings and reset draw nothing and allocate no geometry', () => {
  const s = setup();
  s.renderer.setGraph(graph(0, 0));
  s.renderer.draw(s.pass, camera);
  assert.equal(s.buffers.length, 1);
  s.renderer.setGraph(graph());
  s.renderer.setGraph(null);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, []);
  s.renderer.destroy();
});

test('partial allocation failure releases new buffers and preserves the previous scene', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.device.failAllocation = 4;
  assert.throws(() => s.renderer.setGraph(graph(2, 2)), /allocation failed/);
  assert.equal(s.buffers[3].destroyed, 1);
  assert.equal(s.buffers[1].destroyed, 0);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
  s.renderer.destroy();
});

test('oversized or malformed geometry is rejected before any allocation', () => {
  const s = setup();
  assert.throws(() => s.renderer.setGraph(graph(1, 15)), /buffer size limit/);
  assert.throws(() => s.renderer.setGraph({ edges: new Float32Array(6), nodes: new Float32Array() }), /triangle vertices/);
  assert.equal(s.buffers.length, 1);
  s.renderer.destroy();
});

test('upload failure releases both new buffers and preserves the previous scene', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.device.failUploadAllocation = 5;
  assert.throws(() => s.renderer.setGraph(graph(2, 2)), /upload failed/);
  assert.equal(s.buffers[3].destroyed, 1);
  assert.equal(s.buffers[4].destroyed, 1);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
  s.renderer.destroy();
});

test('retirement waits for each relevant queue boundary and survives device loss', async () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph());
  assert.equal(s.completions.length, 1);
  s.completions[0].resolve();
  await Promise.resolve();
  assert.equal(s.buffers[1].destroyed, 1);
  assert.equal(s.buffers[3].destroyed, 0);
  assert.equal(s.completions.length, 2);
  s.completions[1].reject(new Error('device lost'));
  await Promise.resolve();
  assert.equal(s.buffers[3].destroyed, 1);
  s.renderer.destroy();
});

test('destroy is idempotent and releases pending, active, and uniform buffers exactly once', async () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph());
  s.renderer.destroy();
  s.renderer.destroy();
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, []);
  assert.throws(() => s.renderer.setGraph(graph()), /destroyed/);
  s.completions[0].resolve();
  await Promise.resolve();
  assert.ok(s.buffers.every((buffer) => buffer.destroyed === 1));
});
