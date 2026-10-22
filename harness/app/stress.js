// Development-only benchmark; the application has no dependency on this page.
const element = id => document.getElementById(id);
const status = element('status');
let stopped = false;
let hiddenTransitions = 0;
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenTransitions++; });
element('stop').addEventListener('click', () => { stopped = true; });
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const summary = samples => {
  const sorted = samples.sort((a, b) => a - b);
  return { p50_ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95_ms: sorted[Math.floor(sorted.length * .95)] ?? 0 };
};

function trackDevice(device) {
  const stats = { created: 0, live: 0, peak_live: 0, bytes: 0, peak_bytes: 0, writes: 0, written_bytes: 0 };
  const queue = new Proxy(device.queue, { get(target, property) {
    if (property === 'writeBuffer') return (buffer, offset, data, ...rest) => {
      stats.writes++;
      stats.written_bytes += data.byteLength;
      return target.writeBuffer(buffer, offset, data, ...rest);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const tracked = new Proxy(device, { get(target, property) {
    if (property === 'queue') return queue;
    if (property === 'createBuffer') return descriptor => {
      const buffer = target.createBuffer(descriptor);
      stats.created++;
      stats.live++;
      stats.bytes += descriptor.size;
      stats.peak_live = Math.max(stats.peak_live, stats.live);
      stats.peak_bytes = Math.max(stats.peak_bytes, stats.bytes);
      const destroy = buffer.destroy.bind(buffer);
      let destroyed = false;
      buffer.destroy = () => {
        if (!destroyed) {
          destroyed = true;
          stats.live--;
          stats.bytes -= descriptor.size;
          destroy();
        }
      };
      return buffer;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { tracked, stats };
}

async function run(sustained) {
  stopped = false;
  hiddenTransitions = 0;
  element('benchmark').disabled = element('sustained').disabled = true;
  element('stop').disabled = false;
  element('results').textContent = '';
  let device, renderer, context, stats, gpuError;
  try {
    const base = new URL(element('modules').value, location.href);
    if (base.origin !== location.origin) throw new Error('Module directory must be on this server');
    const load = name => import(new URL(name, base));
    const [{ buildGraph }, { createRenderer }, { Camera }, { ProtocolReceiver }] = await Promise.all([
      load('layout.js'), load('renderer.js'), load('camera.js'), load('protocol.js'),
    ]);
    status.textContent = 'Loading the real mapping and requesting WebGPU…';
    const lines = (await (await fetch('../example/once_upon_a_time.ndjson')).text()).trim().split('\n');
    const receiver = new ProtocolReceiver();
    receiver.process(lines[0]);
    const fires = lines.slice(1).map(JSON.parse);
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter unavailable');
    device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', event => { gpuError = event.error; stopped = true; });
    const tracked = trackDevice(device);
    stats = tracked.stats;
    const canvas = element('graph');
    context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    renderer = createRenderer(tracked.tracked, format);
    const start = performance.now();
    const graph = buildGraph(receiver.mapping);
    const layoutMs = performance.now() - start;
    const uploadStart = performance.now();
    renderer.setGraph(graph);
    const uploadCpuMs = performance.now() - uploadStart;
    await device.queue.onSubmittedWorkDone();
    const uploadFenceMs = performance.now() - uploadStart;
    const camera = new Camera(canvas.width, canvas.height);
    camera.fit(graph.bounds);
    const cpu = [], fence = [], gaps = [];
    const initialBuffers = stats.created;
    let replacements = 0, events = 0, frames = 0, previous;
    function draw(now) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(), clearValue: { r: .04, g: .07, b: .1, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }] });
      renderer.draw(pass, camera, now);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    // One burst followed by one draw isolates per-event uploads from per-frame uploads.
    const burstWrites = stats.writes;
    for (let index = 0; index < 1000; index++) renderer.fire(fires[index % fires.length].pairs, performance.now());
    draw(performance.now());
    await device.queue.onSubmittedWorkDone();
    const writesPer1000EventBurst = stats.writes - burstWrites;
    for (let index = 0; index < (sustained ? 600 : 120) && !stopped; index++) {
      const now = await frame();
      if (stopped) break;
      if (previous !== undefined) gaps.push(now - previous);
      previous = now;
      const tick = performance.now();
      for (let event = 0; event < (sustained ? 10 : 1); event++) {
        renderer.fire(fires[events++ % fires.length].pairs, now);
      }
      if (sustained && index % 30 === 29) { renderer.setGraph(graph); replacements++; }
      camera.pan(Math.sin(index / 10), 0);
      draw(now);
      cpu.push(performance.now() - tick);
      const submitted = performance.now();
      await device.queue.onSubmittedWorkDone();
      fence.push(performance.now() - submitted);
      frames++;
      if (index % 30 === 0) status.textContent = `Running: ${frames} frames, ${events} fires, ${stats.live} live buffers, ${stats.bytes} bytes.`;
    }
    const steadyBuffers = stats.live;
    // A synchronous replacement burst exposes retired-buffer retention without timing guesses.
    for (let index = 0; index < 50; index++) renderer.setGraph(graph);
    replacements += 50;
    await device.queue.onSubmittedWorkDone();
    await Promise.resolve();
    if (gpuError) throw gpuError;
    const settledBuffers = stats.live;
    renderer.destroy();
    element('results').textContent = JSON.stringify({
      modules: base.pathname, adapter: Object.fromEntries(
        ['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map(key => [key, adapter.info?.[key]])),
      user_agent: navigator.userAgent, nodes: graph.nodeCount, edges: graph.edgeCount,
      layout_ms: layoutMs, gpu_upload_cpu_ms: uploadCpuMs, gpu_upload_with_fence_ms: uploadFenceMs,
      events, frames, replacements, cpu_fire_and_submit: summary(cpu),
      submitted_work_fence: summary(fence), animation_frame_gap: summary(gaps),
      writes_per_1000_event_burst: writesPer1000EventBurst,
      static_buffer_creations_during_activity: stats.created - initialBuffers
        - replacements * ([graph.regions, graph.edges, graph.nodes].filter(data => data?.length).length + 1),
      steady_live_buffers: steadyBuffers, settled_live_buffers: settledBuffers,
      hidden_transitions: hiddenTransitions, buffers: stats,
    }, null, 2);
    status.textContent = stopped ? 'Stopped; resources released.' : 'Complete; resources released.';
  } catch (error) {
    status.textContent = `Benchmark failed: ${error.message}`;
  } finally {
    renderer?.destroy();
    context?.unconfigure();
    device?.destroy();
    element('benchmark').disabled = element('sustained').disabled = false;
    element('stop').disabled = true;
  }
}
element('benchmark').addEventListener('click', () => void run(false));
element('sustained').addEventListener('click', () => void run(true));
