import { ProtocolReceiver } from "./protocol.js";
import { LiveSource, readRecording } from "./sources.js";
import { initializeGPU } from "./gpu.js";

const receiver = new ProtocolReceiver();
const element = (id) => document.getElementById(id);
const canvas = element("viewport");
let fileController;
let fires = 0, dropped = 0, droppedPairs = 0;

function renderMapping() {
  const mapping = receiver.mapping;
  element("nodes").textContent = mapping?.nodes.length ?? 0;
  element("edges").textContent = mapping?.edges.length ?? 0;
  const counts = new Map(mapping?.groups.map((group) => [group.id, 0]));
  for (const node of mapping?.nodes ?? []) counts.set(node.group, counts.get(node.group) + 1);
  const rows = (mapping?.groups ?? []).map((group) => {
    const row = document.createElement("tr");
    for (const text of [group.name, group.id, counts.get(group.id)]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  });
  if (!rows.length) {
    const row = document.createElement("tr"), cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = mapping ? "This mapping has no groups." : "No mapping received.";
    row.append(cell);
    rows.push(row);
  }
  element("groups").replaceChildren(...rows);
}

function renderCounters() {
  element("step").textContent = receiver.lastT ?? "—";
  element("fires").textContent = fires;
  element("dropped").textContent = dropped;
  element("pairs-dropped").textContent = droppedPairs;
}

function clearDisplay() {
  fires = dropped = droppedPairs = 0;
  renderMapping();
  renderCounters();
  element("protocol-status").textContent = "Waiting for a mapping.";
  element("last-fire").textContent = "No accepted fire event.";
  canvas.dispatchEvent(new Event("reset"));
}

function onEvent(event) {
  if (event.action === "replace_mapping") {
    fires = dropped = droppedPairs = 0;
    renderMapping();
    element("protocol-status").textContent = `Mapping accepted · epoch ${event.epoch}.`;
    element("last-fire").textContent = "No accepted fire event.";
    canvas.dispatchEvent(new CustomEvent("mapping", { detail: receiver.mapping }));
  } else if (event.action === "accept_fire") {
    fires++;
    droppedPairs += event.dropped_pairs.length;
    const preview = event.pairs.slice(0, 8).map(([src, dst]) => `${src} → ${dst}`).join(", ");
    element("last-fire").textContent = `Step ${event.t}: ${event.pairs.length} accepted pairs${preview ? ` · ${preview}` : ""}${event.pairs.length > 8 ? ", …" : ""}.`;
    canvas.dispatchEvent(new CustomEvent("fire", { detail: { t: event.t, pairs: event.pairs } }));
  } else if (event.action === "drop_message") {
    dropped++;
  } else if (event.action === "close") {
    element("protocol-status").textContent = `Unsupported mapping version (protocol code ${event.code}).`;
    canvas.dispatchEvent(new Event("reset"));
  }
  renderCounters();
}

const live = new LiveSource(receiver, {
  onEvent,
  onStatus({ state, message }) {
    element("source-status").textContent = message;
    if (["connecting", "reconnecting", "disconnected"].includes(state)) clearDisplay();
    if (state === "unsupported") {
      renderMapping();
      renderCounters();
    }
  },
});

function stopFile() {
  fileController?.abort();
  fileController = undefined;
}

element("endpoint").value = new URLSearchParams(location.search).get("ws") || "ws://127.0.0.1:8765/stream";
element("connection").addEventListener("submit", (event) => {
  event.preventDefault();
  stopFile();
  element("recording").value = "";
  live.connect(element("endpoint").value);
});
element("disconnect").addEventListener("click", () => {
  stopFile();
  live.disconnect();
  clearDisplay();
});
element("recording").addEventListener("change", async () => {
  const file = element("recording").files[0];
  if (!file) return;
  stopFile();
  live.disconnect();
  receiver.reset();
  clearDisplay();
  const controller = new AbortController();
  fileController = controller;
  element("source-status").textContent = `Reading ${file.name}…`;
  try {
    const result = await readRecording(file, receiver, onEvent, { signal: controller.signal });
    if (controller.signal.aborted) return;
    element("source-status").textContent = result.unsupported
      ? `Stopped ${file.name}: unsupported protocol version.`
      : `Finished ${file.name}. ${result.lines} lines processed.`;
  } catch (error) {
    if (!controller.signal.aborted) element("source-status").textContent = `Cannot read recording: ${error.message}`;
  }
});

const gpuReady = initializeGPU(canvas, (message) => { element("gpu-status").textContent = message; }, element("graph-labels"));
element("fit-graph").addEventListener("click", () => canvas.dispatchEvent(new Event("fit")));
element("zoom-in").addEventListener("click", () => canvas.dispatchEvent(new CustomEvent("zoom", { detail: 1.25 })));
element("zoom-out").addEventListener("click", () => canvas.dispatchEvent(new CustomEvent("zoom", { detail: 0.8 })));
window.addEventListener("pagehide", () => {
  stopFile();
  live.disconnect();
  gpuReady.then((dispose) => dispose());
});
if (new URLSearchParams(location.search).has("ws")) live.connect(element("endpoint").value);
