"""Run the real, untrained model through the live visualization workflow on CPU.

Without --serve, check reconnect, mapping replacement, recording and hook removal.
With --serve, keep generating actual model activity for the browser until Ctrl-C.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import platform
import tempfile
import time

from websockets.sync.client import connect

from harness.viz_stream import FlyGraph, VizStream, attach

ROOT = Path(__file__).resolve().parents[1]
PROMPT = "Once upon a time"
SEED = 0
MAX_NEW_TOKENS = 8
TIMEOUT = 5


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _receive_mapping(ws, expected):
    mapping = json.loads(ws.recv(timeout=TIMEOUT))
    assert mapping == expected, "a connection or replacement must begin with the current mapping"
    assert mapping["type"] == "mapping" and mapping["version"] == 1
    nodes = {node["id"] for node in mapping["nodes"]}
    edges = {tuple(pair) for pair in mapping["edges"]}
    assert len(edges) == len(mapping["edges"])
    assert all(src in nodes and dst in nodes for src, dst in edges)
    return edges


def _receive_fires(ws, edges, start, count):
    for expected_t in range(start, start + count):
        fire = json.loads(ws.recv(timeout=TIMEOUT))
        assert fire["type"] == "fire" and fire["t"] == expected_t
        pairs = [tuple(pair) for pair in fire["pairs"]]
        assert pairs and len(pairs) == len(set(pairs)) and set(pairs) <= edges


def run_workflow(record=None, *, serve=False, port=0, path="/stream"):
    """Return provenance after a checked smoke run or a cleanly interrupted browser demo."""
    import tiktoken
    import torch

    from data.build_wiring import load_wiring
    from model.model import Config, FlyLM, TEMPORARY_NOTE

    if record is None and not serve:
        with tempfile.TemporaryDirectory(prefix="flybrain-workflow-") as directory:
            return run_workflow(Path(directory) / "workflow.ndjson", port=port, path=path)
    record = Path(record) if record is not None else None
    metadata_path = Path(str(record) + ".metadata.json") if record else None
    if record:
        if record.exists():
            raise FileExistsError(record)
        if metadata_path.exists():
            raise FileExistsError(metadata_path)

    torch.set_num_threads(1)
    torch.manual_seed(SEED)
    wiring_path = ROOT / "data/connectome/wiring.npz"
    wiring = load_wiring(wiring_path)
    model = FlyLM(Config.from_wiring(wiring), wiring).eval()
    encoding = tiktoken.get_encoding("gpt2")
    prompt_ids = encoding.encode(PROMPT)
    graph = FlyGraph(model)
    if record:
        # VizStream owns writing; reserve only after initialization, never overwrite a recording.
        record.open("x", encoding="utf-8").close()
    stream = VizStream(port=port, path=path, record=str(record) if record else None)
    stream.set_mapping(graph.mapping)
    hook = attach(model, stream, graph)
    pace_hook = None
    rounds, steps, epochs = 0, 0, 1
    generated_ids = []
    disabled_equal = None

    def generate():
        nonlocal rounds, steps, generated_ids
        start = stream.t
        generated_ids = []
        try:
            for token in model.stream(prompt_ids, MAX_NEW_TOKENS, temperature=0,
                                      stop_ids=(encoding.eot_token,)):
                generated_ids.append(token)
        finally:
            count = stream.t - start
            steps += count
        assert count == len(prompt_ids) + len(generated_ids) - 1
        rounds += 1
        print(f"round {rounds}: epoch {epochs}, t={start}..{stream.t - 1}, "
              f"generated_ids={generated_ids}", flush=True)
        return start, count

    try:
        stream.start()
        print(f"visualization stream: {stream.url}", flush=True)
        print(f"UNTRAINED seed {SEED}: {model.cfg.n_layer} blocks, d_model={model.cfg.d_model}; "
              f"{len(graph.mapping['nodes'])} nodes, {len(graph.mapping['edges'])} edges", flush=True)
        if serve:
            # Pace the real address-hook calls, including prompt tokens; never manufacture fires.
            pace_hook = model.blocks[0].addr.register_forward_hook(lambda *_: time.sleep(0.1))
            try:
                while True:
                    generate()
                    time.sleep(1)
                    if rounds % 3 == 0:
                        stream.set_mapping(graph.refresh())
                        epochs += 1
                        print(f"replacement mapping: epoch {epochs}; next model step t=0", flush=True)
            except KeyboardInterrupt:
                pass
        else:
            with connect(stream.url, open_timeout=TIMEOUT, close_timeout=TIMEOUT, max_size=None) as ws:
                edges = _receive_mapping(ws, graph.mapping)
                start, count = generate()
                _receive_fires(ws, edges, start, count)
            # Inference and recording continue while no browser is connected.
            deadline = time.monotonic() + TIMEOUT
            while stream.wait_for_harness(0):
                assert time.monotonic() < deadline, "the observer did not disconnect"
                time.sleep(0.005)
            generate()
            reconnect_t = stream.t
            with connect(stream.url, open_timeout=TIMEOUT, close_timeout=TIMEOUT, max_size=None) as ws:
                edges = _receive_mapping(ws, graph.mapping)
                start, count = generate()
                assert start == reconnect_t > 0
                _receive_fires(ws, edges, start, count)
                stream.set_mapping(graph.refresh())
                epochs += 1
                edges = _receive_mapping(ws, graph.mapping)
                start, count = generate()
                assert start == 0
                _receive_fires(ws, edges, start, count)
            hook.remove()
            before = stream.t
            disabled_ids = list(model.stream(prompt_ids, MAX_NEW_TOKENS, temperature=0,
                                            stop_ids=(encoding.eot_token,)))
            disabled_equal = disabled_ids == generated_ids and stream.t == before
            assert disabled_equal, "visualization must not change generated tokens"
    finally:
        if pace_hook:
            pace_hook.remove()
        hook.remove()
        stream.close()

    if stream.recording_error:
        raise RuntimeError("workflow recording failed") from stream.recording_error
    assert stream.dropped == stream.recording_dropped == 0, "the workflow lost activity"
    config = asdict(model.cfg)
    config["half_life_init"] = list(config["half_life_init"])
    metadata = {
        "generator": "python -m harness.workflow",
        "mode": "serve" if serve else "smoke",
        "model_note": TEMPORARY_NOTE,
        "seed": SEED,
        "device": "cpu",
        "torch_threads": 1,
        "torch_version": torch.__version__,
        "python_version": platform.python_version(),
        "config": config,
        "prompt": PROMPT,
        "tokenizer": "gpt2",
        "prompt_ids": prompt_ids,
        "max_new_tokens": MAX_NEW_TOKENS,
        "temperature": 0,
        "stop_ids": [encoding.eot_token],
        "generated_ids": generated_ids,
        "rounds": rounds,
        "epochs": epochs,
        "steps": steps,
        "last_epoch_steps": stream.t,
        "network_dropped": stream.dropped,
        "recording_dropped": stream.recording_dropped,
        "visualization_disabled_identical": disabled_equal,
        "topology": {key: len(graph.mapping[key]) for key in ("groups", "nodes", "edges")},
        "wiring_sha256": _sha256(wiring_path),
        "source_hash_newlines": "lf",
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
                          for name in (
            "harness/workflow.py", "harness/viz_stream.py", "model/model.py", "data/build_wiring.py")},
        "recording_sha256": _sha256(record) if record else None,
    }
    if metadata_path:
        with metadata_path.open("x", encoding="utf-8", newline="\n") as output:
            output.write(json.dumps(metadata, indent=2) + "\n")
        print(f"recording: {record}\nprovenance: {metadata_path}", flush=True)
    print(f"{'DEMO STOPPED' if serve else 'PASS'}: {rounds} real-model rounds, {steps} steps, {epochs} mapping epochs; "
          f"visualization-disabled equality={disabled_equal}", flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true", help="keep generating for the browser until Ctrl-C")
    parser.add_argument("--port", type=int, default=0, help="loopback WebSocket port (0 chooses a free port)")
    parser.add_argument("--path", default="/stream", help="WebSocket path")
    parser.add_argument("--record", type=Path, help="new NDJSON file; writes a .metadata.json sidecar")
    args = parser.parse_args()
    run_workflow(args.record, serve=args.serve, port=args.port, path=args.path)


if __name__ == "__main__":
    main()
