"""TEMPORARY: OpenAI-compatible HTTP API for FlyBrainLM, so an agent harness can call it.

Any client that speaks the OpenAI API works (Oh-My-Pi, Goose, LiteLLM, the openai SDK, curl):
    base URL  http://127.0.0.1:8000/v1      model  flybrain-untrained      API key  anything
Endpoints: GET /v1/models, POST /v1/completions, POST /v1/chat/completions (stream or not), GET /health

The model is UNTRAINED, so replies are gibberish. That is the joke (project app #2).
Limits: no tool calls (replies are plain text), one request at a time, prompt cut to the last
--ctx tokens (a harness's long system prompt mostly falls off the front).

Every request also streams to the visualization harness (Fly Brain Visualization Stream Spec v1) at
ws://127.0.0.1:8765/stream: a harness that connects gets the mapping first, then one `fire` per token
of every request. --no-viz turns that off (e.g. when ask.py already holds the port).

Usage (from the repo root):
        python -m model.serve.serve                           # loads model/checkpoints/init.pt, CPU
        python -m model.serve.serve --device cuda --port 8001 # ROCm also uses the name "cuda"
        python -m model.serve.serve --record api.ndjson       # also save the visualization stream
"""
import argparse
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import tiktoken
import torch

ENC = tiktoken.get_encoding("gpt2")
EOT = ENC.eot_token


def content_text(c):
    """OpenAI message content is a string or a list of parts like {"type": "text", "text": ...}."""
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""


def chat_prompt(messages):
    lines = [f"{m.get('role', 'user')}: {content_text(m.get('content'))}" for m in messages]
    return "\n".join(lines) + "\nassistant:"


def first_stop(text, stops):
    hits = [i for i in (text.find(s) for s in stops) if i >= 0]
    return min(hits) if hits else None


class Engine:
    def __init__(self, model, model_id="flybrain-untrained", ctx=256, max_tokens_cap=128, seed=0):
        self.model, self.id, self.ctx, self.cap = model, model_id, ctx, max_tokens_cap
        self.lock = threading.Lock()                          # one generation at a time
        self.gen = torch.Generator().manual_seed(seed)

    def run(self, prompt, max_tokens, temperature, top_k, stops, info):
        """Generator of text pieces. Fills info: prompt_tokens, completion_tokens, finish_reason."""
        ids = ENC.encode_ordinary(prompt)[-self.ctx:] or [EOT]
        info.update(prompt_tokens=len(ids), completion_tokens=0, finish_reason="length")
        hold = max((len(s) - 1 for s in stops), default=0)    # don't emit what may be the start of a stop string
        out, sent = [], 0
        with self.lock:
            for tok in self.model.stream(ids, max_tokens, temperature, top_k, stop_ids=(EOT,), gen=self.gen):
                info["completion_tokens"] += 1
                if tok == EOT:
                    info["finish_reason"] = "stop"
                    break
                out.append(tok)
                text = ENC.decode(out)
                if text.endswith("�"):                   # half of a multi-byte character; wait
                    continue
                cut = first_stop(text, stops)
                if cut is not None:
                    info["finish_reason"] = "stop"
                    if cut > sent:
                        yield text[sent:cut]
                    return
                if len(text) - hold > sent:
                    yield text[sent:len(text) - hold]
                    sent = len(text) - hold
            text = ENC.decode(out)
            cut = first_stop(text, stops)
            if cut is not None:
                info["finish_reason"] = "stop"
            end = len(text) if cut is None else cut
            if end > sent:
                yield text[sent:end]


def params(body, engine):
    mt = body.get("max_tokens") or body.get("max_completion_tokens") or 64
    stop = body.get("stop") or []
    return dict(max_tokens=max(1, min(int(mt), engine.cap)),
                temperature=float(body.get("temperature", 1.0)),
                top_k=body.get("top_k") or 50,
                stops=[stop] if isinstance(stop, str) else list(stop))


def make_handler(engine, api_key=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print(f"[serve] {self.address_string()} {fmt % args}")

        def _json(self, code, obj):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _error(self, code, msg, kind="invalid_request_error"):
            self._json(code, {"error": {"message": msg, "type": kind}})

        def _authorized(self):
            if api_key and self.headers.get("Authorization", "") != f"Bearer {api_key}":
                self._error(401, "bad API key", "authentication_error")
                return False
            return True

        def do_GET(self):
            if not self._authorized():
                return
            if self.path.rstrip("/") in ("/v1/models", "/models"):
                self._json(200, {"object": "list", "data": [
                    {"id": engine.id, "object": "model", "created": 0, "owned_by": "flybrainlm"}]})
            elif self.path in ("/", "/health"):
                self._json(200, {"status": "ok", "model": engine.id, "note": "TEMPORARY, untrained"})
            else:
                self._error(404, f"no route {self.path}")

        def do_POST(self):
            if not self._authorized():
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            except json.JSONDecodeError:
                return self._error(400, "body is not valid JSON")
            route = self.path.rstrip("/").removeprefix("/v1")
            if route == "/chat/completions":
                if not isinstance(body.get("messages"), list):
                    return self._error(400, "'messages' must be a list")
                return self._complete(body, chat_prompt(body["messages"]), chat=True)
            if route == "/completions":
                prompt = body.get("prompt", "")
                prompt = prompt[0] if isinstance(prompt, list) and prompt else prompt
                if not isinstance(prompt, str):
                    return self._error(400, "'prompt' must be a string")
                return self._complete(body, prompt, chat=False)
            self._error(404, f"no route {self.path}")

        def _complete(self, body, prompt, chat):
            p, info = params(body, engine), {}
            rid = ("chatcmpl-" if chat else "cmpl-") + uuid.uuid4().hex[:24]
            created = int(time.time())
            base = dict(id=rid, created=created, model=engine.id)
            pieces = engine.run(prompt, p["max_tokens"], p["temperature"], p["top_k"], p["stops"], info)
            usage = lambda: dict(prompt_tokens=info["prompt_tokens"], completion_tokens=info["completion_tokens"],
                                 total_tokens=info["prompt_tokens"] + info["completion_tokens"])
            try:
                if not body.get("stream"):
                    text = "".join(pieces)
                    choice = (dict(index=0, message=dict(role="assistant", content=text),
                                   finish_reason=info["finish_reason"]) if chat else
                              dict(index=0, text=text, logprobs=None, finish_reason=info["finish_reason"]))
                    return self._json(200, dict(base, object="chat.completion" if chat else "text_completion",
                                                choices=[choice], usage=usage()))

                self.send_response(200)                     # Server-Sent Events: "data: {...}\n\n" per chunk
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                obj = "chat.completion.chunk" if chat else "text_completion"

                def send(choice, **extra):
                    self.wfile.write(f"data: {json.dumps(dict(base, object=obj, choices=[choice], **extra))}\n\n".encode())
                    self.wfile.flush()

                if chat:
                    send(dict(index=0, delta=dict(role="assistant", content=""), finish_reason=None))
                for piece in pieces:
                    send(dict(index=0, delta=dict(content=piece), finish_reason=None) if chat else
                         dict(index=0, text=piece, logprobs=None, finish_reason=None))
                send(dict(index=0, delta={}, finish_reason=info["finish_reason"]) if chat else
                     dict(index=0, text="", logprobs=None, finish_reason=info["finish_reason"]))
                if (body.get("stream_options") or {}).get("include_usage"):
                    self.wfile.write(f"data: {json.dumps(dict(base, object=obj, choices=[], usage=usage()))}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass                                        # client hung up mid-stream
            finally:
                pieces.close()                              # releases the engine lock

    return Handler


def make_server(engine, host="127.0.0.1", port=8000, api_key=None):
    return ThreadingHTTPServer((host, port), make_handler(engine, api_key))


def main():
    from harness.viz_stream import stream_model
    from model.model import load_checkpoint
    p = argparse.ArgumentParser()
    p.add_argument("--ckpt", default="model/checkpoints/init.pt")
    p.add_argument("--device", default="cpu")
    p.add_argument("--host", default="127.0.0.1")           # localhost only; use 0.0.0.0 to expose
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--model-id", default="flybrain-untrained")
    p.add_argument("--ctx", type=int, default=256, help="prompt tokens kept (from the end)")
    p.add_argument("--max-tokens", type=int, default=128, help="cap on tokens per reply")
    p.add_argument("--api-key", default=None, help="require this key; default accepts any")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--viz-port", type=int, default=8765, help="visualization stream port (loopback only)")
    p.add_argument("--block", type=int, default=0, help="which of the 12 blocks to visualize")
    p.add_argument("--record", default=None, help="also write the visualization stream to this .ndjson file")
    p.add_argument("--no-viz", action="store_true", help="don't stream to the visualization harness")
    a = p.parse_args()

    model, wiring, ck = load_checkpoint(a.ckpt, a.device)
    engine = Engine(model, a.model_id, a.ctx, a.max_tokens, a.seed)
    srv = make_server(engine, a.host, a.port, a.api_key)
    stream = None if a.no_viz else stream_model(model, wiring, a.block, port=a.viz_port, record=a.record)[0]
    print(f"{ck.get('note', '')}\nmodel {a.model_id}: {wiring.mask.shape[0]} KCs x {wiring.mask.shape[1]} glomeruli, "
          f"device {a.device}\nOpenAI-compatible API at http://{a.host}:{a.port}/v1  (Ctrl-C to stop)"
          + (f"\nvisualization stream: {stream.url}  (block {a.block})" if stream else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if stream:
            stream.close()


if __name__ == "__main__":
    main()
