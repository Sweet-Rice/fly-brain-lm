import { buildGraph, RADIUS } from "./layout.js";
import { createRenderer } from "./renderer.js";
import { Camera } from "./camera.js";
import { EdgeActivity } from "./activity.js";

export function pickNode(graph, camera, clientX, clientY, rect = { left: 0, top: 0 }) {
  if (!graph?.positions || graph.positions.size === 0) return null;
  const screenX = (clientX ?? 0) - (rect.left || 0);
  const screenY = (clientY ?? 0) - (rect.top || 0);
  const maxScreenDist = Math.max(RADIUS * camera.scale + 2, 8);
  const maxScreenDistSq = maxScreenDist * maxScreenDist;
  let minScreenDistSq = Infinity;
  let closestId = null;

  for (const [id, pos] of graph.positions) {
    const screenNodeX = (pos.x - camera.centerX) * camera.scale + camera.width / 2;
    const screenNodeY = (pos.y - camera.centerY) * camera.scale + camera.height / 2;
    const dx = screenNodeX - screenX;
    const dy = screenNodeY - screenY;
    const distSq = dx * dx + dy * dy;
    if (distSq <= maxScreenDistSq && distSq < minScreenDistSq) {
      minScreenDistSq = distSq;
      closestId = id;
    }
  }
  return closestId;
}
export async function initializeGPU(canvas, onStatus, labels = null) {
  let mapping = null, graph = null, activity = null, renderer, device, context, observer;
  let disposed = false, frame = null, drag = null;
  let busy = false, dirty = false, mappingPending = true, resizePending = true;
  let selectedId = null;
  let lastPickTime = 0;
  let lastDragTime = 0;
  const DRAG_THRESHOLD = 4;
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
      clearValue: { r: 0.039, g: 0.051, b: 0.071, a: 1 },
      loadOp: "clear", storeOp: "store",
    }] });
    renderer.draw(pass, camera, now, motion?.matches ?? false);
    pass.end();
    device.queue.submit([encoder.finish()]);
    if (labels && graph) {
      // Grid labels stay within their group column; brain callouts sit in free space and stay whole.
      const clampToColumn = !graph.regions?.length;
      graph.labels.forEach((label, index) => {
        const point = camera.worldToScreen(label.x, label.y);
        const element = labels.children[index];
        element.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -100%)`;
        element.style.maxWidth = clampToColumn ? `${Math.max(48, label.width * camera.scale - 8)}px` : "";
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

  // Lets the page show schematic-only chrome exactly when the brain template is drawn.
  function markLayout(drawn) {
    if (drawn) canvas.dataset.layout = drawn.regions?.length ? "brain" : "grid";
    else delete canvas.dataset.layout;
  }

  function installMapping() {
    if (disposed || !renderer) return;
    try {
      const next = mapping ? buildGraph(mapping) : null;
      renderer.setGraph(next, activity);
      graph = next;
      markLayout(graph);
      if (selectedId !== null) {
        try {
          renderer.setSelectedNode(selectedId, graph);
        } catch {
          // Allocation failure preserves prior valid state
        }
      }
      camera.fit(graph?.bounds);
      if (labels) {
        labels.replaceChildren(...(graph?.labels ?? []).map((label) => {
          const element = document.createElement("span");
          element.className = "graph-callout";
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
      markLayout(null);
      labels?.replaceChildren();
      onStatus(`Cannot render this mapping: ${error.message}`);
    }
  }

  // Register before adapter/device awaits so fast file or live input is retained.
  listen("mapping", ({ detail }) => {
    if (mapping !== null || graph !== null) {
      selectedId = null;
      renderer?.setSelectedNode(null, null);
    }
    mapping = detail;
    activity = new EdgeActivity(mapping.edges);
    mappingPending = true;
    invalidate();
  });
  listen("reset", () => {
    selectedId = null;
    renderer?.setSelectedNode(null, null);
    mapping = activity = null;
    drag = null;
    mappingPending = true;
    invalidate();
  });
  listen("select-node", ({ detail }) => {
    const id = detail?.id !== undefined ? detail.id : (typeof detail === "number" ? detail : null);
    try {
      renderer?.setSelectedNode(id, graph);
      selectedId = id;
    } catch {
      // Allocation failure preserves prior valid selection
    }
    invalidate();
  });
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
  function pick(clientX, clientY) {
    if (disposed || !graph) return;
    lastPickTime = performance.now();
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const closestId = pickNode(graph, camera, clientX, clientY, rect);
    try {
      renderer?.setSelectedNode(closestId, graph);
      selectedId = closestId;
    } catch {
      // Allocation failure preserves prior valid selection
    }
    invalidate();
    canvas.dispatchEvent(new CustomEvent("node-select", { detail: { id: closestId } }));
  }

  listen("pointerdown", (event) => {
    if (event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(event.pointerId);
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  });
  listen("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD) {
      drag.moved = true;
    }
    camera.pan(dx, dy);
    drag.x = event.clientX;
    drag.y = event.clientY;
    invalidate();
  });
  const stopDrag = (event) => {
    if (drag && (event?.pointerId === undefined || event.pointerId === drag.id)) {
      if (drag.moved) {
        lastDragTime = performance.now();
      } else {
        pick(event?.clientX ?? drag.startX, event?.clientY ?? drag.startY);
      }
      drag = null;
    }
  };
  listen("pointerup", stopDrag);
  listen("pointercancel", () => {
    if (drag?.moved) lastDragTime = performance.now();
    drag = null;
  });
  listen("lostpointercapture", () => {
    if (drag?.moved) lastDragTime = performance.now();
    drag = null;
  });
  listen("click", (event) => {
    if (performance.now() - lastPickTime < 100 || performance.now() - lastDragTime < 100) return;
    pick(event.clientX, event.clientY);
  });
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
    markLayout(null);
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
