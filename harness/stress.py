"""Reproducible real-topology stress fixture, producer profile, and live browser feed.

Run ``python -m harness.stress --help``. Timing is synthetic; no trained model is claimed.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import statistics
import time

from harness import viz_stream

CAPTURE = Path(__file__).parent / "example" / "once_upon_a_time.ndjson"


def fixture():
    """Use every captured model edge and rotate the actual top-94 KC activity size."""
    with CAPTURE.open(encoding="utf-8") as source:
        mapping = json.loads(next(source))
    kcs = [node["id"] for node in mapping["nodes"] if node["group"] in (1, 2, 3)]
    indices = {node: index for index, node in enumerate(kcs)}
    pairs = [[] for _ in kcs]
    for edge in mapping["edges"]:
        kc = edge[1] if edge[1] in indices else edge[0]
        pairs[indices[kc]].append(edge)
    return mapping, pairs


def fire_fixture(kc_pairs, step):
    return [pair for offset in range(94)
            for pair in kc_pairs[(step * 94 + offset) % len(kc_pairs)]]


def timing(samples):
    ordered = sorted(samples)
    return {"p50_ms": statistics.median(ordered),
            "p95_ms": ordered[min(len(ordered) - 1, int(len(ordered) * .95))]}


def profile(module=viz_stream, events=2000):
    mapping, pairs = fixture()
    graph = object.__new__(module.FlyGraph)
    graph.kc_pairs = pairs
    serialized, extraction, enqueue = [], [], []
    for _ in range(20):
        start = time.perf_counter()
        raw = json.dumps(mapping, separators=(",", ":"))
        serialized.append((time.perf_counter() - start) * 1000)

    class StalledLoop:
        def __init__(self):
            self.callbacks = []

        def call_soon_threadsafe(self, callback, *args):
            self.callbacks.append((callback, args))

    stream = module.VizStream(port=0, queue_size=64)
    stream.set_mapping(mapping)
    stream._loop = StalledLoop()
    stream._n_clients = 2
    for step in range(events):
        active = [(step * 94 + offset) % len(pairs) for offset in range(94)]
        start = time.perf_counter()
        fired = graph.fire_pairs(active)
        extraction.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        stream.fire(fired)
        enqueue.append((time.perf_counter() - start) * 1000)
    pending = getattr(stream, "_pending", ())
    callbacks = stream._loop.callbacks
    retained_bytes = sum(len(args[0].encode()) for _, args in callbacks if args)
    retained_bytes += sum(len(args[0].encode()) for _, args in pending if args)
    return {"nodes": len(mapping["nodes"]), "edges": len(mapping["edges"]),
            "active_kcs": 94, "events": events, "mapping_json_bytes": len(raw.encode()),
            "mapping_serialization": timing(serialized), "activity_extraction": timing(extraction),
            "fire_serialization_and_enqueue": timing(enqueue),
            "stalled_loop_callbacks": len(stream._loop.callbacks),
            "stalled_loop_pending": len(pending), "dropped_client_fires": stream.dropped,
            "stalled_loop_retained_json_bytes": retained_bytes,
            "note": "Stalled loop is deterministic; socket/file stalls are covered by tests."}


def model_profile(events=2000):
    """Measure the real default model's mapping and CPU hook extraction, without full inference."""
    import numpy as np
    import torch
    from model.model import Config, FlyLM, Wiring

    torch.set_num_threads(1)
    torch.manual_seed(0)
    path = Path(__file__).parents[1] / "data" / "connectome" / "wiring.npz"
    with np.load(path, allow_pickle=False) as source:
        wiring = Wiring(torch.from_numpy(source["mask"]).bool(),
                        torch.from_numpy(source["theta"]).float(),
                        torch.from_numpy(source["kc_class"]).long())
    config = Config.from_wiring(wiring)
    model = FlyLM(config, wiring).eval()
    graph = viz_stream.FlyGraph(model)
    captured, _ = fixture()
    refresh, hook, gather = [], [], []
    for _ in range(20):
        start = time.perf_counter()
        graph.refresh()
        refresh.append((time.perf_counter() - start) * 1000)
    with torch.inference_mode():
        code = model.blocks[0].addr(torch.randn(1, 1, config.d_model))
    for _ in range(events):
        start = time.perf_counter()
        active = (code[0, 0].detach() > 0).nonzero().flatten().tolist()
        hook.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        pairs = graph.fire_pairs(active)
        gather.append((time.perf_counter() - start) * 1000)
    return {
        "wiring": str(path), "torch": torch.__version__, "threads": torch.get_num_threads(),
        "config": {name: getattr(config, name) for name in
                   ("vocab_size", "d_model", "n_layer", "n_glom", "n_kc", "top_k", "heads_per_lobe")},
        "mapping_exactly_matches_capture": graph.mapping == captured,
        "mapping_groups_and_nodes_match_capture": all(graph.mapping[key] == captured[key] for key in ("groups", "nodes")),
        "mapping_edge_set_matches_capture": {tuple(pair) for pair in graph.mapping["edges"]} ==
                                            {tuple(pair) for pair in captured["edges"]},
        "nodes": len(graph.mapping["nodes"]), "edges": len(graph.mapping["edges"]),
        "positive_kcs": len(active), "fire_pairs": len(pairs), "events": events,
        "mapping_refresh": timing(refresh), "cpu_hook_extraction": timing(hook),
        "pair_gather": timing(gather),
        "note": "Full default untrained CPU model, actual connectome wiring, block-0 address output. "
                "Hook extraction repeats one code tensor; excludes full token inference, training, and GPU-to-CPU transfer.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="Also profile a saved viz_stream.py")
    parser.add_argument("--events", type=int, default=2000)
    parser.add_argument("--model", action="store_true", help="Also profile the actual default CPU model's mapping and hook")
    parser.add_argument("--serve", action="store_true", help="Serve synthetic top-94 activity for browser checks")
    parser.add_argument("--rate", type=float, default=60)
    parser.add_argument("--seconds", type=float, default=30)
    args = parser.parse_args()
    if args.events < 1 or not all(math.isfinite(value) and value > 0 for value in (args.rate, args.seconds)):
        parser.error("events, rate, and seconds must be positive")
    if args.model and args.serve:
        parser.error("--model is for profiling only; omit --serve")
    if args.serve:
        mapping, pairs = fixture()
        stream = viz_stream.VizStream(port=0)
        stream.set_mapping(mapping)
        stream.start()
        print(stream.url, flush=True)
        try:
            if stream.wait_for_harness(60):
                start = time.perf_counter()
                for step in range(int(args.seconds * args.rate)):
                    stream.fire(fire_fixture(pairs, step))
                    time.sleep(max(0, start + (step + 1) / args.rate - time.perf_counter()))
                print(json.dumps({"events": stream.t, "dropped": stream.dropped,
                                  "harnesses_seen": stream.harnesses_seen}), flush=True)
        finally:
            stream.close()
    else:
        results = {}
        if args.baseline:
            spec = importlib.util.spec_from_file_location("before_viz_stream", args.baseline)
            baseline = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(baseline)
            results["before"] = profile(baseline, args.events)
        results["after"] = profile(events=args.events)
        if args.model:
            results["model"] = model_profile(args.events)
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
