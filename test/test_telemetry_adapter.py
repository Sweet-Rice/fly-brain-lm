"""Tests for the FlyBrainLM run and token telemetry adapter and extension messages."""
import asyncio
import json
import re
import threading
import time
from pathlib import Path

import pytest
import torch
from jsonschema import Draft202012Validator
from websockets.asyncio.server import ServerConnection
from websockets.sync.client import connect

from data.build_wiring import load_wiring
from harness.telemetry.adapter import TelemetryAdapter
from harness.viz_stream import FlyGraph, VizStream, stream_model
from model.serve.serve import ENC, EOT, Engine
from model.vibe.model import Config, FlyLM
from test.test_protocol_contract import ContractReceiver

TIMEOUT = 5.0


def wait_until(cond, what, timeout=TIMEOUT):
    end = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < end, f"timed out after {timeout}s waiting for {what}"
        time.sleep(0.005)


def read_recording(path):
    p = Path(path)
    if not p.exists():
        return []
    lines = [line.strip() for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


class StalledSend:
    """One frame held inside the server's send to one client."""

    def __init__(self):
        self.target = None
        self.reached = threading.Event()
        self.release = threading.Event()
        self.passed = threading.Event()
        self.armed = True


class StalledRecording:
    """A file-like sink whose first write waits until released."""

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.lines = []
        self.closed = False

    def open(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def write(self, text):
        self.started.set()
        if not self.release.wait(TIMEOUT):
            raise TimeoutError("the test did not release the recording write")
        self.lines.append(text)
        return len(text)

    def flush(self):
        pass


class MessageCollector(threading.Thread):
    """Harness-style collector thread reading WebSocket messages until closed."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url = url
        self.msgs = []
        self.connected = threading.Event()
        self.stopped = threading.Event()
        self.ws = None

    def run(self):
        try:
            with connect(self.url, max_size=None) as ws:
                self.ws = ws
                self.connected.set()
                while not self.stopped.is_set():
                    try:
                        raw = ws.recv(timeout=0.1)
                        self.msgs.append(json.loads(raw))
                    except TimeoutError:
                        continue
                    except Exception:
                        break
        finally:
            self.connected.set()

    def close(self):
        self.stopped.set()
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        self.join(timeout=TIMEOUT)


@pytest.fixture(scope="module")
def wiring():
    return load_wiring(Path(__file__).parents[1] / "data/connectome/wiring.npz")


def build_pipeline(wiring, tmp_path=None, ctx=128, max_tokens_cap=16, seed=0, record=True, **stream_kwargs):
    torch.manual_seed(seed)
    model = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    rec_path = str(tmp_path / "recording.ndjson") if (record and tmp_path is not None) else None
    if rec_path is not None:
        Path(rec_path).parent.mkdir(parents=True, exist_ok=True)
    stream, graph = stream_model(model, wiring, 0, port=0, record=rec_path, **stream_kwargs)
    engine = Engine(model, ctx=ctx, max_tokens_cap=max_tokens_cap, seed=seed)
    adapter = TelemetryAdapter(
        model,
        stream,
        block=0,
        impl="vibe",
        model_id="flybrain-test",
        ckpt_digest="sha256:" + "0" * 12,
    )
    adapter.wrap_engine(engine)
    return model, stream, graph, engine, adapter, rec_path


def test_prefill_emits_contiguous_prompt_steps(wiring, tmp_path):
    ctx = 8
    prompt = "The quick brown fox jumps over the lazy dog and runs away"
    raw_ids = ENC.encode_ordinary(prompt)
    assert len(raw_ids) > ctx
    expected_ids = raw_ids[-ctx:]

    model, stream, graph, engine, adapter, rec_path = build_pipeline(
        wiring, tmp_path=tmp_path, ctx=ctx
    )
    try:
        info = {}
        "".join(engine.run(prompt, 4, 0.0, None, [], info))
    finally:
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    events = read_recording(rec_path)
    lifecycles = [e for e in events if e.get("type") == "request_lifecycle"]
    prefill = next(e for e in lifecycles if e.get("phase") == "prefill")

    assert prefill["prompt_raw_tokens"] > prefill["prompt_tokens"] == ctx == info["prompt_tokens"]
    t_start = prefill["t_start"]
    assert t_start >= 0

    prompt_steps = [e for e in events if e.get("type") == "token_step" and e.get("kind") == "prompt"]
    assert len(prompt_steps) == ctx

    fire_ts = {e["t"] for e in events if e.get("type") == "fire"}
    for idx, step in enumerate(prompt_steps):
        assert step["token_index"] == idx
        expected_id = expected_ids[idx]
        assert step["token_id"] == expected_id
        assert step["step_status"] in {"stepped_fired", "stepped_silent"}
        assert step["t"] == t_start + idx
        assert step["token_bytes"] == ENC.decode_single_token_bytes(expected_id).hex()
        if step["step_status"] == "stepped_fired":
            assert step["t"] in fire_ts


def test_max_tokens_one_final_token_unprocessed(wiring, tmp_path):
    # Part 1: max_tokens=1
    model1, stream1, graph1, engine1, adapter1, rec1 = build_pipeline(
        wiring, tmp_path=tmp_path / "part1", ctx=128
    )
    try:
        info1 = {}
        "".join(engine1.run("Hello world", 1, 0.0, None, [], info1))
    finally:
        adapter1.remove()
        stream1.close(drain_timeout=TIMEOUT)

    events1 = read_recording(rec1)
    comp_steps1 = [e for e in events1 if e.get("type") == "token_step" and e.get("kind") == "completion"]
    assert len(comp_steps1) == 1
    step0 = comp_steps1[0]
    assert step0["token_index"] == 0
    assert step0["step_status"] == "unprocessed"
    assert step0["t"] == -1
    assert step0["step_rel_us"] == 0
    assert step0["step_ns"] == "0"

    completed1 = next(e for e in events1 if e.get("type") == "request_lifecycle" and e.get("phase") == "completed")
    assert completed1["completion_tokens"] == 1
    if step0["token_id"] == EOT:
        assert completed1["finish_reason"] == "stop"
    else:
        assert completed1["finish_reason"] == "length"

    # Part 2: max_tokens=3
    model2, stream2, graph2, engine2, adapter2, rec2 = build_pipeline(
        wiring, tmp_path=tmp_path / "part2", ctx=128
    )
    try:
        info2 = {}
        "".join(engine2.run("Hello world", 3, 0.0, None, [], info2))
    finally:
        adapter2.remove()
        stream2.close(drain_timeout=TIMEOUT)

    events2 = read_recording(rec2)
    comp_steps2 = [e for e in events2 if e.get("type") == "token_step" and e.get("kind") == "completion"]
    assert info2["completion_tokens"] == 3 and info2["finish_reason"] == "length"   # greedy, seeded: no EOT
    assert len(comp_steps2) == 3
    prefill2 = next(e for e in events2 if e.get("type") == "request_lifecycle" and e.get("phase") == "prefill")
    t_start2 = prefill2["t_start"]
    P2 = prefill2["prompt_tokens"]
    for i in (0, 1):
        s = comp_steps2[i]
        assert s["token_index"] == i
        assert s["step_status"] in {"stepped_fired", "stepped_silent"}
        assert s["t"] == t_start2 + P2 + i
    s2 = comp_steps2[2]
    assert s2["token_index"] == 2
    assert s2["step_status"] == "unprocessed"
    assert s2["t"] == -1
    assert s2["step_rel_us"] == 0
    assert s2["step_ns"] == "0"
    fire_ts2 = [e["t"] for e in events2 if e.get("type") == "fire"]
    assert all(t < t_start2 + P2 + 2 for t in fire_ts2)


def test_stop_sequence_final_token_unprocessed(wiring, tmp_path):
    seed = 42
    model1, stream1, graph1, engine1, adapter1, rec1 = build_pipeline(
        wiring, tmp_path=tmp_path / "run1", ctx=128, seed=seed
    )
    try:
        info1 = {}
        "".join(engine1.run("The science of", 8, 0.0, None, [], info1))
    finally:
        adapter1.remove()
        stream1.close(drain_timeout=TIMEOUT)

    events1 = read_recording(rec1)
    comp1 = [e for e in events1 if e.get("type") == "token_step" and e.get("kind") == "completion"]
    candidates = [s for s in comp1 if s["token_index"] >= 1 and s.get("token_text")]
    if not candidates:
        pytest.skip("No non-empty token_text in completion tokens with index >= 1")
    stop_target = candidates[0]
    stop_str = stop_target["token_text"]

    model2, stream2, graph2, engine2, adapter2, rec2 = build_pipeline(
        wiring, tmp_path=tmp_path / "run2", ctx=128, seed=seed
    )
    try:
        info2 = {}
        "".join(engine2.run("The science of", 8, 0.0, None, [stop_str], info2))
    finally:
        adapter2.remove()
        stream2.close(drain_timeout=TIMEOUT)

    events2 = read_recording(rec2)
    completed2 = next(e for e in events2 if e.get("type") == "request_lifecycle" and e.get("phase") == "completed")
    assert completed2["finish_reason"] == "stop"
    assert info2["finish_reason"] == "stop"

    comp2 = [e for e in events2 if e.get("type") == "token_step" and e.get("kind") == "completion"]
    assert len(comp2) == info2["completion_tokens"]
    assert completed2["completion_tokens"] == len(comp2)
    assert len(comp2) >= 1

    last_step = comp2[-1]
    assert last_step["step_status"] == "unprocessed"
    assert last_step["t"] == -1

    for step in comp2[:-1]:
        assert step["step_status"] in {"stepped_fired", "stepped_silent"}
        assert step["t"] >= 0


def test_lifecycle_phases_correlate_and_seq_monotonic(wiring, tmp_path):
    # Sequential part
    model, stream, graph, engine, adapter, rec_path = build_pipeline(
        wiring, tmp_path=tmp_path / "seq", ctx=128
    )
    try:
        info1, info2 = {}, {}
        "".join(engine.run("First sequential", 3, 0.0, None, [], info1))
        "".join(engine.run("Second sequential", 3, 0.0, None, [], info2))
    finally:
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    events = read_recording(rec_path)
    ext_types = {"request_lifecycle", "token_step", "stream_status"}
    ext_events = [e for e in events if e.get("type") in ext_types]
    seqs = [e["seq"] for e in ext_events]
    assert all(b > a for a, b in zip(seqs, seqs[1:]))

    req_ids = list(dict.fromkeys(e["request_id"] for e in ext_events if "request_id" in e))
    assert len(req_ids) == 2
    req_a, req_b = req_ids[0], req_ids[1]
    assert re.match(r"^req-[0-9a-f]{12}$", req_a)
    assert re.match(r"^req-[0-9a-f]{12}$", req_b)
    assert req_a != req_b

    run_ids = {e["run_id"] for e in ext_events if "run_id" in e}
    assert len(run_ids) == 1
    assert list(run_ids)[0] == adapter.run_id

    phases_a = [e["phase"] for e in ext_events if e.get("type") == "request_lifecycle" and e.get("request_id") == req_a]
    assert phases_a == ["queued", "prefill", "decode", "completed"]
    phases_b = [e["phase"] for e in ext_events if e.get("type") == "request_lifecycle" and e.get("request_id") == req_b]
    assert phases_b == ["queued", "prefill", "decode", "completed"]

    token_steps = [e for e in ext_events if e.get("type") == "token_step"]
    assert all(e["request_id"] in {req_a, req_b} for e in token_steps)

    # Queued-concurrency part (recorded, so the stream listens and token_steps are produced)
    model_c, stream_c, graph_c, engine_c, adapter_c, rec_c = build_pipeline(
        wiring, tmp_path=tmp_path / "conc", ctx=128
    )
    seen = []
    orig_send_event = stream_c.send_event
    stream_c.send_event = lambda e: (seen.append(dict(e)), orig_send_event(e))[1]

    try:
        gen_a = engine_c.run("Async prompt A", 4, 0.0, None, [], {})
        first_piece_a = next(gen_a)
        req_a_id = adapter_c.request_id
        assert req_a_id is not None

        b_done = threading.Event()
        b_info = {}
        b_exc = []

        def run_b():
            try:
                "".join(engine_c.run("Async prompt B", 4, 0.0, None, [], b_info))
            except Exception as exc:
                b_exc.append(exc)
            finally:
                b_done.set()

        tb = threading.Thread(target=run_b, daemon=True)
        tb.start()

        def b_queued_seen():
            return any(
                e.get("type") == "request_lifecycle"
                and e.get("phase") == "queued"
                and e.get("request_id") != req_a_id
                for e in seen
            )

        wait_until(b_queued_seen, "request B queued event")
        assert adapter_c.request_id == req_a_id

        # Finish request A
        for _ in gen_a:
            pass

        assert b_done.wait(TIMEOUT), "timed out waiting for request B"
        if b_exc:
            raise b_exc[0]
        tb.join(TIMEOUT)

        b_lifecycle = [e for e in seen if e.get("type") == "request_lifecycle" and e.get("request_id") != req_a_id]
        assert len(b_lifecycle) > 0
        req_b_id = b_lifecycle[0]["request_id"]
        b_phases = [e["phase"] for e in b_lifecycle]
        assert b_phases == ["queued", "prefill", "decode", "completed"]

        a_stepped_ts = [e["t"] for e in seen if e.get("type") == "token_step" and e.get("request_id") == req_a_id and e.get("t", -1) >= 0]
        b_stepped_ts = [e["t"] for e in seen if e.get("type") == "token_step" and e.get("request_id") == req_b_id and e.get("t", -1) >= 0]
        assert len(a_stepped_ts) > 0 and len(b_stepped_ts) > 0
        assert min(b_stepped_ts) > max(a_stepped_ts)
        seen_seqs = [e["seq"] for e in seen]
        assert all(b > a for a, b in zip(seen_seqs, seen_seqs[1:]))

        assert adapter_c.request_id is None
        assert adapter_c.current_t == -1
    finally:
        adapter_c.remove()
        stream_c.close(drain_timeout=TIMEOUT)

    recorded = [e for e in read_recording(rec_c) if e.get("type") in ext_types]
    assert [e["seq"] for e in recorded] == seen_seqs


def test_generator_close_emits_cancelled_with_completion_count(wiring, tmp_path):
    model, stream, graph, engine, adapter, rec_path = build_pipeline(
        wiring, tmp_path=tmp_path, ctx=128
    )
    try:
        info = {}
        g = engine.run("Testing generator cancellation", 8, 0.0, None, [], info)
        next(g)
        g.close()
    finally:
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    events = read_recording(rec_path)
    lifecycles = [e for e in events if e.get("type") == "request_lifecycle"]
    assert len(lifecycles) > 0
    phases = [e["phase"] for e in lifecycles]
    assert "completed" not in phases
    assert phases[-1] == "cancelled"

    last_lc = lifecycles[-1]
    assert last_lc["finish_reason"] == "cancelled"

    comp_steps = [e for e in events if e.get("type") == "token_step" and e.get("kind") == "completion"]
    assert len(comp_steps) >= 1
    assert last_lc["completion_tokens"] == len(comp_steps) == info["completion_tokens"]
    assert comp_steps[-1]["step_status"] == "unprocessed"
    assert comp_steps[-1]["t"] == -1

    acquired = engine.lock.acquire(blocking=False)
    assert acquired, "engine.lock was not released after g.close()"
    engine.lock.release()

    assert adapter.request_id is None


def test_reconnect_keeps_server_t_and_sends_mapping_then_resync(wiring):
    model, stream, graph, engine, adapter, _ = build_pipeline(wiring, record=False, ctx=128)
    c1 = MessageCollector(stream.url)
    c2 = MessageCollector(stream.url)
    try:
        c1.start()
        assert c1.connected.wait(TIMEOUT)
        wait_until(lambda: len(c1.msgs) >= 2, "client 1 mapping + resync")
        assert c1.msgs[0] == graph.mapping
        assert c1.msgs[1]["type"] == "stream_status"
        assert c1.msgs[1]["event"] == "resync"
        assert c1.msgs[1]["dropped_steps"] == 0

        info1 = {}
        "".join(engine.run("First client message", 2, 0.0, None, [], info1))
        wait_until(
            lambda: any(m.get("type") == "request_lifecycle" and m.get("phase") == "completed" for m in c1.msgs),
            "client 1 completed lifecycle",
        )
        c1.close()

        c2.start()
        assert c2.connected.wait(TIMEOUT)
        wait_until(lambda: len(c2.msgs) >= 2, "client 2 mapping + resync")
        assert c2.msgs[0] == graph.mapping
        assert c2.msgs[1]["type"] == "stream_status"
        assert c2.msgs[1]["event"] == "resync"
        assert c2.msgs[1]["dropped_steps"] == 0

        c1_ext = [m for m in c1.msgs if m.get("type") in {"request_lifecycle", "token_step", "stream_status"}]
        assert len(c1_ext) > 0
        max_c1_seq = max(m["seq"] for m in c1_ext)
        assert c2.msgs[1]["seq"] > max_c1_seq

        info2 = {}
        "".join(engine.run("Second client message", 2, 0.0, None, [], info2))
        wait_until(
            lambda: any(m.get("type") == "request_lifecycle" and m.get("phase") == "completed" for m in c2.msgs),
            "client 2 completed lifecycle",
        )

        c1_ts = [m["t"] for m in c1.msgs if "t" in m and m.get("type") in {"fire", "token_step"} and m["t"] >= 0]
        prefill2 = next(m for m in c2.msgs if m.get("type") == "request_lifecycle" and m.get("phase") == "prefill")
        assert prefill2["t_start"] > max(c1_ts)

        c1_fires = [m["t"] for m in c1.msgs if m.get("type") == "fire"]
        c2_fires = [m["t"] for m in c2.msgs if m.get("type") == "fire"]
        assert len(c1_fires) > 0 and len(c2_fires) > 0
        assert min(c2_fires) > max(c1_fires)

        c1_seqs = [m["seq"] for m in c1_ext]
        c2_ext = [m for m in c2.msgs if m.get("type") in {"request_lifecycle", "token_step", "stream_status"}]
        c2_seqs = [m["seq"] for m in c2_ext]
        assert all(b > a for a, b in zip(c1_seqs, c1_seqs[1:]))
        assert all(b > a for a, b in zip(c2_seqs, c2_seqs[1:]))
    finally:
        c1.close()
        c2.close()
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)


def test_replacement_mapping_increments_epoch_restarts_t_and_emits_epoch_reset(wiring, tmp_path):
    model, stream, graph, engine, adapter, rec_path = build_pipeline(
        wiring, tmp_path=tmp_path, ctx=128
    )
    try:
        info1 = {}
        "".join(engine.run("Epoch 0 run", 2, 0.0, None, [], info1))
        assert stream.epoch == 0
        assert adapter.epoch == 0

        stream.set_mapping(graph.refresh())
        assert stream.epoch == 1
        assert adapter.epoch == 1

        info2 = {}
        "".join(engine.run("Epoch 1 run", 2, 0.0, None, [], info2))
    finally:
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    events = read_recording(rec_path)
    mappings = [(i, e) for i, e in enumerate(events) if e.get("type") == "mapping"]
    assert len(mappings) == 2
    idx_new_map = mappings[1][0]
    reset_event = events[idx_new_map + 1]
    assert reset_event["type"] == "stream_status"
    assert reset_event["event"] == "epoch_reset"
    assert reset_event["epoch"] == 1
    assert reset_event["dropped_steps"] == 0

    events_after = events[idx_new_map + 1:]
    req2_lifecycles = [e for e in events_after if e.get("type") == "request_lifecycle"]
    assert len(req2_lifecycles) > 0
    prefill2 = next(e for e in req2_lifecycles if e.get("phase") == "prefill")
    assert prefill2["epoch"] == 1
    assert prefill2["t_start"] == 0

    req2_ext = [e for e in events_after if e.get("type") in {"request_lifecycle", "token_step"}]
    assert all(e["epoch"] == 1 for e in req2_ext)
    assert stream.epoch == adapter.epoch == 1


def test_slow_client_gap_marker_reports_dropped_count(wiring, monkeypatch):
    # Client part
    torch.manual_seed(0)
    model = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    stream, graph = stream_model(model, wiring, 0, port=0, queue_size=3)
    adapter = TelemetryAdapter(
        model, stream, block=0, impl="vibe", model_id="flybrain-test",
        ckpt_digest="sha256:" + "0" * 12
    )

    gate = StalledSend()
    orig_send = ServerConnection.send

    async def stalled_send(conn, message, *args, **kwargs):
        if gate.armed and gate.target is not None and conn.remote_address == gate.target:
            gate.armed = False
            gate.reached.set()
            if not await asyncio.to_thread(gate.release.wait, TIMEOUT):
                raise TimeoutError("the test did not release the stalled send")
            gate.passed.set()
        return await orig_send(conn, message, *args, **kwargs)

    monkeypatch.setattr(ServerConnection, "send", stalled_send)

    try:
        with connect(stream.url, max_size=None) as slow:
            m1 = json.loads(slow.recv(timeout=TIMEOUT))
            assert m1["type"] == "mapping"
            m2 = json.loads(slow.recv(timeout=TIMEOUT))
            assert m2["type"] == "stream_status" and m2["event"] == "resync"

            gate.target = slow.local_address
            pairs = graph.fire_pairs([0])

            stream.fire(pairs)
            assert gate.reached.wait(TIMEOUT), "the stalled send never started"
            wait_until(lambda: not stream._pending, "pending fire to drain to in-flight")

            while stream.dropped < 4:
                stream.fire(pairs)
                wait_until(lambda: not stream._pending, "pending fire to drain to client queue")
            K = stream.dropped
            assert K == 4 and not gate.passed.is_set()

            gate.release.set()
            assert gate.passed.wait(TIMEOUT), "stalled send did not finish passing"

            queued_msgs = [json.loads(slow.recv(timeout=TIMEOUT)) for _ in range(1 + 3)]
            assert [m["t"] for m in queued_msgs if m["type"] == "fire"] == [0, 1, 2, 3]

            stream.fire(pairs)
            wait_until(lambda: not stream._pending, "recovery fire to drain")

            recovery_fire = json.loads(slow.recv(timeout=TIMEOUT))
            assert recovery_fire["type"] == "fire" and recovery_fire["t"] == 4 + K   # t 4..4+K-1 were dropped
            gap_marker = json.loads(slow.recv(timeout=TIMEOUT))
            assert gap_marker["type"] == "stream_status"
            assert gap_marker["event"] == "gap"
            assert gap_marker["dropped_steps"] == K == stream.dropped
            assert gap_marker["seq"] > m2["seq"] and gap_marker["run_id"] == adapter.run_id
    finally:
        gate.release.set()
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    # Recording part
    sink = StalledRecording()
    monkeypatch.setattr("harness.viz_stream.open", sink.open, raising=False)

    torch.manual_seed(0)
    rec_model = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    rec_stream = VizStream(port=0, record="rec_stalled.ndjson", record_queue_size=2)
    rec_stream.set_mapping(graph.mapping)
    rec_stream.start()
    rec_adapter = TelemetryAdapter(
        rec_model, rec_stream, block=0, impl="vibe", model_id="flybrain-test",
        ckpt_digest="sha256:" + "0" * 12
    )

    try:
        assert sink.started.wait(TIMEOUT), "recording writer never started"
        for _ in range(6):
            rec_stream.fire(pairs)
        dropped_before = rec_stream.recording_dropped
        assert dropped_before == 6 - 2            # two fires queued behind the held mapping write

        sink.release.set()
        wait_until(lambda: rec_stream._recorder._queue.empty(), "recording queue to drain")
        recovery_t = rec_stream.t
        rec_stream.fire(pairs)                    # first message the recorder accepts again
    finally:
        sink.release.set()
        rec_adapter.remove()
        rec_stream.close(drain_timeout=TIMEOUT)

    rec_messages = [json.loads(line) for line in sink.lines if line.strip()]
    gaps = [m for m in rec_messages if m.get("type") == "stream_status" and m.get("event") == "gap"]
    assert len(gaps) == 1
    gap = gaps[0]
    assert gap["dropped_steps"] == dropped_before == rec_stream.recording_dropped
    gap_idx = rec_messages.index(gap)
    assert rec_messages[gap_idx - 1] == {"type": "fire", "t": recovery_t, "pairs": pairs}
    assert [m["t"] for m in rec_messages if m["type"] == "fire"] == [0, 1, recovery_t]


def test_payloads_have_no_floats_booleans_or_nulls(wiring, tmp_path):
    model, stream, graph, engine, adapter, rec_path = build_pipeline(
        wiring, tmp_path=tmp_path, ctx=128
    )
    try:
        info = {}
        "".join(engine.run("Telemetry payload verification", 3, 0.0, None, [], info))
        stream.set_mapping(graph.refresh())
    finally:
        adapter.remove()
        stream.close(drain_timeout=TIMEOUT)

    events = read_recording(rec_path)
    assert len(events) > 0

    def assert_valid_scalars(val, path=""):
        if isinstance(val, dict):
            for k, v in val.items():
                if k.endswith("_ns"):
                    assert isinstance(v, str), f"Field {path}.{k} is not a str: {type(v)}"
                    assert re.match(r"^[0-9]+$", v), f"Field {path}.{k} is not a decimal string: {v}"
                assert_valid_scalars(v, f"{path}.{k}")
        elif isinstance(val, list):
            for i, item in enumerate(val):
                assert_valid_scalars(item, f"{path}[{i}]")
        else:
            assert type(val) is not bool, f"Found boolean at {path}: {val}"
            assert val is not None, f"Found None at {path}"
            assert not isinstance(val, float), f"Found float at {path}: {val}"
            assert type(val) in {int, str}, f"Unexpected type at {path}: {type(val)}"

    for idx, ev in enumerate(events):
        assert_valid_scalars(ev, f"events[{idx}]")

    schema_dir = Path(__file__).parents[1] / "harness" / "protocol" / "v1"
    schemas = {}
    for name in ("request_lifecycle", "token_step", "stream_status"):
        schema_file = schema_dir / f"{name}.schema.json"
        schemas[name] = Draft202012Validator(json.loads(schema_file.read_text(encoding="utf-8")))
        schemas[name].check_schema(schemas[name].schema)

    ext_lines = [ev for ev in events if ev.get("type") in schemas]
    assert len(ext_lines) > 0
    for ev in ext_lines:
        schemas[ev["type"]].validate(ev)


def test_recording_preserves_extension_lines_and_legacy_receiver_ignores_them(wiring, tmp_path):
    prompt = "A simple prompt for comparison"
    max_tokens = 4
    seed = 42

    model_a, stream_a, graph_a, engine_a, adapter_a, rec_a = build_pipeline(
        wiring, tmp_path=tmp_path / "with_adapter", ctx=128, seed=seed
    )
    try:
        "".join(engine_a.run(prompt, max_tokens, 0.0, None, [], {}))
    finally:
        adapter_a.remove()
        stream_a.close(drain_timeout=TIMEOUT)

    torch.manual_seed(seed)
    model_b = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    rec_b = tmp_path / "without_adapter" / "recording.ndjson"
    rec_b.parent.mkdir(parents=True, exist_ok=True)
    stream_b, graph_b = stream_model(model_b, wiring, 0, port=0, record=str(rec_b))
    engine_b = Engine(model_b, ctx=128, max_tokens_cap=16, seed=seed)
    try:
        "".join(engine_b.run(prompt, max_tokens, 0.0, None, [], {}))
    finally:
        stream_b.close(drain_timeout=TIMEOUT)

    raw_lines_a = [l.strip() for l in Path(rec_a).read_text(encoding="utf-8").splitlines() if l.strip()]
    raw_lines_b = [l.strip() for l in Path(rec_b).read_text(encoding="utf-8").splitlines() if l.strip()]

    filtered_a = [l for l in raw_lines_a if json.loads(l).get("type") in {"mapping", "fire"}]
    assert filtered_a == raw_lines_b

    receiver_plain = ContractReceiver()
    actions_plain = [receiver_plain.process(l) for l in raw_lines_b]

    receiver_adapter = ContractReceiver()
    actions_adapter = []
    for l in raw_lines_a:
        act = receiver_adapter.process(l)
        actions_adapter.append(act)
        if json.loads(l).get("type") not in {"mapping", "fire"}:
            assert act == {"action": "ignore_message"}

    filtered_actions = [act for act, l in zip(actions_adapter, raw_lines_a)
                        if json.loads(l).get("type") in {"mapping", "fire"}]
    assert filtered_actions == actions_plain


def test_logits_identical_with_and_without_telemetry(wiring, tmp_path):
    prompt = "Testing model hidden state equivalence"
    max_tokens = 5
    seed = 77

    # Model A: plain Engine with stream_model attach only
    torch.manual_seed(seed)
    model_a = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    hidden_a = []
    hook_a = model_a.norm_f.register_forward_hook(lambda m, inp, out: hidden_a.append(out.detach().clone()))
    stream_a, graph_a = stream_model(model_a, wiring, 0, port=0)
    engine_a = Engine(model_a, ctx=128, max_tokens_cap=16, seed=seed)
    info_a = {}
    try:
        text_a = "".join(engine_a.run(prompt, max_tokens, 0.0, None, [], info_a))
    finally:
        hook_a.remove()
        stream_a.close(drain_timeout=TIMEOUT)

    # Model B: wrapped Engine with adapter + recording
    torch.manual_seed(seed)
    model_b = FlyLM(Config.from_wiring(wiring, d_model=64, n_layer=2), wiring).eval()
    hidden_b = []
    hook_b = model_b.norm_f.register_forward_hook(lambda m, inp, out: hidden_b.append(out.detach().clone()))
    rec_b = tmp_path / "rec_b.ndjson"
    stream_b, graph_b = stream_model(model_b, wiring, 0, port=0, record=str(rec_b))
    engine_b = Engine(model_b, ctx=128, max_tokens_cap=16, seed=seed)
    adapter_b = TelemetryAdapter(
        model_b, stream_b, block=0, impl="vibe", model_id="flybrain-test",
        ckpt_digest="sha256:" + "0" * 12
    )
    adapter_b.wrap_engine(engine_b)
    info_b = {}
    try:
        text_b = "".join(engine_b.run(prompt, max_tokens, 0.0, None, [], info_b))
    finally:
        hook_b.remove()
        adapter_b.remove()
        stream_b.close(drain_timeout=TIMEOUT)

    assert text_a == text_b
    assert info_a["prompt_tokens"] == info_b["prompt_tokens"]
    assert info_a["completion_tokens"] == info_b["completion_tokens"]
    assert len(hidden_a) == len(hidden_b)
    assert len(hidden_a) > 0

    for ha, hb in zip(hidden_a, hidden_b):
        assert torch.equal(ha, hb)
        logits_a = ha @ model_a.emb.weight.t()
        logits_b = hb @ model_b.emb.weight.t()
        assert torch.equal(logits_a, logits_b)
        assert torch.equal(logits_a.argmax(dim=-1), logits_b.argmax(dim=-1))
