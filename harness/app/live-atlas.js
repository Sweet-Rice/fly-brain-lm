import { ProtocolReceiver } from "./protocol.js";
import { LiveSource } from "./sources.js";
import { initializeGPU } from "./gpu.js";
import { mountInspector } from "./inspector.js";
import { mountReadout } from "./readout-view.js";
import { groupStyle } from "./brain-atlas.js";

function resolveEndpoint(endpoint) {
  if (endpoint) return endpoint;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/stream`;
}

export function mountLiveAtlas(options) {
  const { canvas, labels, inspector, readout: readoutRoot, onState, WebSocketType } = options;
  const endpoint = resolveEndpoint(options.endpoint);

  let disposed = false;
  const receiver = new ProtocolReceiver();
  let connectionState = "connecting";
  let connectionMessage = `Connecting to ${endpoint}`;
  let gpuMessage = "Initializing WebGPU...";
  let acceptedFires = 0;
  let droppedMessages = 0;
  let droppedPairs = 0;

  let cachedNodeCount = 0;
  let cachedEdgeCount = 0;
  let cachedGroups = Object.freeze([]);

  function updateMappingCache() {
    const mapping = receiver.mapping;
    if (!mapping) {
      cachedNodeCount = 0;
      cachedEdgeCount = 0;
      cachedGroups = Object.freeze([]);
      return;
    }
    cachedNodeCount = Array.isArray(mapping.nodes) ? mapping.nodes.length : 0;
    cachedEdgeCount = Array.isArray(mapping.edges) ? mapping.edges.length : 0;

    const counts = new Map((mapping.groups ?? []).map((group) => [group.id, 0]));
    for (const node of mapping.nodes ?? []) {
      counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    }

    const groups = (mapping.groups ?? []).map((group, index) => {
      const style = groupStyle(group, index);
      const [r = 0.5, g = 0.5, b = 0.5] = style.color || [];
      const color = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
      return Object.freeze({
        id: group.id,
        name: typeof group.name === "string" ? group.name : `Group ${group.id}`,
        color,
        placement: style.placement || "Grouped grid",
        count: counts.get(group.id) ?? 0,
      });
    });
    cachedGroups = Object.freeze(groups);
  }

  function createSnapshot() {
    return Object.freeze({
      connectionState,
      connectionMessage,
      gpuMessage,
      nodeCount: cachedNodeCount,
      edgeCount: cachedEdgeCount,
      groups: cachedGroups,
      lastStep: receiver.lastT ?? null,
      acceptedFires,
      droppedMessages,
      droppedPairs,
    });
  }

  const requestFrame = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 16);

  const cancelFrame = typeof cancelAnimationFrame === "function"
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);

  let publishScheduled = false;
  let publishHandle = null;

  function emitSnapshot() {
    if (disposed) return;
    onState(createSnapshot());
  }

  function schedulePublish() {
    if (disposed || publishScheduled) return;
    publishScheduled = true;
    publishHandle = requestFrame(() => {
      publishScheduled = false;
      publishHandle = null;
      if (disposed) return;
      emitSnapshot();
    });
  }

  function cancelScheduledPublish() {
    if (publishScheduled) {
      cancelFrame(publishHandle);
      publishScheduled = false;
      publishHandle = null;
    }
  }

  function clearDisplay() {
    acceptedFires = 0;
    droppedMessages = 0;
    droppedPairs = 0;
    updateMappingCache();
    canvas.dispatchEvent(new Event("reset"));
  }

  function onEvent(event) {
    if (disposed) return;
    if (event.action === "replace_mapping") {
      acceptedFires = 0;
      droppedMessages = 0;
      droppedPairs = 0;
      updateMappingCache();
      canvas.dispatchEvent(new CustomEvent("mapping", { detail: receiver.mapping }));
      cancelScheduledPublish();
      emitSnapshot();
    } else if (event.action === "accept_fire") {
      acceptedFires++;
      if (Array.isArray(event.dropped_pairs)) {
        droppedPairs += event.dropped_pairs.length;
      }
      canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: event.t, pairs: event.pairs } }));
      schedulePublish();
    } else if (event.action === "accept_telemetry") {
      canvas.dispatchEvent(new CustomEvent("telemetry", { detail: event.message }));
    } else if (event.action === "drop_message") {
      droppedMessages++;
      schedulePublish();
      clearDisplay();
      cancelScheduledPublish();
      emitSnapshot();
    }
  }

  function onStatus({ state, message }) {
    if (disposed) return;
    connectionState = state || "disconnected";
    connectionMessage = message || "";

    if (["connecting", "reconnecting", "disconnected", "background"].includes(state)) {
      clearDisplay();
    } else if (state === "unsupported") {
      updateMappingCache();
    }
    cancelScheduledPublish();
    emitSnapshot();
  }

  const live = new LiveSource(receiver, { onEvent, onStatus }, WebSocketType);
  const disposeInspector = mountInspector(inspector, canvas);
  const readout = readoutRoot ? mountReadout(readoutRoot, canvas) : null;

  const gpuAbortController = new AbortController();
  let disposeGPU = null;

  const gpuReady = initializeGPU(
    canvas,
    (message) => {
      if (disposed) return;
      gpuMessage = message || "";
      cancelScheduledPublish();
      emitSnapshot();
    },
    labels,
    { signal: gpuAbortController.signal }
  );

  gpuReady.then(
    (disposer) => {
      if (disposed) {
        disposer?.();
        return;
      }
      disposeGPU = disposer;
    }
  );

  emitSnapshot();

  try {
    live.connect(endpoint);
  } catch (error) {
    connectionState = "error";
    connectionMessage = error.message;
    emitSnapshot();
  }

  const handle = {
    ensureConnected() {
      if (disposed) return;
      try {
        const isLiveActive = Boolean(
          live &&
          (
            (live.socket && !live.socket.closed && (typeof live.socket.readyState !== "number" || live.socket.readyState <= 1)) ||
            live.retryTimer !== null
          )
        );
        if (!isLiveActive || !live.url || live.url !== endpoint) {
          live.connect(endpoint);
        }
      } catch (error) {
        connectionState = "error";
        connectionMessage = error.message;
        emitSnapshot();
      }
    },

    connect() {
      if (disposed) return;
      try {
        live.connect(endpoint);
      } catch (error) {
        connectionState = "error";
        connectionMessage = error.message;
        emitSnapshot();
      }
    },

    disconnect() {
      if (disposed) return;
      live.disconnect();
    },

    fit() {
      if (disposed) return;
      canvas.dispatchEvent(new Event("fit"));
    },

    zoom(factor) {
      if (disposed) return;
      canvas.dispatchEvent(new CustomEvent("zoom", { detail: factor }));
    },

    setGeneration(state) {
      if (!disposed) readout?.setGeneration(state);
    },

    dispose() {
      if (disposed) return;
      disposed = true;

      cancelScheduledPublish();
      gpuAbortController.abort();
      disposeGPU?.();
      disposeInspector();
      readout?.dispose();
      live.dispose();
      labels?.replaceChildren();
    },
  };

  return handle;
}
