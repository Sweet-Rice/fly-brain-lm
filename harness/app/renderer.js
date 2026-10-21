import { ACTIVITY_DURATION, EdgeActivity } from './activity.js';
import { buildSelectionGeometry } from './layout.js';

const shader = `
struct Camera {
  center: vec2f,
  scale: f32,
  time: f32,
  viewport: vec2f,
  duration: f32,
  reducedMotion: f32,
};
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> starts: array<f32>;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};
@vertex fn vertex(@location(0) position: vec2f, @location(1) color: vec4f, @location(2) edgeIndex: f32) -> Vertex {
  let clip = (position - camera.center) * camera.scale * 2.0 / camera.viewport;
  var highlighted = color;
  if (edgeIndex >= 0.0) {
    let start = starts[u32(edgeIndex)];
    let age = camera.time - start;
    if (start >= 0.0 && age >= 0.0 && age < camera.duration) {
      let intensity = select(1.0 - age / camera.duration, 1.0, camera.reducedMotion > 0.5);
      highlighted = vec4f(mix(color.rgb, vec3f(1.0), 0.8 * intensity), max(color.a, 0.95 * intensity));
    }
  }
  return Vertex(vec4f(clip.x, -clip.y, 0.0, 1.0), highlighted);
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  return input.color;
}`;

export function createRenderer(device, format) {
  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex', buffers: [{
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x4' },
        { shaderLocation: 2, offset: 24, format: 'float32' },
      ],
    }] },
    fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } }] },
    primitive: { topology: 'triangle-list' },
  });
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniforms = new Float32Array(8);
  let bindGroup;
  let activity = null;
  let activityBuffer;
  let currentGraph = null;
  let selectedNodeId = null;
  let overlayBuffer = null;
  let overlayCount = 0;
  let current = [];
  let currentBuffers = [];
  let uploadedVersion = -1;
  let disposed = false;
  const release = (buffers) => {
    for (const buffer of buffers) buffer.destroy();
  };
  return {
    setGraph(graph, nextActivity) {
      if (disposed) throw new Error('Renderer has been destroyed');
      const arrays = graph ? [graph.edges, graph.nodes] : [];
      for (const data of arrays) {
        if (!(data instanceof Float32Array) || data.length % 21 !== 0) {
          throw new Error('Graph geometry must contain interleaved triangle vertices');
        }
        if (data.byteLength > device.limits.maxBufferSize) throw new Error('Graph exceeds the GPU buffer size limit');
      }
      nextActivity ??= graph ? new EdgeActivity(graph.edgePairs) : null;
      if (nextActivity && (nextActivity.starts.byteLength > device.limits.maxBufferSize ||
          nextActivity.starts.byteLength > device.limits.maxStorageBufferBindingSize)) {
        throw new Error('Graph activity exceeds the GPU storage buffer size limit');
      }
      const next = [];
      const nextBuffers = [];
      let nextActivityBuffer;
      let nextBindGroup;
      let nextOverlayBuffer = null;
      let nextOverlayCount = 0;
      try {
        for (const data of arrays) {
          if (!data.length) continue;
          const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          nextBuffers.push(buffer);
          next.push({ buffer, count: data.length / 7 });
          device.queue.writeBuffer(buffer, 0, data);
        }
        if (nextActivity) {
          nextActivityBuffer = device.createBuffer({
            size: nextActivity.starts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          nextBuffers.push(nextActivityBuffer);
          device.queue.writeBuffer(nextActivityBuffer, 0, nextActivity.starts);
          nextBindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0), entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: nextActivityBuffer } },
            ],
          });
        }
        if (selectedNodeId !== null && graph?.positions?.has(selectedNodeId)) {
          const data = buildSelectionGeometry(graph, selectedNodeId);
          if (data.length) {
            if (data.byteLength > device.limits.maxBufferSize) {
              throw new Error('Selection geometry exceeds the GPU buffer size limit');
            }
            nextOverlayBuffer = device.createBuffer({
              size: data.byteLength,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(nextOverlayBuffer, 0, data);
            nextOverlayCount = data.length / 7;
          }
        }
      } catch (error) {
        release(nextBuffers);
        if (nextOverlayBuffer) nextOverlayBuffer.destroy();
        throw error;
      }
      // WebGPU keeps previously submitted uses alive after destroy().
      release(currentBuffers);
      if (overlayBuffer) overlayBuffer.destroy();
      current = next;
      currentBuffers = nextBuffers;
      activity = nextActivity;
      activityBuffer = nextActivityBuffer;
      bindGroup = nextBindGroup;
      uploadedVersion = activity?.version ?? -1;
      currentGraph = graph;
      overlayBuffer = nextOverlayBuffer;
      overlayCount = nextOverlayCount;
      if (selectedNodeId !== null && !graph?.positions?.has(selectedNodeId)) {
        selectedNodeId = null;
      }
    },
    fire(pairs, now) {
      if (disposed || !activity?.fire(pairs, now)) return false;
      return true;
    },
    isActive(now) {
      return !disposed && Boolean(activity?.active(now));
    },
    setSelectedNode(id, graph = currentGraph) {
      if (disposed) return;
      const targetGraph = graph !== undefined ? graph : currentGraph;
      const targetId = id ?? null;
      if (targetId === selectedNodeId && targetGraph === currentGraph && (overlayBuffer || targetId === null)) {
        return;
      }
      if (targetId === null || !targetGraph?.positions?.has(targetId)) {
        if (overlayBuffer) {
          overlayBuffer.destroy();
          overlayBuffer = null;
          overlayCount = 0;
        }
        selectedNodeId = null;
        currentGraph = targetGraph;
        return;
      }
      const data = buildSelectionGeometry(targetGraph, targetId);
      if (!data.length) {
        if (overlayBuffer) {
          overlayBuffer.destroy();
          overlayBuffer = null;
          overlayCount = 0;
        }
        selectedNodeId = targetId;
        currentGraph = targetGraph;
        return;
      }
      if (data.byteLength > device.limits.maxBufferSize) {
        throw new Error('Selection geometry exceeds the GPU buffer size limit');
      }
      let nextBuffer = null;
      try {
        nextBuffer = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(nextBuffer, 0, data);
      } catch (error) {
        if (nextBuffer) nextBuffer.destroy();
        throw error;
      }
      if (overlayBuffer) {
        overlayBuffer.destroy();
      }
      overlayBuffer = nextBuffer;
      overlayCount = data.length / 7;
      selectedNodeId = targetId;
      currentGraph = targetGraph;
    },
    draw(pass, camera, now = performance.now(), reducedMotion = false) {
      if (disposed || !current.length) return;
      uniforms[0] = camera.centerX;
      uniforms[1] = camera.centerY;
      uniforms[2] = camera.scale;
      uniforms[3] = activity.time(now);
      uniforms[4] = camera.width;
      uniforms[5] = camera.height;
      uniforms[6] = ACTIVITY_DURATION;
      uniforms[7] = Number(reducedMotion);
      if (uploadedVersion !== activity.version) {
        device.queue.writeBuffer(activityBuffer, 0, activity.starts);
        uploadedVersion = activity.version;
      }
      device.queue.writeBuffer(uniform, 0, uniforms);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      for (const { buffer, count } of current) {
        pass.setVertexBuffer(0, buffer);
        pass.draw(count);
      }
      if (overlayBuffer && overlayCount > 0) {
        pass.setVertexBuffer(0, overlayBuffer);
        pass.draw(overlayCount);
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      release(currentBuffers);
      current = [];
      currentBuffers = [];
      if (overlayBuffer) {
        overlayBuffer.destroy();
        overlayBuffer = null;
        overlayCount = 0;
      }
      currentGraph = null;
      selectedNodeId = null;
      activity = null;
      uniform.destroy();
    },
  };
}
