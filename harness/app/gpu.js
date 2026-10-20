// One cleared viewport establishes the device lifecycle; graph pipelines belong to #2.
export async function initializeGPU(canvas, onStatus) {
  if (!globalThis.isSecureContext || !navigator.gpu) {
    onStatus("WebGPU unavailable. Use a supported browser at http://127.0.0.1; stream inspection still works.");
    return () => {};
  }
  let device;
  let observer;
  let disposed = false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available");
    device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Cannot create a WebGPU canvas context");
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });
    const draw = () => {
      if (disposed) return;
      const scale = Math.min(device.limits.maxTextureDimension2D / Math.max(canvas.clientWidth, canvas.clientHeight, 1), window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.04, g: 0.07, b: 0.1, a: 1 },
        loadOp: "clear", storeOp: "store",
      }] });
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    observer = new ResizeObserver(() => {
      try { draw(); } catch { onStatus("WebGPU rendering failed. Reload to retry."); }
    });
    observer.observe(canvas);
    device.addEventListener("uncapturederror", () => {
      if (!disposed) onStatus("WebGPU reported an error. Reload to retry.");
    });
    device.lost.then(() => {
      if (!disposed) {
        disposed = true;
        observer.disconnect();
        onStatus("WebGPU device lost. Reload to retry; stream inspection still works.");
      }
    });
    draw();
    onStatus("WebGPU ready. Viewport initialized; awaiting the graph renderer.");
  } catch (error) {
    disposed = true;
    observer?.disconnect();
    device?.destroy();
    onStatus(`WebGPU unavailable: ${error.message}. Stream inspection still works.`);
  }
  return () => {
    disposed = true;
    observer?.disconnect();
    device?.destroy();
  };
}
