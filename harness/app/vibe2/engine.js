import { createShaders } from "./shaders.js";

const unavailable = "WebGPU unavailable; open the workspace over HTTPS or localhost in a WebGPU browser";
const align = n => Math.ceil(n / 256) * 256;

/** Compile once, then submit exactly one command buffer per recurrent model step. */
export async function createVibe2Engine({ manifest, weights, gpu = globalThis.navigator?.gpu }) {
  if (!gpu) throw new Error(unavailable);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error(unavailable);
  const embed = manifest.tensors.find(t => t.name === "embed.weight");
  if (weights.byteLength > adapter.limits.maxBufferSize || embed.shape.reduce((a, b) => a * b, 4) > adapter.limits.maxStorageBufferBindingSize) {
    throw new Error("GPU limits too small for vibe2 weights");
  }
  const device = await adapter.requestDevice({ requiredLimits: {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  } });
  const buffers = [];
  const allocate = (size, usage, label) => {
    const buffer = device.createBuffer({ size: Math.max(16, size), usage, label });
    buffers.push(buffer); return buffer;
  };
  const storage = (size, label) => allocate(size, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label);
  const resource = (buffer, size = buffer.size, offset = 0) => ({ buffer, offset, size });
  try {
    device.pushErrorScope("validation");
    const weightBuffer = storage(weights.byteLength, "vibe2 weights");
    device.queue.writeBuffer(weightBuffer, 0, weights);
    const tensors = new Map(manifest.tensors.map(t => [t.name, resource(weightBuffer, t.shape.reduce((a, b) => a * b, 4), t.offset)]));
    const c = manifest.config;
    const H = 3 * c.heads_per_lobe, C = H * c.d_head, d = c.d_model, K = c.n_kc;
    const sizes = { h: d, u: d, v: C, z: C, x: C, r: c.n_glom, gbar: c.n_glom, kc: K, code: K, k: K, lobeSum: 3, dopamine: H, y: C, mbar: C, hf: d, logits: c.vocab_size };
    const scratch = Object.fromEntries(Object.entries(sizes).map(([key, count]) => [key, storage(count * 4, key)]));
    const r = key => resource(scratch[key]);
    const dummy = resource(storage(16, "unused parameter"));
    const convStride = align(C * 3 * 4), memoryStride = align(K * c.heads_per_lobe * c.d_head * 4);
    const conv = storage(c.n_layer * convStride, "conv state");
    const memory = storage(c.n_layer * memoryStride, "memory state");
    const tokenUniform = allocate(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "token");
    const codeStage = allocate(K * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "code readback");
    const logitsStage = allocate(c.vocab_size * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, "logits readback");
    const source = createShaders(c, manifest.lobes);
    const pipelines = {};
    for (const [key, code] of Object.entries(source)) {
      const module = device.createShaderModule({ code, label: key });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(m => m.type === "error");
      if (errors.length) throw new Error(`WGSL ${key}: ${errors.map(m => m.message).join("; ")}`);
      pipelines[key] = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" }, label: key });
    }
    const command = (key, resources, groups) => {
      const pipeline = pipelines[key];
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources.map((resource, binding) => ({ binding, resource })) });
      return { pipeline, bindGroup, groups };
    };
    const gemv = (weight, input, output, rows, cols, mode = 0, bias = dummy, cap = dummy) => {
      const uniform = allocate(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "gemv parameters");
      device.queue.writeBuffer(uniform, 0, new Uint32Array([rows, cols, mode, 0]));
      return command("gemv", [weight, input, bias, cap, output, resource(uniform)], Math.ceil(rows / 64));
    };
    const embedCommand = command("embed", [tensors.get("embed.weight"), r("h"), resource(tokenUniform)], Math.ceil(d / 64));
    const blocks = Array.from({ length: c.n_layer }, (_, b) => {
      const t = name => tensors.get(`blocks.${b}.${name}`);
      const s = resource(memory, K * c.heads_per_lobe * c.d_head * 4, b * memoryStride);
      return [
        command("norm", [r("h"), t("norm.weight"), r("u")], 1),
        gemv(t("mixer.W_v.weight"), r("u"), r("v"), C, d),
        gemv(t("mixer.W_z.weight"), r("u"), r("z"), C, d),
        gemv(t("mixer.addr.receptors.weight"), r("u"), r("r"), c.n_glom, d, 1, t("mixer.addr.receptors.bias")),
        gemv(t("mixer.dopamine.linear.weight"), r("u"), r("dopamine"), H, d, 2, t("mixer.dopamine.linear.bias"), t("mixer.cap")),
        command("glom", [r("r"), t("mixer.addr.glom_scale"), r("gbar")], 1),
        command("kcDrive", [t("mixer.addr.wiring"), r("gbar"), r("kc")], Math.ceil(K / 64)),
        command("topk", [r("kc"), r("code"), r("k"), r("lobeSum")], 1),
        command("conv", [t("mixer.conv.weight"), t("mixer.conv.bias"), r("v"), resource(conv, C * 3 * 4, b * convStride), r("x")], Math.ceil(C / 64)),
        command("memRead", [s, r("k"), r("lobeSum"), r("x"), t("mixer.D"), r("y")], H),
        command("memWrite", [s, r("k"), r("dopamine"), t("mixer.recovery"), r("x")], Math.ceil(K * c.heads_per_lobe * c.d_head / 64)),
        command("mixNorm", [r("y"), t("mixer.out_norm.weight"), r("mbar"), r("z")], 1),
        gemv(t("mixer.out_proj.weight"), r("mbar"), r("h"), d, C, 3),
      ];
    });
    const final = [command("finalNorm", [r("h"), tensors.get("norm_f.weight"), r("hf")], 1), gemv(tensors.get("embed.weight"), r("hf"), r("logits"), c.vocab_size, d)];
    const validation = await device.popErrorScope();
    if (validation) throw new Error(validation.message);
    let destroyed = false;
    const dispatch = (pass, commands) => {
      for (const { pipeline, bindGroup, groups } of commands) {
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.dispatchWorkgroups(groups);
      }
    };
    return {
      lost: device.lost,
      reset() {
        const encoder = device.createCommandEncoder(); encoder.clearBuffer(conv); encoder.clearBuffer(memory);
        device.queue.submit([encoder.finish()]);
      },
      async step(tokenId, { logits = true } = {}) {
        if (destroyed) throw new Error("Engine disposed");
        device.queue.writeBuffer(tokenUniform, 0, new Uint32Array([tokenId, 0, 0, 0]));
        const encoder = device.createCommandEncoder();
        const a = encoder.beginComputePass(); dispatch(a, [embedCommand, ...blocks[0]]); a.end();
        encoder.copyBufferToBuffer(scratch.code, 0, codeStage, 0, K * 4);
        const b = encoder.beginComputePass();
        for (let i = 1; i < blocks.length; i++) dispatch(b, blocks[i]);
        if (logits) dispatch(b, final);
        b.end();
        if (logits) encoder.copyBufferToBuffer(scratch.logits, 0, logitsStage, 0, c.vocab_size * 4);
        device.queue.submit([encoder.finish()]);
        await Promise.all([codeStage.mapAsync(GPUMapMode.READ), ...(logits ? [logitsStage.mapAsync(GPUMapMode.READ)] : [])]);
        const code = new Float32Array(codeStage.getMappedRange().slice(0, K * 4)); codeStage.unmap();
        let output = null;
        if (logits) { output = new Float32Array(logitsStage.getMappedRange().slice(0, c.vocab_size * 4)); logitsStage.unmap(); }
        return { logits: output, code };
      },
      destroy() { destroyed = true; for (const buffer of buffers) buffer.destroy(); device.destroy(); },
    };
  } catch (error) {
    for (const buffer of buffers) buffer.destroy(); device.destroy(); throw error;
  }
}
