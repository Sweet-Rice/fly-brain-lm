"""Checks the stream against "Fly Brain Visualization Stream Spec" v1 over real loopback WebSockets."""
import asyncio
import itertools
from contextlib import ExitStack
import json
import threading
import time

import pytest
import torch
from websockets.asyncio.server import ServerConnection
from websockets.sync.client import connect

from harness.viz_stream import FlyGraph, VizStream, attach, stream_model
from model.model import Config, FlyLM, Wiring

TINY = Config(d_model=64, n_layer=2)
TIMEOUT = 5.0   # bound on every cross-thread wait: a stuck stream fails the test instead of hanging


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


def wait_until(cond, what):
    end = time.monotonic() + TIMEOUT
    while not cond():
        assert time.monotonic() < end, f"timed out after {TIMEOUT}s waiting for {what}"
        time.sleep(0.005)


def read_msgs(ws, n):
    return [json.loads(ws.recv(timeout=TIMEOUT)) for _ in range(n)]


class Harness(threading.Thread):
    """A harness on its own thread: collects every message until the server closes the socket."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url, self.msgs = url, []
        self.connected = threading.Event()

    def run(self):
        with connect(self.url, max_size=None) as ws:
            self.connected.set()
            for raw in ws:
                self.msgs.append(json.loads(raw))


class StalledSend:
    """One fire frame held inside the server's send to one client (the real I/O boundary)."""

    def __init__(self):
        self.target = None                    # the stalled client's address as the server sees it
        self.reached = threading.Event()      # set once the held send has started
        self.release = threading.Event()      # the test sets this to let the send continue
        self.passed = threading.Event()       # set once the held send has been released
        self.armed = True


class StalledRecording:
    """A file-like sink whose first write waits until the test releases it."""

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


@pytest.fixture
def stalled(monkeypatch):
    gate = StalledSend()
    original = ServerConnection.send

    async def send(conn, message, *args, **kwargs):
        if (gate.armed and gate.target is not None and conn.remote_address == gate.target
                and isinstance(message, str) and json.loads(message).get("type") == "fire"):
            gate.armed = False
            gate.reached.set()
            if not await asyncio.to_thread(gate.release.wait, TIMEOUT):
                raise TimeoutError("the test did not release the stalled send")
            gate.passed.set()
        return await original(conn, message, *args, **kwargs)

    monkeypatch.setattr(ServerConnection, "send", send)
    yield gate
    gate.release.set()


@pytest.fixture
def setup():
    torch.manual_seed(0)
    w = Wiring.random()
    model = FlyLM(TINY, w).eval()
    graph = FlyGraph(w, TINY.heads_per_lobe)
    return model, w, graph


def tiny_wiring():
    """3 glomeruli, 4 KCs. KC classes are 0 (gamma), 1 (alphabeta), 2 (alphaprime), 1 (alphabeta)."""
    fan_in = [[0, 2], [1], [0, 1, 2], [2]]
    mask = torch.zeros(4, 3, dtype=torch.bool)
    for k, gloms in enumerate(fan_in):
        mask[k, gloms] = True
    return Wiring(mask, mask.float(), torch.tensor([0, 1, 2, 1]))


# With heads_per_lobe=2 the 3 glomeruli are ids 0-2, the KCs ids 3-6, and the MBON compartments
# ids 7-12 (lobe 0: 7,8; lobe 1: 9,10; lobe 2: 11,12). Each KC's pairs: glomerulus -> KC, then KC -> its lobe.
TINY_KC_PAIRS = [
    {(0, 3), (2, 3), (3, 7), (3, 8)},
    {(1, 4), (4, 9), (4, 10)},
    {(0, 5), (1, 5), (2, 5), (5, 11), (5, 12)},
    {(2, 6), (6, 9), (6, 10)},
]


@pytest.mark.parametrize("host", ["0.0.0.0", "localhost", "::1"])
def test_stream_rejects_non_ipv4_loopback_bind(host):
    with pytest.raises(ValueError, match="loopback-only"):
        VizStream(host=host)


def test_mapping_shape(setup):
    _, w, graph = setup
    m = graph.mapping
    edges = check_mapping(m)
    K, G = w.mask.shape
    assert len(m["nodes"]) == G + K + 15
    assert len(edges) == int(w.mask.sum()) + K * 5
    assert no_floats(m)


def test_tiny_graph_exact_topology():
    graph = FlyGraph(tiny_wiring(), heads_per_lobe=2)
    edges = check_mapping(graph.mapping)
    groups = {n["id"]: n["group"] for n in graph.mapping["nodes"]}
    assert groups == {0: 0, 1: 0, 2: 0, 3: 1, 4: 2, 5: 3, 6: 2, **{i: 4 for i in range(7, 13)}}
    assert edges == set().union(*TINY_KC_PAIRS)


def test_tiny_graph_fire_pairs_selects_exactly_active_kcs():
    graph = FlyGraph(tiny_wiring(), heads_per_lobe=2)
    assert graph.fire_pairs([]) == []                                        # empty active set: no edges
    for n in range(1, 5):
        for active in itertools.combinations(range(4), n):
            expected = set().union(*(TINY_KC_PAIRS[k] for k in active))
            got = graph.fire_pairs(list(active))
            assert {tuple(p) for p in got} == expected
            assert len(got) == len(expected)                               # no duplicates, nothing skipped


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


def test_empty_active_set_advances_t_without_a_message(setup):
    _, _, graph = setup
    s = VizStream(port=0).start()
    s.set_mapping(graph.mapping)
    with connect(s.url, max_size=None) as ws:
        wait_until(lambda: s.harnesses_seen == 1, "the harness to register")
        s.fire(graph.fire_pairs([]))                                         # step 0: nothing active, no message
        s.fire(graph.fire_pairs([2]))                                        # step 1
        got = read_msgs(ws, 2)
    s.close()
    assert got[0] == graph.mapping
    assert got[1]["type"] == "fire" and got[1]["t"] == 1


def test_recording_queue_never_waits_and_keeps_replacement_mapping(setup, monkeypatch):
    _, w, graph = setup
    replacement = FlyGraph(w, heads_per_lobe=2)
    sink = StalledRecording()
    monkeypatch.setattr("harness.viz_stream.open", sink.open, raising=False)
    s = VizStream(record="unused.ndjson", record_queue_size=2)
    failure, published = [], threading.Event()

    def publish():
        try:
            pairs = graph.fire_pairs([1])
            for _ in range(3):
                s.fire(pairs)
            s.set_mapping(replacement.mapping)
            s.fire(replacement.fire_pairs([0]))
        except Exception as exc:
            failure.append(exc)
        finally:
            published.set()

    try:
        s.set_mapping(graph.mapping)
        assert sink.started.wait(TIMEOUT), "the recording writer never reached the blocked file write"
        publisher = threading.Thread(target=publish, daemon=True)
        publisher.start()
        assert published.wait(1.0), "model-side publication waited for recording file I/O"
        assert not failure and not sink.release.is_set()
        assert s.recording_dropped == 3                 # t=2 overflowed; queued t=0,1 yielded to replacement mapping
    finally:
        sink.release.set()
        if "publisher" in locals():
            publisher.join(TIMEOUT)
        s.close()

    messages = [json.loads(line) for line in sink.lines]
    assert sink.closed and s.recording_error is None
    assert messages == [graph.mapping, replacement.mapping,
                        {"type": "fire", "t": 0, "pairs": replacement.fire_pairs([0])}]


def test_recording_failure_is_reported_without_stopping_model(setup, monkeypatch):
    model, _, graph = setup

    def fail_open(*args, **kwargs):
        raise OSError("disk offline")

    monkeypatch.setattr("harness.viz_stream.open", fail_open, raising=False)
    with pytest.warns(RuntimeWarning, match="visualization recording stopped: disk offline"):
        s = VizStream(record="unwritable.ndjson")
        wait_until(lambda: s.recording_error is not None, "the recording error to be reported")

    s.set_mapping(graph.mapping)
    hook = attach(model, s, graph)
    try:
        assert len(model.generate([1, 2, 3], 4, temperature=0)) == 4
    finally:
        hook.remove()
        s.close()
    assert isinstance(s.recording_error, OSError) and not s.listening


def test_stalled_send_fills_queue_drops_overflow_and_recovers(setup, stalled, tmp_path):
    _, _, graph = setup
    Q, K, M = 3, 4, 2                       # queue size, overflow steps, recovery steps
    rec = tmp_path / "rec.ndjson"
    edges = check_mapping(graph.mapping)
    pairs = graph.fire_pairs([1])
    s = VizStream(port=0, queue_size=Q, record=str(rec)).start()
    s.set_mapping(graph.mapping)
    clients = ExitStack()
    try:
        healthy = clients.enter_context(connect(s.url, max_size=None))
        slow = clients.enter_context(connect(s.url, max_size=None))
        wait_until(lambda: s.harnesses_seen == 2, "both harnesses to register")
        slow_msgs = read_msgs(slow, 1)                 # the 239 KB mapping is read first, so nothing else is in flight
        stalled.target = slow.local_address

        s.fire(pairs)                                  # t=0: the stalled client's send takes it and blocks
        assert stalled.reached.wait(TIMEOUT), "the stalled send never started"
        healthy_msgs = read_msgs(healthy, 2)            # mapping and t=0: its handler has finished sending
        for _ in range(Q + K):                         # t=1..Q+K: Q fill the stalled queue, K overflow it
            s.fire(pairs)                              # must return before the stalled send is released
            healthy_msgs += read_msgs(healthy, 1)      # acknowledge each broadcast; never flood the healthy queue
        assert s.dropped == K and not stalled.passed.is_set()
        stalled.release.set()
        assert stalled.passed.wait(TIMEOUT)
        slow_msgs += read_msgs(slow, 1 + Q)            # t=0, then the Q queued fires
        for _ in range(M):                             # queue is empty again, so recovery fires are not dropped
            s.fire(pairs)
        slow_msgs += read_msgs(slow, M)
        healthy_msgs += read_msgs(healthy, M)
    finally:
        stalled.release.set()
        try:
            clients.close()
        finally:
            s.close()

    assert slow_msgs[0] == graph.mapping
    slow_fires = slow_msgs[1:]
    assert [f["t"] for f in slow_fires] == list(range(Q + 1)) + list(range(Q + K + 1, Q + K + M + 1))
    check_fires(slow_fires, edges)
    assert all({tuple(p) for p in f["pairs"]} == {tuple(p) for p in pairs} for f in slow_fires)
    assert healthy_msgs[0] == graph.mapping
    assert [f["t"] for f in healthy_msgs[1:]] == list(range(Q + K + M + 1))  # the healthy client lost nothing
    assert s.dropped == K
    assert [json.loads(l) for l in rec.read_text().splitlines()] == healthy_msgs   # recording keeps dropped steps


def test_new_mapping_starts_epoch_and_reconnect_gets_current_mapping(setup):
    _, w, graph = setup
    v2 = FlyGraph(w, heads_per_lobe=2)                                       # different graph, so it must replace
    assert v2.mapping != graph.mapping
    s = VizStream(port=0).start()
    s.set_mapping(graph.mapping)
    with connect(s.url, max_size=None) as ws:
        wait_until(lambda: s.harnesses_seen == 1, "the first harness to register")
        s.fire(graph.fire_pairs([0, 1]))                                     # t=0
        s.fire(graph.fire_pairs([0, 1]))                                     # t=1
        first = read_msgs(ws, 3)
        s.set_mapping(v2.mapping)                                            # new epoch: t restarts at 0
        s.fire(v2.fire_pairs([0]))
        s.fire(v2.fire_pairs([0]))
        second = read_msgs(ws, 3)
    with connect(s.url, max_size=None) as ws:                                # reconnect after the new epoch
        wait_until(lambda: s.harnesses_seen == 2, "the reconnected harness to register")
        replay = read_msgs(ws, 1)
        s.fire(v2.fire_pairs([1]))                                           # continues from t=2, no reset
        third = read_msgs(ws, 1)
    s.close()
    assert first[0] == graph.mapping and [m["t"] for m in first[1:]] == [0, 1]
    assert second[0] == v2.mapping and [m["t"] for m in second[1:]] == [0, 1]
    assert replay[0] == v2.mapping
    assert third[0]["type"] == "fire" and third[0]["t"] == 2
