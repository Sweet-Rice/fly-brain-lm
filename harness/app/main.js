import { ProtocolReceiver } from "./protocol.js";
import { LiveSource } from "./sources.js";
import { RecordingSource } from "./playback.js";
import { initializeGPU } from "./gpu.js";
import { mountPrompt } from "./prompt-view.js";
import { mountInspector } from "./inspector.js";
import { groupStyle } from "./brain-atlas.js";
import { mountReadout } from "./readout-view.js";
import { GenerationController } from "./generation.js";

const receiver = new ProtocolReceiver();
const element = (id) => document.getElementById(id);
const canvas = element("viewport");
let fires = 0, dropped = 0, droppedPairs = 0;
let groupsPage = 0;
const GROUPS_PER_PAGE = 5;
const readout = mountReadout(element("readout-workspace"), canvas);
const generation = new GenerationController();
const unsubscribeReadout = generation.subscribe((state) => readout.setGeneration(state));

function setView(view) {
  element("workspace-shell").setAttribute("data-view", view);
  for (const name of ["brain", "generate", "inspector", "source"]) {
    element(`view-${name}`).setAttribute("aria-pressed", String(name === view));
  }
  element("workbench").hidden = view === "brain";
  for (const [name, id] of Object.entries({
    generate: "prompt-panel",
    inspector: "inspector-panel-section", source: "source-panel",
  })) element(id).hidden = name !== view;
}

for (const name of ["brain", "generate", "inspector", "source"]) {
  element(`view-${name}`).addEventListener("click", () => setView(name));
}
for (const name of ["setup", "legend", "stream"]) {
  element(`source-view-${name}`).addEventListener("click", () => {
    for (const panel of ["setup", "legend", "stream"]) {
      element(`source-${panel}`).hidden = panel !== name;
      element(`source-view-${panel}`).setAttribute("aria-pressed", String(panel === name));
    }
  });
}
canvas?.addEventListener("node-select", ({ detail }) => {
  if (detail?.id != null) setView("inspector");
});

function renderMapping() {
  const mapping = receiver.mapping;
  const nodesEl = element("nodes");
  if (nodesEl) nodesEl.textContent = mapping?.nodes.length ?? 0;
  const edgesEl = element("edges");
  if (edgesEl) edgesEl.textContent = mapping?.edges.length ?? 0;
  const counts = new Map(mapping?.groups.map((group) => [group.id, 0]));
  for (const node of mapping?.nodes ?? []) counts.set(node.group, counts.get(node.group) + 1);
  const groups = mapping?.groups ?? [];
  const pages = Math.max(1, Math.ceil(groups.length / GROUPS_PER_PAGE));
  groupsPage = Math.min(groupsPage, pages - 1);
  element("groups-prev").disabled = groupsPage === 0;
  element("groups-next").disabled = groupsPage === pages - 1;
  element("groups-page").textContent = `Page ${groupsPage + 1} of ${pages}`;
  const rows = groups.slice(groupsPage * GROUPS_PER_PAGE, (groupsPage + 1) * GROUPS_PER_PAGE).map((group, offset) => {
    const index = groupsPage * GROUPS_PER_PAGE + offset;
    const style = groupStyle(group, index);
    const row = document.createElement("tr");

    const swatchCell = document.createElement("td");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    const [r, g, b] = style.color;
    swatch.style.background = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    swatchCell.append(swatch);
    row.append(swatchCell);

    for (const text of [group.name, group.id, counts.get(group.id), style.placement]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  });
  if (!rows.length) {
    const row = document.createElement("tr"), cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = mapping ? "This mapping has no groups." : "No mapping received.";
    row.append(cell);
    rows.push(row);
  }
  element("groups")?.replaceChildren(...rows);
}

function renderCounters() {
  const stepEl = element("step");
  if (stepEl) stepEl.textContent = receiver.lastT ?? "—";
  const firesEl = element("fires");
  if (firesEl) firesEl.textContent = fires;
  const droppedEl = element("dropped");
  if (droppedEl) droppedEl.textContent = dropped;
  const pairsDroppedEl = element("pairs-dropped");
  if (pairsDroppedEl) pairsDroppedEl.textContent = droppedPairs;
}

function clearDisplay() {
  fires = dropped = droppedPairs = 0;
  groupsPage = 0;
  renderMapping();
  readout.reset();
  renderCounters();
  const protocolStatus = element("protocol-status");
  if (protocolStatus) protocolStatus.textContent = "Waiting for a mapping.";
  const lastFire = element("last-fire");
  if (lastFire) lastFire.textContent = "No accepted fire event.";
  canvas?.dispatchEvent(new Event("reset"));
}

function onEvent(event, raw) {
  if (event.action === "replace_mapping") {
    fires = dropped = droppedPairs = 0;
    groupsPage = 0;
    readout.reset();
    renderMapping();
    const protocolStatus = element("protocol-status");
    if (protocolStatus) protocolStatus.textContent = `Mapping accepted · epoch ${event.epoch}.`;
    const lastFire = element("last-fire");
    if (lastFire) lastFire.textContent = "No accepted fire event.";
    canvas?.dispatchEvent(new CustomEvent("mapping", { detail: receiver.mapping }));
  } else if (event.action === "accept_fire") {
    fires++;
    droppedPairs += event.dropped_pairs.length;
    const preview = event.pairs.slice(0, 8).map(([src, dst]) => `${src} → ${dst}`).join(", ");
    const lastFire = element("last-fire");
    if (lastFire) lastFire.textContent = `Step ${event.t}: ${event.pairs.length} accepted pairs${preview ? ` · ${preview}` : ""}${event.pairs.length > 8 ? ", …" : ""}.`;
    canvas?.dispatchEvent(new CustomEvent("fire", { detail: { t: event.t, pairs: event.pairs } }));
  } else if (event.action === "drop_message") {
    dropped++;
  } else if (event.action === "ignore_message" && receiver.mapping) {
    readout.accept(raw);
    return;
  } else if (event.action === "close") {
    const protocolStatus = element("protocol-status");
    if (protocolStatus) protocolStatus.textContent = `Unsupported mapping version (protocol code ${event.code}).`;
    canvas?.dispatchEvent(new Event("reset"));
    readout.reset();
  }
  renderCounters();
}

const live = new LiveSource(receiver, {
  onEvent,
  onStatus({ state, message }) {
    const sourceStatus = element("source-status");
    if (sourceStatus) sourceStatus.textContent = message;
    if (["connecting", "reconnecting", "disconnected", "background"].includes(state)) clearDisplay();
    if (state === "unsupported") {
      renderMapping();
      renderCounters();
    }
  },
});

const recording = new RecordingSource(receiver, {
  onEvent,
  onReset: clearDisplay,
  onStatus({ state, message }) {
    const sourceStatus = element("source-status");
    if (sourceStatus) sourceStatus.textContent = message;
    const playBtn = element("recording-play");
    if (playBtn) playBtn.disabled = state !== "paused";
    const pauseBtn = element("recording-pause");
    if (pauseBtn) pauseBtn.disabled = state !== "playing";
    const restartBtn = element("recording-restart");
    if (restartBtn) restartBtn.disabled = !recording.file;
    const speedBtn = element("recording-speed");
    if (speedBtn) speedBtn.disabled = !recording.file;
    if (state === "unsupported") {
      const protocolStatus = element("protocol-status");
      if (protocolStatus) protocolStatus.textContent = "Unsupported recording protocol version.";
    }
  },
});

function handleGenerate() {
  try {
    const targetUrl = element("endpoint")?.value?.trim() || "";
    const inRecordingMode = Boolean(
      recording &&
      (recording.file || recording.state === "playing" || recording.state === "paused")
    );
    const isLiveActive = Boolean(
      live &&
      live.socket &&
      !live.socket.closed &&
      (typeof live.socket.readyState !== "number" || live.socket.readyState <= 1)
    );
    const endpointChanged = !live?.url || live.url !== targetUrl;

    if (inRecordingMode) {
      recording.disconnect();
      const recInput = element("recording");
      if (recInput) recInput.value = "";
      if (targetUrl) {
        live.connect(targetUrl);
      }
    } else if (!isLiveActive || endpointChanged) {
      if (targetUrl) {
        live.connect(targetUrl);
      }
    }
  } catch (_err) {
    // Viz connection failure must never block text generation
  }
}

let disposePrompt = null;
const promptWorkspace = element("prompt-workspace");
if (promptWorkspace) {
  disposePrompt = mountPrompt(promptWorkspace, {
    controller: generation,
    onGenerate: handleGenerate,
  });
}

let disposeInspector = null;
const inspectorWorkspace = element("inspector-workspace");
if (inspectorWorkspace) {
  disposeInspector = mountInspector(inspectorWorkspace, canvas);
}

const endpointEl = element("endpoint");
if (endpointEl) {
  endpointEl.value = new URLSearchParams(location.search).get("ws") || "ws://127.0.0.1:8765/stream";
}
element("connection")?.addEventListener("submit", (event) => {
  event.preventDefault();
  recording.disconnect();
  const recInput = element("recording");
  if (recInput) recInput.value = "";
  const ep = element("endpoint");
  if (ep?.value) live.connect(ep.value);
});
element("disconnect")?.addEventListener("click", () => {
  recording.disconnect();
  live.disconnect();
  clearDisplay();
});
element("recording")?.addEventListener("change", () => {
  const file = element("recording")?.files?.[0];
  if (!file) return;
  live.disconnect();
  recording.load(file);
});
element("recording-play")?.addEventListener("click", () => recording.play());
element("recording-pause")?.addEventListener("click", () => recording.pause());
element("recording-restart")?.addEventListener("click", () => recording.restart());
element("recording-speed")?.addEventListener("change", () => recording.setSpeed(Number(element("recording-speed")?.value)));
element("groups-prev").addEventListener("click", () => { groupsPage--; renderMapping(); });
element("groups-next").addEventListener("click", () => { groupsPage++; renderMapping(); });

const gpuStatusEl = element("gpu-status");
const labelsEl = element("graph-labels");
const gpuReady = initializeGPU(canvas, (message) => {
  if (gpuStatusEl) gpuStatusEl.textContent = message;
}, labelsEl);
element("fit-graph")?.addEventListener("click", () => canvas?.dispatchEvent(new Event("fit")));
element("zoom-in")?.addEventListener("click", () => canvas?.dispatchEvent(new CustomEvent("zoom", { detail: 1.25 })));
element("zoom-out")?.addEventListener("click", () => canvas?.dispatchEvent(new CustomEvent("zoom", { detail: 0.8 })));
window.addEventListener("pagehide", () => {
  recording.disconnect();
  live.dispose();
  gpuReady.then((dispose) => dispose?.());
  disposePrompt?.();
  disposeInspector?.();
  unsubscribeReadout();
  generation.dispose();
  readout.dispose();
});
if (new URLSearchParams(location.search).has("ws") && element("endpoint")?.value) {
  live.connect(element("endpoint").value);
}
