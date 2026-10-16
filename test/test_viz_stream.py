"""Checks the stream against "Fly Brain Visualization Stream Spec" v1 using a mock harness."""
import json
import threading
import time

import pytest
import torch
from websockets.sync.client import connect

from harness.viz_stream import FlyGraph, VizStream, attach, stream_model
from model.model import Config, FlyLM, Wiring

TINY = Config(d_model=64, n_layer=2)


def check_mapping(m):
    assert m["type"] == "mapping" and m["version"] == 1
    gids = [g["id"] for g in m["groups"]]
    nids = [n["id"] for n in m["nodes"]]
    assert len(set(gids)) == len(gids) and nids == list(range(len(nids)))    # unique, contiguous from 0
    assert all(n["group"] in gids for n in m["nodes"])
    edges = [tuple(e) for e in m["edges"]]
    assert len(set(edges)) == len(edges)                                      # edges MUST NOT repeat
    assert all(0 <= s < len(nids) and 0 <= d < len(nids) for s, d in edges)
    return set(edges)


def check_fires(fires, edges):
    ts = [f["t"] for f in fires]
    assert all(isinstance(t, int) and t >= 0 for t in ts)
    assert all(b > a for a, b in zip(ts, ts[1:]))                            # strictly increasing
    for f in fires:
        pairs = [tuple(p) for p in f["pairs"]]
        assert len(set(pairs)) == len(pairs)                                  # no repeat in a message
        assert set(pairs) <= edges                                            # every pair is a declared edge
        assert all(isinstance(x, int) for p in pairs for x in p)              # integers only


def no_floats(obj):
    if isinstance(obj, float):
        return False
    if isinstance(obj, dict):
        return all(no_floats(v) for v in obj.values())
    if isinstance(obj, list):
        return all(no_floats(v) for v in obj)
    return True


class Harness(threading.Thread):
    def __init__(self, url, delay=0.0):
        super().__init__(daemon=True)
        self.url, self.delay, self.msgs = url, delay, []
        self.connected = threading.Event()

    def run(self):
        with connect(self.url, max_size=None) as ws:
            self.connected.set()
            time.sleep(self.delay)
            try:
                for raw in ws:
                    self.msgs.append(json.loads(raw))
            except Exception:
                pass


@pytest.fixture
def setup():
    torch.manual_seed(0)
    w = Wiring.random()
    model = FlyLM(TINY, w).eval()
    graph = FlyGraph(w, TINY.heads_per_lobe)
    return model, w, graph


def test_mapping_shape(setup):
    _, w, graph = setup
    m = graph.mapping
    edges = check_mapping(m)
    K, G = w.mask.shape
    assert len(m["nodes"]) == G + K + 15
    assert len(edges) == int(w.mask.sum()) + K * 5
    assert no_floats(m)


def test_stream_to_harness(setup, tmp_path):
    model, _, graph = setup
    rec = tmp_path / "rec.ndjson"
    s = VizStream(port=0, record=str(rec)).start()
    s.set_mapping(graph.mapping)
    attach(model, s, graph)
    h = Harness(s.url)
    h.start()
    assert h.connected.wait(5) and s.wait_for_harness(5)
    model.generate([1, 2, 3, 4], 6, temperature=0)                           # 4 prompt + 5 stepped = 9 steps
    s.close()
    h.join(5)

    assert h.msgs[0]["type"] == "mapping"
    edges = check_mapping(h.msgs[0])
    fires = h.msgs[1:]
    check_fires(fires, edges)
    assert [f["t"] for f in fires] == list(range(9)) and s.dropped == 0
    for f in fires:                                                           # 94 active KCs x 5 compartments
        assert sum(1 for src, dst in f["pairs"] if dst >= graph.mapping["nodes"][-15]["id"]) == 94 * 5
    assert all(no_floats(m) for m in h.msgs)
    assert [json.loads(l) for l in rec.read_text().splitlines()] == h.msgs   # recording == live stream


def test_session_streams_every_message(setup):
    model, w, _ = setup
    s, graph = stream_model(model, w, port=0)
    h = Harness(s.url)
    h.start()
    assert h.connected.wait(5) and s.wait_for_harness(5)
    model.generate([1, 2, 3], 3, temperature=0)                              # message 1: 3 prompt + 2 stepped
    model.generate([7, 8], 2, temperature=0)                                 # message 2: 2 prompt + 1 stepped
    s.close()
    h.join(5)
    assert [m["type"] for m in h.msgs] == ["mapping"] + ["fire"] * 8        # mapping once, and first
    assert h.msgs[0] == graph.mapping
    assert [m["t"] for m in h.msgs[1:]] == list(range(8))                   # t keeps counting across messages
    check_fires(h.msgs[1:], check_mapping(h.msgs[0]))


def test_mid_run_join_gets_mapping_first(setup):
    model, _, graph = setup
    s = VizStream(port=0).start()
    s.set_mapping(graph.mapping)
    attach(model, s, graph)
    model.generate([1, 2], 3, temperature=0)                                 # nobody listening yet
    h = Harness(s.url)
    h.start()
    s.wait_for_harness(5)
    model.generate([5], 2, temperature=0)
    s.close()
    h.join(5)
    assert h.msgs[0]["type"] == "mapping"
    assert all(m["type"] == "fire" for m in h.msgs[1:]) and h.msgs[1]["t"] > 0   # live steps only


def test_zero_harnesses_runs_normally(setup):
    model, _, graph = setup
    s = VizStream(port=0).start()
    s.set_mapping(graph.mapping)
    attach(model, s, graph)
    assert len(model.generate([1, 2, 3], 4, temperature=0)) == 4
    s.close()


def test_slow_harness_drops_never_blocks(setup):
    _, _, graph = setup
    s = VizStream(port=0, queue_size=2).start()
    s.set_mapping(graph.mapping)
    h = Harness(s.url, delay=3.0)                                             # connects, then doesn't read for 3 s
    h.start()
    s.wait_for_harness(5)
    pairs = graph.fire_pairs(list(range(94)))
    worst = 0.0
    for _ in range(1500):
        t0 = time.perf_counter()
        s.fire(pairs)
        worst = max(worst, time.perf_counter() - t0)
    assert s.dropped > 0
    assert worst < 0.05, f"fire() blocked for {worst:.3f}s"
    s.close(drain_timeout=0.5)
