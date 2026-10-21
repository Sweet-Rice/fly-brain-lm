"""Measure full-model inference overhead for opt-in activity instrumentation.

Run ``python -m harness.profile_activity``. CUDA measurements synchronize only
at inference boundaries; the enabled hook's CPU transfer and extraction are included.
"""
import argparse
from contextlib import ExitStack
from dataclasses import asdict
import json
import platform
from pathlib import Path
import tempfile
import time

from websockets.sync.client import connect

from harness.stress import timing
from harness.viz_stream import FlyGraph, VizStream, attach
from harness.workflow import ROOT, SEED

PROMPT_IDS = [7454, 2402, 257, 640]


def profile_activity(repeat=30, warmup=5, device="cpu"):
    """Compare identical four-token forwards of the default real-wiring model."""
    if type(repeat) is not int or repeat < 1 or type(warmup) is not int or warmup < 0:
        raise ValueError("repeat must be positive and warmup must be nonnegative integers")
    if device not in ("cpu", "cuda"):
        raise ValueError("device must be cpu or cuda")
    import torch
    from data.build_wiring import load_wiring
    from model.model import Config, FlyLM, TEMPORARY_NOTE

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable; no GPU measurements were made")
    threads = torch.get_num_threads()
    try:
        torch.set_num_threads(1)
        with torch.random.fork_rng(devices=[torch.cuda.current_device()] if device == "cuda" else []):
            torch.random.default_generator.manual_seed(SEED)
            wiring = load_wiring(ROOT / "data/connectome/wiring.npz")
            model = FlyLM(Config.from_wiring(wiring), wiring).to(device).eval()
            graph = FlyGraph(model)
            inputs = torch.tensor([PROMPT_IDS], device=device)
            results = {}
            with tempfile.TemporaryDirectory(prefix="flybrain-activity-profile-") as directory, torch.inference_mode():
                reference, _ = model(inputs)
                for mode in ("disabled", "idle", "recording", "live"):
                    samples = []
                    stream, ws = None, None
                    recording = Path(directory) / "activity.ndjson"
                    with ExitStack() as cleanup:
                        if mode != "disabled":
                            stream = VizStream(port=0, record=str(recording) if mode == "recording" else None)
                            cleanup.callback(stream.close)
                            stream.set_mapping(graph.mapping)
                            stream.start()
                            hook = attach(model, stream, graph)
                            cleanup.callback(hook.remove)
                            if mode == "live":
                                ws = cleanup.enter_context(connect(stream.url, max_size=None))
                                assert json.loads(ws.recv(timeout=5)) == graph.mapping
                        for iteration in range(warmup + repeat):
                            if device == "cuda":
                                torch.cuda.synchronize()
                            start = time.perf_counter()
                            logits, _ = model(inputs)
                            if device == "cuda":
                                torch.cuda.synchronize()
                            elapsed = (time.perf_counter() - start) * 1000
                            if iteration >= warmup:
                                samples.append(elapsed)
                            assert torch.equal(logits, reference), "instrumentation changed model logits"
                            if ws:
                                for token in range(len(PROMPT_IDS)):
                                    fire = json.loads(ws.recv(timeout=5))
                                    assert fire["type"] == "fire"
                                    assert fire["t"] == iteration * len(PROMPT_IDS) + token
                                    assert fire["pairs"]
                    result = timing(samples)
                    result["samples"] = len(samples)
                    result["identical_logits"] = True
                    result["steps"] = stream.t if stream else 0
                    result["network_dropped"] = stream.dropped if stream else 0
                    result["recording_dropped"] = stream.recording_dropped if stream else 0
                    assert result["network_dropped"] == result["recording_dropped"] == 0
                    if mode == "recording":
                        assert stream.recording_error is None
                        with recording.open(encoding="utf-8") as source:
                            result["recording_lines"] = sum(1 for _ in source)
                        assert result["recording_lines"] == 1 + stream.t
                    results[mode] = result
            baseline = results["disabled"]["p50_ms"]
            for result in results.values():
                result["p50_overhead_percent"] = 100 * (result["p50_ms"] / baseline - 1)
            return {
                "model_note": TEMPORARY_NOTE, "config": asdict(model.cfg), "seed": SEED,
                "prompt_ids": PROMPT_IDS, "repeat": repeat, "warmup": warmup,
                "device": device, "device_name": torch.cuda.get_device_name() if device == "cuda" else platform.processor(),
                "torch": torch.__version__, "python": platform.python_version(), "platform": platform.platform(),
                "threads": 1, "nodes": len(graph.mapping["nodes"]), "edges": len(graph.mapping["edges"]),
                "modes": results,
                "note": "Four-token forward, batch 1, no autograd; model setup, mapping, equality checks and "
                        "socket receipt excluded. Recording and socket writers run concurrently. "
                        "CUDA synchronizes at each inference boundary; the enabled hook also copies its positivity "
                        "mask to CPU once per address output, then extracts indices on CPU. "
                        "Negative overhead is measurement noise; timings are not CI thresholds.",
            }
    finally:
        torch.set_num_threads(threads)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.repeat < 1 or args.warmup < 0:
        parser.error("repeat must be positive and warmup must be nonnegative")
    print(json.dumps(profile_activity(args.repeat, args.warmup, args.device), indent=2))


if __name__ == "__main__":
    main()
