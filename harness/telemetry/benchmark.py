"""Benchmark run and token telemetry overhead across modes.

Measures tokens/s and per-token latency (ms) for four modes:
  - disabled: visualization stream attached, no adapter, nobody listening
  - adapter idle: TelemetryAdapter attached and wrap_engine called, nobody listening
  - recording: adapter attached, recording to a temporary .ndjson file
  - live client: adapter attached, one live WebSocket client reading frames

Usage:
    python -m harness.telemetry.benchmark --requests 3 --max-tokens 48
"""
import argparse
import gc
from pathlib import Path
import platform
import statistics
import sys
import tempfile
import threading
import time

from websockets.sync.client import connect

from harness.telemetry.serve import checkpoint_digest
from harness.viz_stream import stream_model

ROOT = Path(__file__).resolve().parents[2]


class TimingModelProxy:
    """Outermost model proxy recording per-token generation timestamps."""

    def __init__(self, inner):
        self._inner = inner
        self.request_timings = []
        self._recording = False

    def start_timing(self):
        self._recording = True
        self.request_timings.clear()

    def stop_timing(self):
        self._recording = False

    def stream(self, *args, **kwargs):
        if not self._recording:
            yield from self._inner.stream(*args, **kwargs)
            return

        t0 = time.perf_counter_ns()
        timestamps = [t0]
        try:
            for tok in self._inner.stream(*args, **kwargs):
                timestamps.append(time.perf_counter_ns())
                yield tok
        finally:
            self.request_timings.append(timestamps)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def calc_percentiles(samples):
    if not samples:
        return 0.0, 0.0
    ordered = sorted(samples)
    p50 = statistics.median(ordered)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    return p50, p95


def build_or_load_model(args):
    import torch
    from data.build_wiring import load_wiring
    from model.model import LEGACY_IMPL, build_model, load_checkpoint, selected_impl

    if args.ckpt:
        model, wiring, ck = load_checkpoint(args.ckpt, args.device)
        ck_impl = ck.get("impl", LEGACY_IMPL)
        digest = checkpoint_digest(args.ckpt)
    else:
        torch.manual_seed(args.seed)
        wiring = load_wiring(ROOT / "data/connectome/wiring.npz")
        ck_impl = selected_impl(args.impl)
        model = build_model(wiring, ck_impl).to(args.device).eval()
        digest = "sha256:" + "0" * 12
    return model, wiring, ck_impl, digest


def run_request(engine, prompt, max_tokens):
    info = {}
    "".join(engine.run(prompt, max_tokens, 0.0, None, [], info))
    return info


def main(argv=None):
    import torch
    from harness.telemetry.adapter import TelemetryAdapter
    from model.serve.serve import Engine

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--impl", default="vibe2", help="model implementation when building without --ckpt")
    p.add_argument("--ckpt", default=None, help="checkpoint path (overrides --impl)")
    p.add_argument("--device", default="cpu", help="device for inference (default cpu)")
    p.add_argument("--threads", type=int, default=1, help="PyTorch CPU threads (default 1)")
    p.add_argument("--requests", type=int, default=3, help="number of timed requests per mode")
    p.add_argument("--max-tokens", type=int, default=48, help="maximum completion tokens per reply")
    p.add_argument("--prompt", default="Once upon a time, a fly", help="prompt text")
    p.add_argument("--seed", type=int, default=0, help="random seed")
    p.add_argument("--warmup", type=int, default=1, help="untimed warmup requests per mode")
    p.add_argument("--block", type=int, default=0, help="which of the 12 blocks to visualize")
    args = p.parse_args(argv)

    torch.set_num_threads(args.threads)

    modes = ["disabled", "adapter idle", "recording", "live client"]
    results = {}
    diagnostics = []
    ck_impl_name = None

    for mode in modes:
        temp_dir = None
        adapter = None
        stream = None
        engine = None
        proxy = None
        model = None
        wiring = None
        ws_holder = [None]
        stop_client = threading.Event()
        client_thread = None
        client_messages = 0

        try:
            model, wiring, ck_impl, digest = build_or_load_model(args)
            ck_impl_name = ck_impl
            record_path = None
            if mode == "recording":
                temp_dir = tempfile.TemporaryDirectory(prefix="flybrain-benchmark-")
                record_path = str(Path(temp_dir.name) / "stream.ndjson")

            stream = stream_model(model, wiring, args.block, port=0, record=record_path)[0]
            engine = Engine(model, ctx=256, max_tokens_cap=args.max_tokens, seed=args.seed)

            if mode in ("adapter idle", "recording", "live client"):
                adapter = TelemetryAdapter(
                    model, stream, block=args.block, impl=ck_impl, model_id="benchmark", ckpt_digest=digest
                )
                adapter.wrap_engine(engine)

            proxy = TimingModelProxy(engine.model)
            engine.model = proxy

            if mode == "live client":
                def client_worker():
                    nonlocal client_messages
                    try:
                        with connect(stream.url, max_size=None) as ws:
                            ws_holder[0] = ws
                            while not stop_client.is_set():
                                try:
                                    msg = ws.recv(timeout=0.1)
                                    if msg is not None:
                                        client_messages += 1
                                except TimeoutError:
                                    continue
                                except Exception:
                                    break
                    except Exception:
                        pass

                client_thread = threading.Thread(target=client_worker, daemon=True)
                client_thread.start()

                # wait until stream.listening before timing
                start_wait = time.perf_counter()
                while not stream.listening and (time.perf_counter() - start_wait < 5.0):
                    time.sleep(0.005)
                if not stream.listening:
                    raise RuntimeError("live client did not connect to the visualization stream")

            # Warmup
            for _ in range(args.warmup):
                run_request(engine, args.prompt, args.max_tokens)

            # Timed runs
            proxy.start_timing()
            wall_start = time.perf_counter()
            timed_infos = [run_request(engine, args.prompt, args.max_tokens) for _ in range(args.requests)]
            wall_time = time.perf_counter() - wall_start
            proxy.stop_timing()

            # Latency deltas
            decode_deltas_ms = []
            prefill_deltas_ms = []
            for req in proxy.request_timings:
                if len(req) >= 2:
                    prefill_deltas_ms.append((req[1] - req[0]) / 1_000_000.0)
                    for i in range(2, len(req)):
                        decode_deltas_ms.append((req[i] - req[i - 1]) / 1_000_000.0)

            samples = decode_deltas_ms if decode_deltas_ms else prefill_deltas_ms
            p50_ms, p95_ms = calc_percentiles(samples)

            total_completion = sum(info.get("completion_tokens", 0) for info in timed_infos)
            tokens_s = total_completion / wall_time if wall_time > 0 else 0.0

            results[mode] = {
                "tokens_s": tokens_s,
                "p50_ms": p50_ms,
                "p95_ms": p95_ms,
            }

            diag = {
                "mode": mode,
                "dropped": stream.dropped,
                "recording_dropped": stream.recording_dropped,
            }
            if mode == "live client":
                diag["client_messages"] = client_messages
            diagnostics.append(diag)

        finally:
            if mode == "live client":
                stop_client.set()
                if ws_holder[0] is not None:
                    try:
                        ws_holder[0].close()
                    except Exception:
                        pass
                if client_thread is not None:
                    client_thread.join(timeout=2.0)

            if adapter is not None:
                try:
                    adapter.remove()
                except Exception:
                    pass

            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

            if temp_dir is not None:
                try:
                    temp_dir.cleanup()
                except Exception:
                    pass

            engine = None
            proxy = None
            adapter = None
            stream = None
            model = None
            wiring = None
            gc.collect()

    baseline_tokens_s = results["disabled"]["tokens_s"]

    # Header line with machine info
    print(
        f"Machine: {platform.platform()} | {platform.processor()} | "
        f"PyTorch {torch.__version__} | threads={args.threads} | "
        f"impl={ck_impl_name} | {args.requests} requests x {args.max_tokens} max_tokens"
    )
    cmdline = " ".join([sys.executable] + sys.argv)
    print(f"Command: {cmdline}")
    print("tokens/s = completion tokens / wall time of the timed requests (includes prefill); "
          "per-token latency = time between consecutive generated tokens (prefill excluded)")
    print()

    # Markdown table
    print("| Mode | tokens/s | p50 ms/token | p95 ms/token | tokens/s vs disabled |")
    print("|---|---:|---:|---:|---:|")
    for mode in modes:
        res = results[mode]
        if mode == "disabled":
            vs = "baseline"
        else:
            delta = 100.0 * (res["tokens_s"] / baseline_tokens_s - 1.0) if baseline_tokens_s > 0 else 0.0
            vs = f"{delta:+.1f}%"
        print(f"| {mode} | {res['tokens_s']:.2f} | {res['p50_ms']:.2f} | {res['p95_ms']:.2f} | {vs} |")
    print()
    print("Mode diagnostics:")
    for d in diagnostics:
        extra = f", client_messages={d['client_messages']}" if "client_messages" in d else ""
        print(f"- {d['mode']}: stream_dropped={d['dropped']}, recording_dropped={d['recording_dropped']}{extra}")


if __name__ == "__main__":
    main()
