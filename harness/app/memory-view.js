import { MemoryInspector } from "./memory.js";

const writeKey = (write) => JSON.stringify([write.request_id, write.block, write.rev]);
const sliceKey = (slice) => JSON.stringify([slice.kc_id, slice.lobe, slice.head]);
const decode = (value, scale) => typeof value === "number" ? String(value / scale) : value ?? "missing";

/** Inspect observed recurrent state without announcing each streamed write. */
export function mountMemory(root, canvas = null) {
  const memory = new MemoryInspector();
  const doc = root.ownerDocument ?? document;
  const requestFrame = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 0));
  const cancelFrame = globalThis.cancelAnimationFrame ?? clearTimeout;
  let selected = "latest";
  let selectedSlice = null;
  let frame = null;
  let disposed = false;
  const element = (tag, id, className, text) => {
    const node = doc.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function labelFor(id, text) {
    const label = element("label", null, null, text);
    label.htmlFor = id;
    return label;
  }
  function makeTable(id, caption, headings) {
    const wrap = element("div", id, "memory-table-wrap");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", caption);
    const table = element("table", null, "memory-table");
    const title = element("caption", null, null, caption);
    const head = element("thead");
    const row = element("tr");
    headings.forEach((heading) => {
      const cell = element("th", null, null, heading);
      cell.setAttribute("scope", "col");
      row.append(cell);
    });
    head.append(row);
    const body = element("tbody");
    table.append(title, head, body);
    wrap.append(table);
    return { wrap, body };
  }
  function row(cells) {
    const result = element("tr");
    cells.forEach((value, index) => {
      const cell = element(index === 0 ? "th" : "td", null, null, String(value));
      if (index === 0) cell.setAttribute("scope", "row");
      result.append(cell);
    });
    return result;
  }
  const panel = element("div", null, "memory-panel");
  const identity = element("p", "memory-identity", "memory-identity");
  const empty = element("p", "memory-empty", "hint");
  const writeLabel = labelFor("memory-write", "Observed write");
  const writeSelect = element("select", "memory-write");
  writeSelect.setAttribute("aria-describedby", "memory-help");
  const details = element("p", "memory-details", "memory-identity");
  const notice = element("p", "memory-notice", "memory-notice");
  const summaryNote = element("p", "memory-summary-note", "hint");
  const heads = makeTable("memory-heads", "Per-head memory summary", [
    "Head", "Dopamine gate", "Dopamine cap", "Recovery half-life (steps)", "Recovery keep factor",
    "S before norm", "S after norm", "Net delta norm",
  ]);
  const sliceLabel = labelFor("memory-slice", "Observed KC / lobe / head slice");
  const sliceSelect = element("select", "memory-slice");
  const sliceNote = element("p", "memory-slice-note", "hint");
  const features = makeTable("memory-features", "Selected slice features", [
    "Feature", "S before", "S after", "Raw delta", "Net delta", "Read vector",
  ]);
  const help = element("p", "memory-help", "hint",
    "Optional memory telemetry shows transient request-local recurrent state, not learned parameters. Heads are computational units, not anatomical neurons; dopamine is a learned gate. KC IDs are model KC indices; KC/lobe/head IDs are not mapped to graph nodes. Only observed slices are available; absent slices are not zero. Raw delta excludes recovery; net delta includes recovery. Values are wire integers divided by scale; nan, inf, -inf and missing remain literal. History is capped at 16 writes and 32 slices per write. Choose Follow latest or hold an observed write for inspection.");
  panel.append(identity, empty, writeLabel, writeSelect, details, notice, summaryNote, heads.wrap,
    sliceLabel, sliceSelect, sliceNote, features.wrap, help);
  root.replaceChildren(panel);

  // Preserve the controls themselves so arriving telemetry cannot steal focus.
  function options(select, items) {
    const previous = Array.from(select.children);
    if (previous.length !== items.length || previous.some((option, index) => option.value !== items[index][0])) {
      select.replaceChildren(...items.map(([value]) => {
        const option = element("option");
        option.value = value;
        return option;
      }));
    }
    Array.from(select.children).forEach((option, index) => { option.textContent = items[index][1]; });
  }
  function render() {
    frame = null;
    if (disposed) return;
    const state = memory.snapshot;
    const notices = [];
    const writes = state.writes;
    identity.textContent = state.run_id === null
      ? "No memory telemetry received."
      : `Run ${state.run_id} · epoch ${state.epoch}`;
    empty.hidden = writes.length > 0;
    empty.textContent = "No memory writes observed. Enable optional memory telemetry on a supported model and generate a request, or open a recording containing memory events. Legacy streams and models without memory telemetry remain usable.";
    if (selected !== "latest" && !writes.some((write) => writeKey(write) === selected)) {
      notices.push("Selected write is no longer retained; following latest.");
      selected = "latest";
      selectedSlice = null;
    }
    options(writeSelect, [["latest", "Follow latest"], ...writes.map((write) => [writeKey(write),
      `${write.request_id} · block ${write.block} · t ${write.t} · rev ${write.prev_rev} → ${write.rev}`])]);
    writeSelect.value = selected;
    writeSelect.disabled = writes.length === 0;
    const write = selected === "latest" ? writes.at(-1) : writes.find((item) => writeKey(item) === selected);
    if (state.status?.event === "resync") notices.push("Resynchronized: earlier memory history is unavailable.");
    if (state.status?.event === "epoch_reset") notices.push("Mapping epoch changed; earlier memory writes were cleared.");
    if (state.dropped_messages) notices.push(`Delivery gap: ${state.dropped_messages} messages lost; memory history may be partial.`);
    if (state.omitted_writes) notices.push(`Retention: ${state.omitted_writes} older writes omitted.`);
    details.hidden = summaryNote.hidden = sliceNote.hidden = !write;
    heads.wrap.hidden = true;
    features.wrap.hidden = true;
    sliceLabel.hidden = sliceSelect.hidden = !write?.slices.length;
    heads.body.replaceChildren();
    features.body.replaceChildren();
    if (!write) {
      details.textContent = summaryNote.textContent = sliceNote.textContent = "";
      options(sliceSelect, []);
      selectedSlice = null;
    } else {
      details.textContent = `${write.request_id} · block ${write.block} · t ${write.t} · rev ${write.prev_rev} → ${write.rev} · scale ${write.scale}`;
      if (write.continuity === "baseline") notices.push("Partial revision history: first observed write is after revision 1; earlier state is unavailable.");
      if (write.continuity === "gap") notices.push("Revision gap: intervening writes or messages were not observed; this is not a replay of every write.");
      if (write.partial) notices.push("Partial write history: a delivery gap may have omitted summary or slices.");
      if (write.omitted_slices) notices.push(`Retention: ${write.omitted_slices} slices omitted from this write.`);
      const summary = write.summary;
      summaryNote.textContent = summary
        ? `${summary.heads} computational heads · ${summary.head_dim} features per head · dtype ${summary.dtype}. Norms are per-head Frobenius norms, not individual KC weights.`
        : "Summary unavailable for this observed write. Slice-only telemetry does not supply dopamine gates, recovery values or head norms.";
      if (summary) {
        heads.wrap.hidden = false;
        heads.body.replaceChildren(...Array.from({ length: summary.heads }, (_, head) => row([head,
          ...["dopamine_gate", "dopamine_cap", "recovery_half_life", "recovery_factor", "s_norm_before", "s_norm_after", "s_delta_norm"]
            .map((field) => decode(summary[field][head], summary.scale)),
        ])));
      }
      const slices = write.slices;
      if (!slices.some((slice) => sliceKey(slice) === selectedSlice)) selectedSlice = slices[0] ? sliceKey(slices[0]) : null;
      options(sliceSelect, slices.map((slice) => [sliceKey(slice), `KC ${slice.kc_id} · lobe ${slice.lobe} · head ${slice.head}`]));
      sliceSelect.value = selectedSlice ?? "";
      sliceSelect.disabled = slices.length === 0;
      const slice = slices.find((item) => sliceKey(item) === selectedSlice);
      sliceNote.textContent = slice
        ? `KC ${slice.kc_id} · lobe ${slice.lobe} · head ${slice.head} · k_activation ${decode(slice.k_activation, slice.scale)} · slice scale ${slice.scale}. Read vector is the head readout, not a KC-specific read.`
        : "Summary only: no slices observed for this write. Slice sampling may be disabled, strided or contain no active KCs; unobserved values are unavailable.";
      if (slice) {
        features.wrap.hidden = false;
        features.body.replaceChildren(...slice.s_before.map((_, feature) => row([feature,
          ...["s_before", "s_after", "delta_raw", "delta_net", "read_vector"]
            .map((field) => decode(slice[field][feature], slice.scale)),
        ])));
      }
    }
    notice.textContent = notices.join(" ");
    notice.hidden = notices.length === 0;
  }
  function schedule() {
    if (frame === null && !disposed) frame = requestFrame(render);
  }
  function receive(event) {
    if (memory.accept(event.detail)) schedule();
  }
  function reset() {
    memory.reset();
    selected = "latest";
    selectedSlice = null;
    schedule();
  }
  function chooseWrite() {
    selected = writeSelect.value;
    selectedSlice = null;
    render();
  }
  function chooseSlice() {
    selectedSlice = sliceSelect.value;
    render();
  }
  writeSelect.addEventListener("change", chooseWrite);
  sliceSelect.addEventListener("change", chooseSlice);
  canvas?.addEventListener("telemetry", receive);
  canvas?.addEventListener("mapping", reset);
  canvas?.addEventListener("reset", reset);
  render();
  return () => {
    disposed = true;
    if (frame !== null) cancelFrame(frame);
    writeSelect.removeEventListener("change", chooseWrite);
    sliceSelect.removeEventListener("change", chooseSlice);
    canvas?.removeEventListener("telemetry", receive);
    canvas?.removeEventListener("mapping", reset);
    canvas?.removeEventListener("reset", reset);
    root.replaceChildren();
  };
}
