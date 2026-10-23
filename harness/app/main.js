import { ProtocolReceiver } from "./protocol.js";
import { LiveSource } from "./sources.js";
import { initializeGPU } from "./gpu.js";
import { mountPrompt } from "./prompt-view.js";
import { mountInspector } from "./inspector.js";
import { mountReadout } from "./readout-view.js";
import { GenerationController } from "./generation.js";

const receiver = new ProtocolReceiver();
const element = (id) => document.getElementById(id);
const canvas = element("viewport");
let fires = 0;
let disposed = false;
let connection = { ready: false, message: "Connecting to the model…" };
const connectionListeners = new Set();
const startupAbort = new AbortController();
const readout = mountReadout(element("readout-workspace"), canvas);
const generation = new GenerationController();
let health = generation.getState().health;
const unsubscribeGeneration = generation.subscribe((state) => {
  health = state.health;
  readout.setGeneration(state);
  renderConnection();
});

function setView(view) {
  element("workspace-shell").setAttribute("data-view", view);
  for (const name of ["brain", "generate", "inspector"]) {
    element(`view-${name}`).setAttribute("aria-pressed", String(name === view));
  }
  element("workbench").hidden = view === "brain";
  for (const [name, id] of Object.entries({
    generate: "prompt-panel",
    inspector: "inspector-panel-section",
  })) element(id).hidden = name !== view;
}

for (const name of ["brain", "generate", "inspector"]) {
  element(`view-${name}`).addEventListener("click", () => setView(name));
}
canvas?.addEventListener("node-select", ({ detail }) => {
  if (detail?.id != null) setView("inspector");
});

function renderMapping(mapping = receiver.mapping) {
  element("nodes").textContent = mapping?.nodes.length ?? 0;
  element("edges").textContent = mapping?.edges.length ?? 0;
}

function renderCounters() {
  element("step").textContent = receiver.lastT ?? "—";
  element("fires").textContent = fires;
}

function clearDisplay() {
  fires = 0;
  renderMapping(null);
  readout.reset();
  element("step").textContent = "—";
  element("fires").textContent = 0;
  canvas.dispatchEvent(new Event("reset"));
}

function onEvent(event, raw) {
  if (disposed) return;
  if (event.action === "replace_mapping") {
    fires = 0;
    readout.reset();
    renderMapping();
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: receiver.mapping }));
    setConnection(true, "Live graph connected");
  } else if (event.action === "accept_fire") {
    fires++;
    canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: event.t, pairs: event.pairs } }));
  } else if (event.action === "ignore_message" && receiver.mapping) {
    readout.accept(raw);
    return;
  } else if (event.action === "close") {
    clearDisplay();
    setConnection(false, "The model stream uses an unsupported protocol.");
  }
  renderCounters();
}

const live = new LiveSource(receiver, {
  onEvent,
  onStatus({ state, message }) {
    if (disposed) return;
    if (state === "connected") {
      setConnection(false, "Waiting for the model's graph mapping…");
    } else {
      clearDisplay();
      setConnection(false, message);
    }
  },
});


function renderConnection() {
  const status = element("source-status");
  const model = health.modelId;
  status.textContent = model
    ? `${model} · ${connection.message}${health.ready ? "" : " · model API unavailable"}`
    : connection.message;
  status.title = status.textContent;
  status.dataset.ready = String(connection.ready && health.ready);
}

function setConnection(ready, message) {
  connection = { ready, message };
  renderConnection();
  for (const listener of connectionListeners) listener({ ...connection });
}

function subscribeConnection(listener) {
  connectionListeners.add(listener);
  listener({ ...connection });
  return () => connectionListeners.delete(listener);
}

function handleGenerate() {
  if (!connection.ready || !receiver.mapping || live.socket?.readyState !== 1) {
    throw new Error("The live model graph is disconnected. Generation is disabled until it reconnects.");
  }
}

async function connectApp() {
  try {
    const response = await fetch("/app-config", { cache: "no-store", signal: startupAbort.signal });
    if (!response.ok) throw new Error(`App connection configuration unavailable (HTTP ${response.status}).`);
    const config = await response.json();
    if (disposed) return;
    if (typeof config.stream_url !== "string" || !config.stream_url.trim()) {
      throw new Error("No model stream is configured. Start the app server with --model-ckpt.");
    }
    const stream = new URL(config.stream_url, globalThis.location.href);
    if (stream.protocol === "http:") stream.protocol = "ws:";
    if (stream.protocol === "https:") stream.protocol = "wss:";
    if (!["ws:", "wss:"].includes(stream.protocol)) throw new Error("The configured model stream URL is invalid.");
    live.connect(stream.href);
  } catch (error) {
    if (!disposed && !startupAbort.signal.aborted) setConnection(false, error.message);
  }
}

let disposePrompt = null;
const promptWorkspace = element("prompt-workspace");
if (promptWorkspace) {
  disposePrompt = mountPrompt(promptWorkspace, {
    controller: generation,
    onGenerate: handleGenerate,
    subscribeConnection,
  });
}

let disposeInspector = null;
const inspectorWorkspace = element("inspector-workspace");
if (inspectorWorkspace) {
  disposeInspector = mountInspector(inspectorWorkspace, canvas);
}

connectApp();

const gpuStatusEl = element("gpu-status");
const labelsEl = element("graph-labels");
const gpuReady = initializeGPU(canvas, (message) => {
  if (gpuStatusEl) gpuStatusEl.textContent = message;
  if (gpuStatusEl) gpuStatusEl.hidden = message.startsWith("WebGPU ready.");
}, labelsEl);
element("fit-graph")?.addEventListener("click", () => canvas?.dispatchEvent(new Event("fit")));
element("zoom-in")?.addEventListener("click", () => canvas?.dispatchEvent(new CustomEvent("zoom", { detail: 1.25 })));
element("zoom-out")?.addEventListener("click", () => canvas?.dispatchEvent(new CustomEvent("zoom", { detail: 0.8 })));
window.addEventListener("pagehide", () => {
  disposed = true;
  startupAbort.abort();
  live.dispose();
  gpuReady.then((dispose) => dispose?.());
  disposePrompt?.();
  disposeInspector?.();
  unsubscribeGeneration();
  generation.dispose();
  readout.dispose();
  connectionListeners.clear();
});
