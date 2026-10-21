import { buildGraph } from "./layout.js";
import { createRenderer } from "./renderer.js";
import { Camera } from "./camera.js";
import { EdgeActivity } from "./activity.js";

export async function initializeGPU(canvas, onStatus, labels = null) {
  let mapping = null, graph = null, activity = null, renderer, device, context, observer;
  let disposed = false, frame = null, drag = null;
  let busy = false, dirty = false, mappingPending = true, resizePending = true;
  const camera = new Camera(canvas.clientWidth, canvas.clientHeight);
  const listeners = [];
  const motion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  const listen = (type, handler, options) => {
    canvas.addEventListener(type, handler, options);
    listeners.push(() => canvas.removeEventListener(type, handler, options));
  };

  function draw(now = performance.now()) {
    if (disposed || !renderer) return;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0.04, g: 0.07, b: 0.1, a: 1 },
      loadOp: "clear", storeOp: "store",
    }] });
    renderer.draw(pass, camera, now, motion?.matches ?? false);
    pass.end();
    device.queue.submit([encoder.finish()]);
    if (labels && graph) {
      graph.labels.forEach((label, index) => {
        const point = camera.worldToScreen(label.x, label.y);
        const element = labels.children[index];
        element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -100%)`;
        element.style.maxWidth = `${Math.max(48, label.width * camera.scale - 8)}px`;
      });
    }
  }

  function invalidate() {
    dirty = true;
    if (disposed || !renderer || frame !== null || busy || document.visibilityState === "hidden") return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed || document.visibilityState === "hidden") return;
      dirty = false;
      try {
        if (mappingPending) {
          mappingPending = false;
          installMapping();
        }
        if (resizePending) {
          resizePending = false;
          const scale = Math.min(device.limits.maxTextureDimension2D / Math.max(canvas.clientWidth, canvas.clientHeight, 1), window.devicePixelRatio || 1);
          canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
          canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
          camera.resize(canvas.clientWidth, canvas.clientHeight);
        }
        const now = performance.now();
        draw(now);
        const animate = renderer.isActive(now);
        busy = true;
        device.queue.onSubmittedWorkDone().then(() => {
          busy = false;
          if (!disposed && (dirty || animate)) invalidate();
        }, () => {
          busy = false;
          if (!disposed) onStatus("WebGPU rendering failed. Reload to retry.");
        });
      } catch { onStatus("WebGPU rendering failed. Reload to retry."); }
    });
  }

  function installMapping() {
    if (disposed || !renderer) return;
    try {
      const next = mapping ? buildGraph(mapping) : null;
      renderer.setGraph(next, activity);
      graph = next;
      camera.fit(graph?.bounds);
      if (labels) {
        labels.replaceChildren(...(graph?.labels ?? []).map((label) => {
          const element = document.createElement("span");
          element.textContent = label.name;
          element.title = label.name;
          element.style.color = `rgb(${label.color.map(value => Math.round(value * 255)).join(" ")})`;
          return element;
        }));
      }
      onStatus(graph
        ? `WebGPU ready. Drawing ${graph.nodeCount} nodes and ${graph.edgeCount} directed edges.`
        : "WebGPU ready. Waiting for a mapping.");
    } catch (error) {
      renderer.setGraph(null);
      graph = null;
      labels?.replaceChildren();
      onStatus(`Cannot render this mapping: ${error.message}`);
    }
  }

  // Register before adapter/device awaits so fast file or live input is retained.
  listen("mapping", ({ detail }) => {
    mapping = detail;
    activity = new EdgeActivity(mapping.edges);
    mappingPending = true;
    invalidate();
  });
  listen("reset", () => { mapping = activity = null; drag = null; mappingPending = true; invalidate(); });
  listen("fire", ({ detail }) => {
    if (!activity || disposed) return;
    const now = performance.now();
    if (activity.fire(detail.pairs, now)) invalidate();
  });
  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    } else invalidate();
  };
  document.addEventListener?.("visibilitychange", visibilityChanged);
  listeners.push(() => document.removeEventListener?.("visibilitychange", visibilityChanged));
  const motionChanged = () => invalidate();
  motion?.addEventListener("change", motionChanged);
  listeners.push(() => motion?.removeEventListener("change", motionChanged));
  listen("fit", () => { camera.fit(graph?.bounds); invalidate(); });
  listen("zoom", ({ detail }) => { camera.zoom(detail); invalidate(); });
  listen("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    camera.zoom(Math.exp(-event.deltaY * 0.001), event.clientX - rect.left, event.clientY - rect.top);
    invalidate();
  }, { passive: false });
  listen("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  listen("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    camera.pan(event.clientX - drag.x, event.clientY - drag.y);
    drag.x = event.clientX;
    drag.y = event.clientY;
    invalidate();
  });
  const stopDrag = () => { drag = null; };
  listen("pointerup", stopDrag);
  listen("pointercancel", stopDrag);
  listen("lostpointercapture", stopDrag);
  listen("keydown", (event) => {
    const moves = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
    if (moves[event.key]) camera.pan(...moves[event.key]);
    else if (event.key === "+" || event.key === "=") camera.zoom(1.25);
    else if (event.key === "-") camera.zoom(0.8);
    else if (event.key === "0" || event.key === "Home") camera.fit(graph?.bounds);
    else return;
    event.preventDefault();
    invalidate();
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    for (const remove of listeners.splice(0)) remove();
    renderer?.destroy();
    context?.unconfigure?.();
    device?.destroy();
    labels?.replaceChildren();
  };
  if (!globalThis.isSecureContext || !navigator.gpu) {
    onStatus("WebGPU unavailable. Use a supported browser at http://127.0.0.1; stream inspection still works.");
    return dispose;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No WebGPU adapter is available");
    device = await adapter.requestDevice();
    context = canvas.getContext("webgpu");
    if (!context) throw new Error("Cannot create a WebGPU canvas context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    renderer = createRenderer(device, format);
    observer = new ResizeObserver(() => { resizePending = true; invalidate(); });
    observer.observe(canvas);
    device.addEventListener("uncapturederror", () => {
      if (!disposed) onStatus("WebGPU reported an error. Reload to retry.");
    });
    device.lost.then(() => {
      if (!disposed) {
        dispose();
        onStatus("WebGPU device lost. Reload to retry; stream inspection still works.");
      }
    });
    invalidate();
  } catch (error) {
    dispose();
    onStatus(`WebGPU unavailable: ${error.message}. Stream inspection still works.`);
  }
  return dispose;
}
