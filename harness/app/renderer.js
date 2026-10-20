const shader = `
struct Camera {
  center: vec2f,
  scale: f32,
  padding: f32,
  viewport: vec2f,
  padding2: vec2f,
};
@group(0) @binding(0) var<uniform> camera: Camera;
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};
@vertex fn vertex(@location(0) position: vec2f, @location(1) color: vec4f) -> Vertex {
  let clip = (position - camera.center) * camera.scale * 2.0 / camera.viewport;
  return Vertex(vec4f(clip.x, -clip.y, 0.0, 1.0), color);
}
@fragment fn fragment(input: Vertex) -> @location(0) vec4f {
  return input.color;
}`;

export function createRenderer(device, format) {
  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex', buffers: [{
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x4' },
      ],
    }] },
    fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } }] },
    primitive: { topology: 'triangle-list' },
  });
  const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let bindGroup;
  try {
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
  } catch (error) {
    uniform.destroy();
    throw error;
  }
  let current = [];
  let retired = [];
  let releasing = false;
  let disposed = false;
  const pending = new Set();
  const release = (buffers) => {
    for (const { buffer } of buffers) {
      buffer.destroy();
      pending.delete(buffer);
    }
  };
  const releaseRetired = async () => {
    if (releasing) return;
    releasing = true;
    while (retired.length) {
      const batch = retired;
      retired = [];
      // Submitted draws may still read the old mapping's buffers.
      try { await device.queue.onSubmittedWorkDone(); } catch { /* Device loss also releases their use. */ }
      if (!disposed) release(batch);
    }
    releasing = false;
  };
  return {
    setGraph(graph) {
      if (disposed) throw new Error('Renderer has been destroyed');
      const arrays = graph ? [graph.edges, graph.nodes] : [];
      for (const data of arrays) {
        if (!(data instanceof Float32Array) || data.length % 18 !== 0) {
          throw new Error('Graph geometry must contain interleaved triangle vertices');
        }
        if (data.byteLength > device.limits.maxBufferSize) throw new Error('Graph exceeds the GPU buffer size limit');
      }
      const next = [];
      try {
        for (const data of arrays) {
          if (!data.length) continue;
          const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
          next.push({ buffer, count: data.length / 6 });
          device.queue.writeBuffer(buffer, 0, data);
        }
      } catch (error) {
        release(next);
        throw error;
      }
      for (const { buffer } of next) pending.add(buffer);
      retired.push(...current);
      current = next;
      void releaseRetired();
    },
    draw(pass, camera) {
      if (disposed || !current.length) return;
      device.queue.writeBuffer(uniform, 0, new Float32Array([
        camera.centerX, camera.centerY, camera.scale, 0, camera.width, camera.height, 0, 0,
      ]));
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      for (const { buffer, count } of current) {
        pass.setVertexBuffer(0, buffer);
        pass.draw(count);
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      for (const buffer of pending) buffer.destroy();
      pending.clear();
      current = [];
      retired = [];
      uniform.destroy();
    },
  };
}
