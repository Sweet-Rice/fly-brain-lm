"""Opt-in telemetry server: same OpenAI-compatible API and visualization stream as
model.serve.serve, plus request_lifecycle/token_step/stream_status extension messages.

Usage:
    python -m harness.telemetry.serve --ckpt model/checkpoints/init.pt --port 8000 --viz-port 8765 --record run.ndjson
"""
import argparse
import hashlib
from pathlib import Path


def checkpoint_digest(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return "sha256:" + h.hexdigest()[:12]


def main(argv=None):
    from harness.telemetry.adapter import TelemetryAdapter
    from harness.viz_stream import stream_model
    from model.model import LEGACY_IMPL, load_checkpoint
    from model.serve.serve import Engine, make_server

    p = argparse.ArgumentParser(description=__doc__)
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
    a = p.parse_args(argv)

    model, wiring, ck = load_checkpoint(a.ckpt, a.device)
    digest = checkpoint_digest(a.ckpt)
    impl = ck.get("impl", LEGACY_IMPL)
    engine = Engine(model, a.model_id, a.ctx, a.max_tokens, a.seed)
    srv = make_server(engine, a.host, a.port, a.api_key)
    stream = stream_model(model, wiring, a.block, port=a.viz_port, record=a.record)[0]
    adapter = TelemetryAdapter(model, stream, block=a.block, impl=impl, model_id=a.model_id, ckpt_digest=digest)
    adapter.wrap_engine(engine)
    note = ck.get("note", "")
    lines = []
    if note:
        lines.append(note)
    lines.append(
        f"model {a.model_id}: {wiring.mask.shape[0]} KCs x {wiring.mask.shape[1]} glomeruli, "
        f"device {a.device}"
    )
    lines.append(f"OpenAI-compatible API at http://{a.host}:{srv.server_address[1]}/v1  (Ctrl-C to stop)")
    lines.append(f"visualization stream: {stream.url}  (block {a.block})")
    lines.append(f"telemetry: run {adapter.run_id} impl {impl} ckpt {digest}")
    if a.record:
        lines.append(f"recording: {a.record}")
    print("\n".join(lines), flush=True)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        adapter.remove()
        stream.close()


if __name__ == "__main__":
    main()
