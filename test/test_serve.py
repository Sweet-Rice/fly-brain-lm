"""Starts the API on a free port with a tiny model and calls it like a harness would."""
import json
import threading
import urllib.request
from importlib import import_module

import pytest
import torch

from model.model import IMPLEMENTATIONS
from model.serve.serve import Engine, make_server
from model.wiring import Wiring

vibe = import_module(f"{IMPLEMENTATIONS['vibe']}.model")
Config, FlyLM = vibe.Config, vibe.FlyLM

@pytest.fixture(scope="module")
def base():
    torch.manual_seed(0)
    model = FlyLM(Config(d_model=64, n_layer=2), Wiring.random()).eval()
    srv = make_server(Engine(model, max_tokens_cap=16), port=0)     # port 0 = any free port
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def call(url, body=None):
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer x"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode()


def test_models(base):
    assert json.loads(call(base + "/v1/models"))["data"][0]["id"] == "flybrain-untrained"


def test_chat(base):
    r = json.loads(call(base + "/v1/chat/completions", {
        "model": "flybrain-untrained", "max_tokens": 8,
        "messages": [{"role": "system", "content": "you are a fly"},
                     {"role": "user", "content": [{"type": "text", "text": "fix my bug"}]}]}))
    c = r["choices"][0]
    assert r["object"] == "chat.completion" and c["message"]["role"] == "assistant"
    assert isinstance(c["message"]["content"], str) and c["finish_reason"] in ("stop", "length")
    assert 1 <= r["usage"]["completion_tokens"] <= 8


def test_completion(base):
    r = json.loads(call(base + "/v1/completions", {"prompt": "Once upon a time", "max_tokens": 4}))
    assert r["object"] == "text_completion" and isinstance(r["choices"][0]["text"], str)


def test_chat_stream(base):
    raw = call(base + "/v1/chat/completions", {
        "messages": [{"role": "user", "content": "hi"}], "max_tokens": 6, "stream": True,
        "stream_options": {"include_usage": True}})
    events = [l[6:] for l in raw.split("\n") if l.startswith("data: ")]
    assert events[-1] == "[DONE]"
    chunks = [json.loads(e) for e in events[:-1]]
    assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
    assert any(c["choices"] and c["choices"][0]["finish_reason"] for c in chunks)
    assert chunks[-1]["usage"]["completion_tokens"] >= 1


def test_bad_request(base):
    with pytest.raises(urllib.error.HTTPError) as e:
        call(base + "/v1/chat/completions", {"messages": "nope"})
    assert e.value.code == 400
