import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer } from '../renderer.js';
import { EdgeActivity } from '../activity.js';

globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8 };
const camera = { centerX: 10, centerY: 20, scale: 2, width: 800, height: 600 };
const graph = (edges = 1, nodes = 2) => ({
  edges: new Float32Array(edges * 21), nodes: new Float32Array(nodes * 21),
  edgePairs: Array.from({ length: edges }, (_, index) => [index, index + 1]),
});

function setup() {
  const buffers = [];
  const writes = [];
  const completions = [];
  const calls = [];
  const device = {
    limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 1024 },
    createShaderModule: (descriptor) => descriptor,
    createRenderPipeline(descriptor) {
      this.pipeline = descriptor;
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup(descriptor) {
      if (this.failBindGroup) throw new Error('bind group failed');
      return descriptor;
    },
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
        writes.push({ buffer, offset, data: Array.from(data), source: data });
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
  assert.equal(s.buffers.length, 4);
  assert.equal(s.device.pipeline.primitive.topology, 'triangle-list');
  assert.equal(s.device.pipeline.vertex.buffers[0].arrayStride, 28);
  s.renderer.draw(s.pass, camera, 100);
  assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
  assert.deepEqual(s.writes.at(-1).data, [10, 20, 2, 100, 800, 600, 600, 0]);
  s.renderer.draw(s.pass, { ...camera, width: 1200, scale: 4 }, 200, true);
  assert.equal(s.buffers.length, 4);
  assert.equal(s.writes.length, 5);
  assert.deepEqual(s.writes.at(-1).data, [10, 20, 4, 200, 1200, 600, 600, 1]);
  assert.equal(s.writes.at(-1).source, s.writes.at(-2).source);
  s.renderer.destroy();
});

test('brain regions upload once and draw beneath edges and nodes', () => {
  const s = setup();
  s.renderer.setGraph({ ...graph(), regions: new Float32Array(4 * 21) });
  s.renderer.draw(s.pass, camera, 100);
  assert.deepEqual(s.calls, [s.buffers[1], 12, s.buffers[2], 3, s.buffers[3], 6]);
  assert.throws(() => s.renderer.setGraph({ ...graph(), regions: new Float32Array(6) }), /triangle vertices/);
  s.renderer.destroy();
});

test('replacement changes the complete scene and immediately destroys unused buffer handles', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph(2, 1));
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[4], 6, s.buffers[5], 3]);
  assert.equal(s.buffers[1].destroyed, 1);
  assert.equal(s.buffers[2].destroyed, 1);
  assert.equal(s.buffers[3].destroyed, 1);
  assert.equal(s.buffers[4].destroyed, 0);
  s.renderer.destroy();
});

test('empty mappings and reset draw nothing and allocate no geometry', () => {
  const s = setup();
  s.renderer.setGraph(graph(0, 0));
  s.renderer.draw(s.pass, camera);
  assert.equal(s.buffers.length, 2);
  s.renderer.setGraph(graph());
  s.renderer.setGraph(null);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, []);
  s.renderer.destroy();
});

test('partial allocation failure releases new buffers and preserves the previous scene', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.device.failAllocation = 5;
  assert.throws(() => s.renderer.setGraph(graph(2, 2)), /allocation failed/);
  assert.equal(s.buffers[4].destroyed, 1);
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
  s.device.failUploadAllocation = 6;
  assert.throws(() => s.renderer.setGraph(graph(2, 2)), /upload failed/);
  assert.equal(s.buffers[4].destroyed, 1);
  assert.equal(s.buffers[5].destroyed, 1);
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
  s.renderer.destroy();
});

test('repeated replacement retains only current buffers without accumulating retirement promises', () => {
  const s = setup();
  for (let index = 0; index < 1000; index++) s.renderer.setGraph(graph());
  assert.equal(s.completions.length, 0);
  assert.equal(s.buffers.filter(buffer => !buffer.destroyed).length, 4);
  s.renderer.destroy();
});

test('destroy is idempotent and releases active and uniform buffers exactly once', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.setGraph(graph());
  s.renderer.destroy();
  s.renderer.destroy();
  s.renderer.draw(s.pass, camera);
  assert.deepEqual(s.calls, []);
  assert.throws(() => s.renderer.setGraph(graph()), /destroyed/);
  assert.ok(s.buffers.every((buffer) => buffer.destroyed === 1));
});

test('fires reuse the activity buffer and never upload or rebuild static geometry', () => {
  const s = setup();
  s.renderer.setGraph(graph(3, 2));
  const bufferCount = s.buffers.length;
  const geometryWrites = s.writes.filter(write => write.buffer.usage & GPUBufferUsage.VERTEX);
  const activityBuffer = s.buffers.find(buffer => buffer.usage & GPUBufferUsage.STORAGE);
  assert.deepEqual(s.writes.at(-1).data, [-1, -1, -1]);
  const initialWrites = s.writes.length;
  assert.equal(s.renderer.fire([[0, 1], [2, 3], [99, 100]], 100), true);
  assert.equal(s.writes.length, initialWrites);
  s.renderer.draw(s.pass, camera, 100);
  const latestActivity = () => s.writes.findLast(write => write.buffer === activityBuffer);
  assert.deepEqual(latestActivity().data, [100, -1, 100]);
  assert.equal(s.renderer.isActive(699), true);
  assert.equal(s.renderer.isActive(700), false);
  assert.equal(s.renderer.fire([[0, 1]], 500), true);
  s.renderer.draw(s.pass, camera, 500);
  assert.deepEqual(latestActivity().data, [500, -1, 100]);
  assert.equal(s.renderer.isActive(1099), true);
  assert.equal(s.renderer.isActive(1100), false);
  const writeCount = s.writes.length;
  assert.equal(s.renderer.fire([[1, 0]], 600), false);
  assert.equal(s.writes.length, writeCount);
  for (let now = 600; now <= 1100; now += 100) s.renderer.draw(s.pass, camera, now);
  assert.equal(s.buffers.length, bufferCount);
  assert.deepEqual(s.writes.filter(write => write.buffer.usage & GPUBufferUsage.VERTEX), geometryWrites);
  s.renderer.destroy();
});

test('replacement and reset clear highlights, including edges that reuse the same IDs', () => {
  const s = setup();
  s.renderer.setGraph(graph());
  s.renderer.fire([[0, 1]], 10);
  s.renderer.setGraph(graph());
  assert.equal(s.renderer.isActive(20), false);
  assert.deepEqual(s.writes.at(-1).data, [-1]);
  s.renderer.fire([[0, 1]], 30);
  s.renderer.setGraph(null);
  assert.equal(s.renderer.isActive(40), false);
  assert.equal(s.renderer.fire([[0, 1]], 40), false);
  s.renderer.destroy();
});

test('mapping installation keeps fire activity received before the GPU became ready', () => {
  const s = setup();
  const next = graph();
  const activity = new EdgeActivity(next.edgePairs);
  activity.fire([[0, 1]], 40);
  s.renderer.setGraph(next, activity);
  assert.deepEqual(s.writes.at(-1).data, [40]);
  assert.equal(s.renderer.isActive(50), true);
  s.renderer.destroy();
});

test('activity upload and bind group failures release the new scene atomically', () => {
  for (const failure of ['upload', 'bind group']) {
    const s = setup();
    s.renderer.setGraph(graph());
    s.renderer.fire([[0, 1]], 100);
    if (failure === 'upload') s.device.failUploadAllocation = 7;
    else s.device.failBindGroup = true;
    assert.throws(() => s.renderer.setGraph(graph()), /failed/);
    assert.ok(s.buffers.slice(4).every(buffer => buffer.destroyed === 1));
    assert.ok(s.buffers.slice(1, 4).every(buffer => buffer.destroyed === 0));
    assert.equal(s.renderer.isActive(200), true);
    s.renderer.draw(s.pass, camera, 200);
    assert.deepEqual(s.calls, [s.buffers[1], 3, s.buffers[2], 6]);
    s.renderer.destroy();
  }
});

test('activity exceeding the storage binding limit is rejected before allocation', () => {
  const s = setup();
  s.device.limits.maxStorageBufferBindingSize = 4;
  assert.throws(() => s.renderer.setGraph(graph(2)), /storage buffer size limit/);
  assert.equal(s.buffers.length, 1);
  s.renderer.destroy();
});

test('thousands of fires coalesce into one fixed-size activity upload on the next frame', () => {
  const s = setup();
  s.renderer.setGraph(graph(3));
  const activityBuffer = s.buffers.find(buffer => buffer.usage & GPUBufferUsage.STORAGE);
  const storageWrites = () => s.writes.filter(write => write.buffer === activityBuffer);
  const count = s.buffers.length;
  for (let index = 0; index < 10000; index++) {
    s.renderer.fire([[index % 3, index % 3 + 1]], index);
  }
  assert.equal(storageWrites().length, 1, 'no per-event GPU work while frames are stalled');
  s.renderer.draw(s.pass, camera, 10000);
  assert.equal(storageWrites().length, 2);
  assert.deepEqual(storageWrites().at(-1).data, [9999, 9997, 9998]);
  assert.equal(s.buffers.length, count);
  s.renderer.draw(s.pass, camera, 10001);
  assert.equal(storageWrites().length, 2, 'unchanged activity needs no further upload');
  s.renderer.draw(s.pass, camera, 30 * 86400000);
  assert.deepEqual(storageWrites().at(-1).data, [-1, -1, -1]);
  assert.equal(s.writes.at(-1).data[3], 600, 'shader clock stays bounded');
  s.renderer.destroy();
});
