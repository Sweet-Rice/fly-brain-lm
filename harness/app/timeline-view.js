import { Timeline } from "./timeline.js";

/** Mount telemetry inspection without announcing every streamed token. */
export function mountTimeline(root, canvas = null) {
  const timeline = new Timeline();
  const doc = root.ownerDocument ?? document;
  let selected = null;
  let frame = null;
  let disposed = false;
  const requestFrame = globalThis.requestAnimationFrame ?? ((cb) => setTimeout(cb, 0));
  const cancelFrame = globalThis.cancelAnimationFrame ?? clearTimeout;
  const element = (tag, id, className, text) => {
    const node = doc.createElement(tag);
    if (id) node.id = id;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = element("div", null, "timeline-panel");
  const identity = element("p", "timeline-identity", "timeline-identity");
  const empty = element("p", "timeline-empty", "hint");
  const label = element("label", null, null, "Request");
  label.htmlFor = "timeline-request";
  const select = element("select", "timeline-request");
  select.setAttribute("aria-describedby", "timeline-help");
  const summary = element("p", "timeline-summary", "timeline-summary");
  const phases = element("p", "timeline-phases", "hint");
  const notice = element("p", "timeline-notice", "timeline-notice");
  const tokens = element("ol", "timeline-tokens", "timeline-tokens");
  tokens.tabIndex = 0;
  tokens.setAttribute("aria-label", "Observed tokens in reception order");
  const help = element("p", "timeline-help", "hint",
    "Match t to graph steps only in the same server run and epoch. Fired means positive KC activations; silent means a step ran without them, not biological spikes. Unprocessed means a sampled token had no subsequent step; it has no t or step timing. Timings are producer-reported microseconds since request start. Tokens are distinct from HTTP text chunks. This panel does not replay graph activity.");
  panel.append(identity, empty, label, select, summary, phases, notice, tokens, help);
  root.replaceChildren(panel);

  function render() {
    frame = null;
    if (disposed) return;
    const state = timeline.snapshot;
    const requests = state.requests;
    if (!requests.some((request) => request.request_id === selected)) {
      selected = requests.at(-1)?.request_id ?? null;
    }
    identity.textContent = state.run_id === null
      ? "No run telemetry received."
      : `Run ${state.run_id} · epoch ${state.epoch}`;
    empty.hidden = requests.length > 0;
    empty.textContent = state.run_id === null
      ? "Waiting for optional run/token telemetry. Legacy mapping/fire streams remain usable but cannot populate this timeline."
      : "No requests observed in this stream window. A reconnect or replacement mapping starts a fresh view.";
    label.hidden = requests.length === 0;
    select.hidden = requests.length === 0;
    select.disabled = requests.length === 0;
    // Keep the select itself mounted so a stream update does not steal keyboard focus.
    const options = Array.from(select.children);
    if (options.length !== requests.length || options.some((option, i) => option.value !== requests[i].request_id)) {
      select.replaceChildren(...requests.map((request) => {
        const option = element("option");
        option.value = request.request_id;
        return option;
      }));
    }
    Array.from(select.children).forEach((option, i) => {
      const request = requests[i];
      option.textContent = `${request.request_id} · ${request.lifecycle?.phase ?? "partial"}`;
    });
    select.value = selected ?? "";
    const request = requests.find((item) => item.request_id === selected);
    summary.hidden = phases.hidden = tokens.hidden = !request;
    const notices = [];
    if (state.status?.event === "resync") notices.push("Resynchronized: earlier request history is unavailable.");
    if (state.status?.event === "epoch_reset") notices.push("Mapping epoch changed; earlier requests were cleared.");
    if (state.dropped_messages) notices.push(`Delivery gap: ${state.dropped_messages} messages lost; affected history is partial.`);
    if (state.omitted_requests) notices.push(`Retention: ${state.omitted_requests} older requests omitted.`);
    if (!request) {
      summary.textContent = phases.textContent = "";
      tokens.replaceChildren();
    } else {
      const latest = request.lifecycle;
      summary.textContent = latest
        ? `${latest.phase} · ${latest.impl} / ${latest.model_id} · checkpoint ${latest.ckpt_digest} · lifecycle counts: prompt ${latest.prompt_tokens} accepted / ${latest.prompt_raw_tokens} raw · completion ${latest.completion_tokens} / ${latest.max_tokens} max · finish ${latest.finish_reason}`
        : "Partial request: lifecycle, model identity and authoritative counts were not observed.";
      phases.textContent = request.phases.length
        ? `Observed phases: ${request.phases.map((phase) => phase.phase).join(" → ")}`
        : "No lifecycle phases observed.";
      if (request.partial) notices.push("Partial request history: earlier events may be unavailable.");
      if (request.omitted_tokens) notices.push(`Retention: ${request.omitted_tokens} older tokens omitted from this request.`);
      if (request.tokens.length === 0) notices.push("No token events observed for this request yet.");
      tokens.replaceChildren(...request.tokens.map((token) => {
        const row = element("li", null, "timeline-token");
        const name = element("div", null, "timeline-token-meta",
          `${token.kind} #${token.token_index} · ID ${token.token_id} · ${token.step_status}`);
        const text = element("code", null, "timeline-token-text", JSON.stringify(token.token_text));
        const timing = element("div", null, "hint",
          token.step_status === "unprocessed"
            ? `t — · emit ${token.emit_rel_us} µs · step — (unprocessed)`
            : `t ${token.t} · emit ${token.emit_rel_us} µs · step ${token.step_rel_us} µs`);
        row.append(name, text, timing);
        if (token.token_text === "") {
          row.append(element("div", null, "hint", `No decoded text yet · raw bytes ${token.token_bytes || "(empty)"}`));
        }
        return row;
      }));
    }
    notice.textContent = notices.join(" ");
    notice.hidden = notices.length === 0;
  }

  function schedule() {
    if (frame === null && !disposed) frame = requestFrame(render);
  }
  function receive(event) {
    if (timeline.accept(event.detail)) schedule();
  }
  function reset() {
    timeline.reset();
    selected = null;
    schedule();
  }
  function choose() {
    selected = select.value;
    render();
  }
  select.addEventListener("change", choose);
  canvas?.addEventListener("telemetry", receive);
  canvas?.addEventListener("mapping", reset);
  canvas?.addEventListener("reset", reset);
  render();
  return () => {
    disposed = true;
    if (frame !== null) cancelFrame(frame);
    select.removeEventListener("change", choose);
    canvas?.removeEventListener("telemetry", receive);
    canvas?.removeEventListener("mapping", reset);
    canvas?.removeEventListener("reset", reset);
    root.replaceChildren();
  };
}
