import { loadManifest, loadTokenizerFile, loadWeights } from "./assets.js";
import { createTokenizer } from "./tokenizer.js";
import { sampleToken } from "./sampler.js";
import { buildMapping, firePairs } from "./mapping.js";
import { createVibe2Engine } from "./engine.js";

/** In-page fetch transport and the sole owner of recurrent inference state. */
export function createVibe2Runtime({ baseUrl, fetch: fetchImpl = globalThis.fetch, gpu, createEngine = createVibe2Engine, random = Math.random, now = () => Date.now() }) {
  let status = { state: "loading", message: "Loading model weights 0%", progress: 0 };
  const statusListeners = new Set(), telemetryListeners = new Set(), requests = new Set();
  let disposed = false, manifest, tokenizer, engine, mapping, loading;
  let tail = Promise.resolve(), seq = 0, t = 0;
  const hex = n => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  const runId = `run-${hex(12)}`;
  const stamp = ms => `${Math.trunc(ms)}000000`;
  const setStatus = next => { if (!disposed) { status = next; for (const fn of statusListeners) fn(status); } };
  const emit = message => { if (!disposed) for (const fn of telemetryListeners) fn(message); };
  const telemetry = message => emit({ run_id: runId, epoch: 0, seq: seq++, ...message });
  const json = (value, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "Content-Type": "application/json" } });
  const errorResponse = (code, type, message) => json({ error: { type, message } }, code);
  async function load() {
    loading = new AbortController();
    const fetchAsset = (url, init) => fetchImpl(url, { ...init, signal: loading.signal });
    setStatus({ state: "loading", message: "Loading model weights 0%", progress: 0 });
    try {
      manifest = await loadManifest(baseUrl, fetchAsset);
      tokenizer = createTokenizer(await loadTokenizerFile(baseUrl, fetchAsset));
      const weights = await loadWeights(baseUrl, manifest, fetchAsset, progress => setStatus({ state: "loading", message: `Loading model weights ${Math.round(progress * 100)}%`, progress }));
      if (disposed) return;
      setStatus({ state: "loading", message: "Compiling WebGPU kernels", progress: 1 });
      const created = await createEngine({ manifest, weights, gpu });
      if (disposed) { created.destroy(); return; }
      engine = created;
      engine.lost?.then(() => { if (engine === created) setStatus({ state: "error", message: "GPU device lost; reload the page", progress: 0 }); });
      mapping = buildMapping(manifest);
      emit(mapping.message);
      setStatus({ state: "ready", message: `${manifest.model_id} ready (in-browser WebGPU)`, progress: 1 });
    } catch (error) { setStatus({ state: "error", message: error.message, progress: 0 }); }
  }
  async function generate(body, stream, signal, predecessor) {
    const started = now(), requestId = `req-${hex(12)}`;
    const raw = tokenizer.encodeOrdinary(body.prompt);
    const ids = raw.slice(-manifest.config.ctx);
    if (!ids.length) ids.push(tokenizer.eot);
    const maxTokens = Math.max(1, Math.min(128, Math.trunc(Number(body.max_tokens || body.max_completion_tokens || 64))));
    const temperature = Number(body.temperature ?? 1), topK = body.top_k || 50;
    let promptTokens = 0, completionTokens = 0, tStart = -1, pending = null, sent = 0;
    const completionDecoder = new TextDecoder(), promptDecoder = new TextDecoder();
    const out = [];
    const lifecycle = (phase, finish_reason = "none") => {
      const ms = now();
      telemetry({ type: "request_lifecycle", request_id: requestId, impl: "vibe2", model_id: manifest.model_id,
        ckpt_digest: manifest.checkpoint.sha256, phase, t_start: tStart, prompt_raw_tokens: raw.length,
        prompt_tokens: promptTokens, max_tokens: maxTokens, completion_tokens: completionTokens, finish_reason,
        server_time_ms: ms, timestamp_ns: stamp(ms) });
    };
    const token = (kind, index, id, decoder) => {
      const bytes = tokenizer.tokenBytes(id), ms = now();
      return { kind, token_index: index, token_id: id, token_text: decoder.decode(bytes, { stream: true }),
        token_bytes: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""), emitMs: ms };
    };
    const reportToken = (item, step_status, at, ms) => {
      const { emitMs, ...fields } = item;
      telemetry({ type: "token_step", request_id: requestId, ...fields, step_status, t: at,
        step_ns: at < 0 ? "0" : stamp(ms), emit_ns: stamp(emitMs),
        step_rel_us: at < 0 ? 0 : Math.max(0, Math.trunc((ms - started) * 1000)),
        emit_rel_us: Math.max(0, Math.trunc((emitMs - started) * 1000)) });
    };
    const unprocessed = () => { if (pending) { reportToken(pending, "unprocessed", -1, 0); pending = null; } };
    const checkAbort = () => { if (disposed || signal.aborted) throw new DOMException("Aborted", "AbortError"); };
    const base = { id: `cmpl-${hex(24)}`, created: Math.floor(now() / 1000), model: manifest.model_id, object: "text_completion" };
    const encoder = new TextEncoder();
    const send = value => stream.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    const chunk = (text, finish_reason = null) => send({ ...base, choices: [{ index: 0, text, logprobs: null, finish_reason }] });
    const decoded = () => new TextDecoder().decode(Uint8Array.from(out.flatMap(id => [...tokenizer.tokenBytes(id)])));
    const step = async (id, wantLogits, item) => {
      checkAbort();
      const result = await engine.step(id, { logits: wantLogits });
      checkAbort();
      const active = Array.from(result.code).flatMap((value, k) => value > 0 ? [k] : []);
      const pairs = firePairs(mapping.kcPairs, active);
      if (pairs.length) emit({ type: "fire", t, pairs });
      const ms = now();
      if (item.kind === "prompt") item.emitMs = ms;
      reportToken(item, pairs.length ? "stepped_fired" : "stepped_silent", t++, ms);
      return result.logits;
    };
    lifecycle("queued");
    try {
      await predecessor; checkAbort();
      engine.reset(); checkAbort();
      promptTokens = ids.length;
      let logits;
      for (let i = 0; i < ids.length; i++) {
        checkAbort();
        if (i === 0) { tStart = t; lifecycle("prefill"); }
        logits = await step(ids[i], i === ids.length - 1, token("prompt", i, ids[i], promptDecoder));
        checkAbort();
      }
      let finish = "length";
      for (let i = 0; i < maxTokens; i++) {
        checkAbort();
        const id = sampleToken(logits, temperature, topK, random);
        pending = token("completion", completionTokens++, id, completionDecoder);
        if (i === 0) lifecycle("decode");
        if (id === tokenizer.eot) { finish = "stop"; break; }
        out.push(id);
        const text = decoded();
        if (!text.endsWith("\uFFFD") && text.length > sent) { chunk(text.slice(sent)); sent = text.length; }
        if (i === maxTokens - 1) break;
        logits = await step(id, true, pending);
        pending = null;
        checkAbort();
      }
      unprocessed();
      const remainder = decoded().slice(sent);
      if (remainder) chunk(remainder);
      chunk("", finish);
      if (body.stream_options?.include_usage) send({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
      stream.enqueue(encoder.encode("data: [DONE]\n\n"));
      lifecycle("completed", finish); stream.close();
    } catch (error) {
      unprocessed();
      const aborted = error.name === "AbortError" || signal.aborted || disposed;
      lifecycle(aborted ? "cancelled" : "failed", aborted ? "cancelled" : "error");
      try { stream.error(aborted ? new DOMException("Aborted", "AbortError") : error); } catch { /* Consumer already cancelled. */ }
    }
  }
  const runtime = {
    get status() { return status; },
    subscribeStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    subscribeTelemetry(fn) { telemetryListeners.add(fn); if (mapping) fn(mapping.message); return () => telemetryListeners.delete(fn); },
    retry() {
      if (!disposed && status.state === "error") {
        const previous = engine; engine = undefined; previous?.destroy(); void load();
      }
    },
    async fetch(url, init = {}) {
      const path = new URL(typeof url === "string" ? url : url.url ?? String(url), "http://local").pathname;
      const method = (init.method || "GET").toUpperCase();
      if (path === "/health" && method === "GET") {
        if (status.state !== "ready") return errorResponse(503, status.state === "loading" ? "model_loading" : "service_unavailable", status.message);
        return json({ status: "ok", model: manifest.model_id, note: `${manifest.note} · in-browser WebGPU`, checkpoint: manifest.checkpoint });
      }
      if (path !== "/v1/completions" || method !== "POST") return errorResponse(404, "invalid_request_error", `no route ${path}`);
      if (disposed || status.state !== "ready") return errorResponse(503, "service_unavailable", status.message);
      let body;
      try { body = JSON.parse(init.body || "{}"); } catch { return errorResponse(400, "invalid_request_error", "body is not valid JSON"); }
      if (typeof body?.prompt !== "string") return errorResponse(400, "invalid_request_error", "'prompt' must be a string");
      const abort = new AbortController(); requests.add(abort);
      const onAbort = () => abort.abort();
      init.signal?.addEventListener("abort", onAbort, { once: true });
      if (init.signal?.aborted) abort.abort();
      const predecessor = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      const stream = new ReadableStream({
        start(controller) {
          void generate(body, controller, abort.signal, predecessor).finally(() => {
            requests.delete(abort); init.signal?.removeEventListener("abort", onAbort); release();
          });
        },
        cancel() { abort.abort(); },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
    dispose() { disposed = true; loading?.abort(); for (const request of requests) request.abort(); engine?.destroy(); statusListeners.clear(); telemetryListeners.clear(); },
  };
  void load();
  return runtime;
}
