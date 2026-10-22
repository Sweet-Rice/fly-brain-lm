"""Run and token telemetry for one served model: the request_lifecycle, token_step and stream_status extension
messages of harness/protocol/v1/SPEC.md ("Extension messages (additive)").

The frozen serving engine (model.serve.serve.Engine) is instrumented from outside:
  - engine.run    becomes a generator that emits the request phases around the original one;
  - engine.model  becomes a proxy whose stream() sees the token ids the engine never exposes;
  - two hooks on model.kc_code_module(block) tie each processed token to the step index t that its `fire` carries.
The hooks only read; model state and logits are unchanged.

Step semantics (FlyLM is recurrent): every prompt token is one step. A completion token is sampled from the
previous step, yielded, and only processed by the next step, so it is reported when that step runs. The last
completion token (max_tokens, a stop string, EOT or a closed generator) is never processed: `unprocessed`, t -1.
"""
import codecs
import threading
import time
import uuid

from model.serve.serve import ENC


def _utf8_decoder():
    return codecs.getincrementaldecoder("utf-8")(errors="replace")


class _Request:
    """Per-request state, owned by the request's own instrumented generator (never shared across requests)."""

    def __init__(self, request_id, start_ns, prompt_raw_tokens, max_tokens):
        self.request_id, self.start_ns = request_id, start_ns
        self.prompt_raw_tokens, self.max_tokens = prompt_raw_tokens, max_tokens
        self.t_start = -1
        self.prompt_ids = ()
        self.prompt_tokens = 0
        self.prompt_index = 0                    # next prompt token a step will process
        self.completion_tokens = 0               # token ids the model has yielded
        self.pending = None                      # (index, id, text, hex, emit_ns) yielded but not yet stepped
        self.prefill_sent = False
        self.prompt_decoder, self.completion_decoder = _utf8_decoder(), _utf8_decoder()


class _ModelProxy:
    """Stands in for engine.model: stream() reports token ids to the adapter; everything else is the model's."""

    def __init__(self, model, adapter):
        self._model, self._adapter = model, adapter

    def __getattr__(self, name):
        return getattr(self._model, name)

    def stream(self, ids, *args, **kwargs):
        adapter = self._adapter
        return adapter._traced(getattr(adapter._local, "request", None), ids, self._model.stream(ids, *args, **kwargs))


class TelemetryAdapter:
    """Emit extension messages for `model` over `stream` (a started VizStream with its mapping set).

    run_id      this server run; request_id  the request stepping the model now (None between requests;
    a request still waiting for engine.lock does not change it); current_t  stream.t of the model step running
    now, captured before any forward hook of the KC code module, kept until the next step or the end of the
    request's model stream (-1 outside one); epoch  the stream's mapping epoch."""

    def __init__(self, model, stream, *, block=0, impl, model_id, ckpt_digest, run_id=None):
        self.model, self.stream, self.block = model, stream, block
        self.impl, self.model_id, self.ckpt_digest = impl, model_id, ckpt_digest
        self.run_id = run_id if run_id is not None else f"run-{uuid.uuid4().hex[:12]}"
        self.request_id = None
        self.current_t = -1
        self._seq = 0
        self._active = None                      # the _Request whose model stream is running
        self._local = threading.local()          # .request: the _Request driving the engine on this thread
        self._engine = self._engine_model = self._engine_run = None
        module = model.kc_code_module(block)
        self._hooks = (module.register_forward_pre_hook(self._before_step),
                       module.register_forward_hook(self._after_step))
        stream.status_factory = self.make_stream_status

    @property
    def epoch(self):
        return self.stream.epoch

    # ---- wire -----------------------------------------------------------------------------------
    def emit(self, event):
        """Give `event` the next seq and send it. seq assignment and queueing are one step under the stream's
        event_lock, so every consumer sees strictly increasing seq across all extension message types."""
        with self.stream.event_lock:
            event["seq"] = self._seq
            self._seq += 1
            return self.stream.send_event(event)

    def make_stream_status(self, event, dropped):
        with self.stream.event_lock:
            seq, self._seq = self._seq, self._seq + 1
            return {"type": "stream_status", "run_id": self.run_id, "epoch": self.stream.epoch, "seq": seq,
                    "event": event, "dropped_steps": dropped, "server_time_ms": time.time_ns() // 1_000_000}

    def _lifecycle(self, req, phase, finish_reason="none"):
        now = time.time_ns()
        self.emit({"type": "request_lifecycle", "run_id": self.run_id, "request_id": req.request_id,
                   "epoch": self.stream.epoch, "impl": self.impl, "model_id": self.model_id,
                   "ckpt_digest": self.ckpt_digest, "phase": phase, "t_start": req.t_start,
                   "prompt_raw_tokens": req.prompt_raw_tokens, "prompt_tokens": req.prompt_tokens,
                   "max_tokens": req.max_tokens, "completion_tokens": req.completion_tokens,
                   "finish_reason": finish_reason, "server_time_ms": now // 1_000_000, "timestamp_ns": str(now)})

    def _token_step(self, req, kind, index, token, text, raw, status, t, step_ns, emit_ns):
        self.emit({"type": "token_step", "run_id": self.run_id, "request_id": req.request_id,
                   "epoch": self.stream.epoch, "kind": kind, "token_index": index, "token_id": token,
                   "token_text": text, "token_bytes": raw, "step_status": status, "t": t,
                   "step_rel_us": (step_ns - req.start_ns) // 1000 if step_ns else 0,
                   "emit_rel_us": (emit_ns - req.start_ns) // 1000,
                   "step_ns": str(step_ns), "emit_ns": str(emit_ns)})

    # ---- engine ---------------------------------------------------------------------------------
    def wrap_engine(self, engine):
        """Instrument a model.serve.serve.Engine in place; remove() restores it."""
        if self._engine is not None:
            raise RuntimeError("this adapter already instruments an engine")
        original = engine.run

        def run(prompt, max_tokens, temperature, top_k, stops, info):
            return self._run(original, prompt, max_tokens, temperature, top_k, stops, info)

        self._engine, self._engine_model = engine, engine.model
        self._engine_run = vars(engine).get("run")   # None: Engine.run comes from the class
        engine.model = _ModelProxy(engine.model, self)
        engine.run = run

    def remove(self):
        for hook in self._hooks:
            hook.remove()
        self._hooks = ()
        if self.stream.status_factory == self.make_stream_status:
            self.stream.status_factory = None
        if self._engine is not None:
            if self._engine_run is None:
                del self._engine.run
            else:
                self._engine.run = self._engine_run
            self._engine.model = self._engine_model
            self._engine = self._engine_model = self._engine_run = None

    def _run(self, original, prompt, max_tokens, temperature, top_k, stops, info):
        req = _Request(f"req-{uuid.uuid4().hex[:12]}", time.time_ns(), len(ENC.encode_ordinary(prompt)),
                       int(max_tokens))
        self._lifecycle(req, "queued")
        pieces = original(prompt, max_tokens, temperature, top_k, stops, info)
        local = self._local
        try:
            while True:
                local.request = req                  # read by the model proxy once the engine lock is held
                try:
                    piece = next(pieces)
                except StopIteration:
                    break
                finally:
                    local.request = None
                yield piece
        except GeneratorExit:
            pieces.close()                           # releases the engine lock and closes the model stream
            self._end_stream(req)
            self._lifecycle(req, "cancelled", "cancelled")
            raise
        except BaseException:
            pieces.close()
            self._end_stream(req)
            self._lifecycle(req, "failed", "error")
            raise
        self._end_stream(req)
        self._lifecycle(req, "completed", info["finish_reason"])

    def _traced(self, req, ids, tokens):
        """The model's token stream as seen by the engine; runs while the engine lock is held."""
        if req is None:                              # model.stream() called outside an instrumented run
            yield from tokens
            return
        self._start_stream(req, ids)
        try:
            for token in tokens:
                self._yielded(req, token)
                yield token
        finally:
            tokens.close()
            self._end_stream(req)

    def _start_stream(self, req, ids):
        with self.stream.event_lock:
            if self._active is not None and self._active is not req:
                self._end_stream(self._active)       # its model stream was never closed
            req.prompt_ids = list(ids)
            req.prompt_tokens = len(req.prompt_ids)
            self._active = req
            self.request_id = req.request_id
            self.current_t = -1

    def _end_stream(self, req):
        """Idempotent: report a yielded token no step processed, then stop attributing steps to `req`."""
        with self.stream.event_lock:
            if req.pending is not None:
                index, token, text, raw, emit_ns = req.pending
                req.pending = None
                if self.stream.listening:
                    self._token_step(req, "completion", index, token, text, raw, "unprocessed", -1, 0, emit_ns)
            if self._active is req:
                self._active = None
                self.request_id = None
                self.current_t = -1

    def _yielded(self, req, token):
        emit_ns = time.time_ns()
        index = req.completion_tokens
        req.completion_tokens += 1
        raw = ENC.decode_single_token_bytes(token)
        req.pending = (index, token, req.completion_decoder.decode(raw), raw.hex(), emit_ns)
        if index == 0:
            self._lifecycle(req, "decode")

    # ---- hooks on model.kc_code_module(block) ----------------------------------------------------
    def _before_step(self, module, inputs):
        req = self._active
        if req is None:
            return
        self.current_t = self.stream.t           # before the fire hook advances it
        if not req.prefill_sent:
            req.prefill_sent = True
            req.t_start = self.current_t
            self._lifecycle(req, "prefill")

    def _after_step(self, module, inputs, code):
        req = self._active
        if req is None:
            return
        step_ns = time.time_ns()
        if req.prompt_index < len(req.prompt_ids):
            index, kind = req.prompt_index, "prompt"
            req.prompt_index += 1
            token = req.prompt_ids[index]
            raw = ENC.decode_single_token_bytes(token)
            text, raw, emit_ns = req.prompt_decoder.decode(raw), raw.hex(), step_ns
        elif req.pending is not None:
            kind = "completion"
            (index, token, text, raw, emit_ns), req.pending = req.pending, None
        else:
            return                                   # a step with no token of this request
        if self.stream.listening:
            status = "stepped_fired" if bool((code[0, -1] > 0).any()) else "stepped_silent"
            self._token_step(req, kind, index, token, text, raw, status, self.current_t, step_ns, emit_ns)
