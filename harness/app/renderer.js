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
@vertex fn vertex(@location(0) position: vec2f, @location(1) color: vec4f, @location(2) activityIndex: f32) -> Vertex {
  let clip = (position - camera.center) * camera.scale * 2.0 / camera.viewport;
  var highlighted = color;
  if (activityIndex >= 0.0) {
    let index = u32(activityIndex);
    if (index < arrayLength(&starts)) {
      let start = starts[index];
      let age = camera.time - start;
      if (start >= 0.0 && age >= 0.0 && age < camera.duration) {
        let intensity = select(1.0 - age / camera.duration, 1.0, camera.reducedMotion > 0.5);
        highlighted = vec4f(mix(color.rgb, vec3f(1.0), 0.7 * intensity), max(color.a, 0.95 * intensity));
      }
    }
  }
  return Vertex(vec4f(clip.x, -clip.y, 0.0, 1.0), highlighted);
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  return input.color;
}`;

const dotShader = `
struct DotCamera {
  center: vec2f,
  scale: f32,
  time: f32,
  viewport: vec2f,
  duration: f32,
  reducedMotion: f32,
};
@group(0) @binding(0) var<uniform> camera: DotCamera;
@group(0) @binding(1) var<storage, read> starts: array<f32>;

struct DotVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) dotCoord: vec2f,
  @location(2) totalLength: f32,
  @location(3) @interpolate(flat) progress: f32,
};

@vertex fn vertex(
  @location(0) position: vec2f,
  @location(1) dotCoord: vec2f,
  @location(2) color: vec3f,
  @location(3) totalLength: f32,
  @location(4) activityIndex: f32
) -> DotVertexOutput {
  let clip = (position - camera.center) * camera.scale * 2.0 / camera.viewport;
  // Negative progress means the connection is idle and draws nothing.
  var progress: f32 = -1.0;
  if (activityIndex >= 0.0) {
    let index = u32(activityIndex);
    if (index < arrayLength(&starts)) {
      let start = starts[index];
      let age = camera.time - start;
      if (start >= 0.0 && age >= 0.0 && age < camera.duration) {
        progress = age / camera.duration;
      }
    }
  }
  return DotVertexOutput(
    vec4f(clip.x, -clip.y, 0.0, 1.0),
    mix(color, vec3f(1.0), 0.35),
    dotCoord,
    totalLength,
    progress
  );
}

@fragment fn fragment(input: DotVertexOutput) -> @location(0) vec4f {
  if (input.progress < 0.0) {
    discard;
  }
  let minWorldRadius = 1.5 / max(camera.scale, 0.1);
  let dotRadius = clamp(max(1.6, minWorldRadius), 1.6, 3.2);
  let stripHalfWidth = 3.5;
  let s = input.dotCoord.x;
  let distAcross = input.dotCoord.y * stripHalfWidth;
  var distAlong: f32;
  if (camera.reducedMotion > 0.5) {
    // Without motion, stationary dots mark the fired connection for the same duration.
    let spacing = min(max(24.0, dotRadius * 6.0), max(input.totalLength, 1.0));
    let phase = ((s % spacing) + spacing) % spacing;
    distAlong = phase - spacing * 0.5;
  } else {
    // One dot travels from source to target once per fire.
    distAlong = s - input.progress * input.totalLength;
  }
  let dist = length(vec2f(distAlong, distAcross));
  if (dist > dotRadius) {
    discard;
  }
  let alpha = (1.0 - smoothstep(dotRadius * 0.45, dotRadius, dist)) * 0.95;
  return vec4f(input.color, alpha);
};
`;

const NO_REGIONS = new Float32Array(0);

export function createRenderer(device, format, options = {}) {
  const connectionStyle = options?.connectionStyle ?? 'lines';
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
  const dotModule = connectionStyle === 'dots' ? device.createShaderModule({ code: dotShader }) : null;
  const dotPipeline = connectionStyle === 'dots' ? device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: dotModule, entryPoint: 'vertex', buffers: [{
      arrayStride: 36,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'float32x3' },
        { shaderLocation: 3, offset: 28, format: 'float32' },
        { shaderLocation: 4, offset: 32, format: 'float32' },
      ],
    }] },
    fragment: { module: dotModule, entryPoint: 'fragment', targets: [{ format, blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } }] },
    primitive: { topology: 'triangle-list' },
  }) : null;
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uniforms = new Float32Array(8);
  let bindGroup;
  let dotBindGroup;
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
      if (graph?.connectionStyle && graph.connectionStyle !== connectionStyle) {
        throw new Error('Graph connection style does not match the renderer');
      }
      const rawArrays = graph ? [
        { data: graph.regions ?? NO_REGIONS, kind: 'regions' },
        { data: graph.edges, kind: 'edges' },
        { data: graph.nodes, kind: 'nodes' },
      ] : [];
      for (const item of rawArrays) {
        const data = item.data;
        const isDots = item.kind === 'edges' && connectionStyle === 'dots';
        const modulo = isDots ? 27 : 21;
        if (!(data instanceof Float32Array) || data.length % modulo !== 0) {
          throw new Error('Graph geometry must contain interleaved triangle vertices');
        }
        if (data.byteLength > device.limits.maxBufferSize) throw new Error('Graph exceeds the GPU buffer size limit');
        item.isDots = isDots;
        item.floatStride = isDots ? 9 : 7;
      }
      nextActivity ??= graph ? new EdgeActivity(graph.edgePairs, graph.nodeIndexMap ?? graph.nodeIds ?? graph.positions) : null;
      if (nextActivity && (nextActivity.starts.byteLength > device.limits.maxBufferSize ||
          nextActivity.starts.byteLength > device.limits.maxStorageBufferBindingSize)) {
        throw new Error('Graph activity exceeds the GPU storage buffer size limit');
      }
      const next = [];
      const nextBuffers = [];
      let nextActivityBuffer;
      let nextBindGroup;
      let nextDotBindGroup;
      let nextOverlayBuffer = null;
      let nextOverlayCount = 0;
      try {
        for (const item of rawArrays) {
          const data = item.data;
          if (!data.length) continue;
          const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          nextBuffers.push(buffer);
          next.push({
            buffer,
            count: data.length / item.floatStride,
            pipeline: item.isDots ? dotPipeline : pipeline,
          });
          device.queue.writeBuffer(buffer, 0, data);
        }
        if (nextActivity) {
          nextActivityBuffer = device.createBuffer({
            size: nextActivity.starts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          nextBuffers.push(nextActivityBuffer);
          device.queue.writeBuffer(nextActivityBuffer, 0, nextActivity.starts);
          const entries = [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: nextActivityBuffer } },
          ];
          nextBindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0), entries,
          });
          if (dotPipeline) {
            nextDotBindGroup = device.createBindGroup({
              layout: dotPipeline.getBindGroupLayout(0), entries,
            });
          }
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
      dotBindGroup = nextDotBindGroup;
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
      for (const { buffer, count, pipeline: itemPipeline } of current) {
        pass.setPipeline(itemPipeline);
        pass.setBindGroup(0, itemPipeline === dotPipeline ? dotBindGroup : bindGroup);
        pass.setVertexBuffer(0, buffer);
        pass.draw(count);
      }
      if (overlayBuffer && overlayCount > 0) {
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
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
