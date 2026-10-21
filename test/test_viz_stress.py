"""Bounded stream regressions without importing a model or allocating GPU tensors."""
import asyncio
from contextlib import ExitStack
import json
import threading
import time

import pytest
from websockets.asyncio.server import ServerConnection
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from harness.viz_stream import VizStream


TIMEOUT = 5
MAPPING = {"type": "mapping", "version": 1, "groups": [{"id": 0, "name": "stress"}],
           "nodes": [{"id": 0, "group": 0}, {"id": 1, "group": 0}], "edges": [[0, 1]]}
PAIRS = [[0, 1]]


def receive(ws):
    return json.loads(ws.recv(timeout=TIMEOUT))


def wait_until(predicate):
    end = time.monotonic() + TIMEOUT
    while not predicate():
        assert time.monotonic() < end, "server did not finish bounded work"
        time.sleep(0.005)


@pytest.mark.parametrize("size", [0, -1, True, 1.5, "64"])
def test_network_queue_must_be_bounded(size):
    with pytest.raises(ValueError, match="queue_size must be a positive integer"):
        VizStream(queue_size=size)


def test_stalled_event_loop_has_one_wakeup_and_a_bounded_handoff(monkeypatch):
    stream = VizStream(port=0, queue_size=8)
    stream.set_mapping(MAPPING)
    stream.start()
    reached, release = threading.Event(), threading.Event()
    calls = []
    original = stream._loop.call_soon_threadsafe

    def blocked():
        reached.set()
        assert release.wait(TIMEOUT)

    def counted(callback, *args, **kwargs):
        calls.append(callback)
        return original(callback, *args, **kwargs)

    try:
        with connect(stream.url) as ws:
            assert receive(ws) == MAPPING
            original(blocked)
            assert reached.wait(TIMEOUT)
            monkeypatch.setattr(stream._loop, "call_soon_threadsafe", counted)
            for _ in range(10_000):
                stream.fire(PAIRS)
            assert len(stream._pending) == stream.queue_size
            largest_fire = json.dumps({"type": "fire", "t": 9_999, "pairs": PAIRS}, separators=(",", ":"))
            assert sum(len(args[0]) for _, args in stream._pending) <= stream.queue_size * len(largest_fire)
            assert len(calls) == 1
            assert stream.dropped == 10_000 - stream.queue_size

            replacement = {**MAPPING, "groups": [{"id": 0, "name": "replacement"}]}
            stream.set_mapping(replacement)
            for _ in range(10_000):
                stream.fire(PAIRS)
            assert len(stream._pending) == stream.queue_size and len(calls) == 1
            release.set()
            assert receive(ws) == replacement
            fires = [receive(ws) for _ in range(stream.queue_size - 1)]
            assert [fire["t"] for fire in fires] == list(range(stream.queue_size - 1))
            assert all(fire["pairs"] == PAIRS for fire in fires)
    finally:
        release.set()
        stream.close()


def test_handoff_yields_after_one_batch_even_while_producer_keeps_it_full():
    scheduled = []

    class Loop:
        def call_soon(self, callback):
            scheduled.append(callback)

        call_soon_threadsafe = call_soon

    stream = VizStream(queue_size=4)
    stream._loop = Loop()
    processed = []

    def produce():
        processed.append(1)
        stream._call(produce)

    stream._call(produce)
    scheduled.pop()()
    assert len(processed) == stream.queue_size
    assert len(scheduled) == len(stream._pending) == 1


def test_stalled_writer_drops_whole_fires_and_leaves_healthy_client_running(monkeypatch):
    reached, release = threading.Event(), threading.Event()
    original = ServerConnection.send
    target = None

    async def send(conn, message, *args, **kwargs):
        if conn.remote_address == target and json.loads(message)["type"] == "fire" and not reached.is_set():
            reached.set()
            assert await asyncio.to_thread(release.wait, TIMEOUT)
        return await original(conn, message, *args, **kwargs)

    monkeypatch.setattr(ServerConnection, "send", send)
    stream = VizStream(port=0, queue_size=4)
    stream.set_mapping(MAPPING)
    stream.start()
    try:
        with ExitStack() as clients:
            slow = clients.enter_context(connect(stream.url))
            healthy = clients.enter_context(connect(stream.url))
            assert receive(slow) == receive(healthy) == MAPPING
            target = slow.local_address
            stream.fire(PAIRS)
            assert reached.wait(TIMEOUT)
            assert receive(healthy)["t"] == 0
            for t in range(1, 301):
                stream.fire(PAIRS)
                assert receive(healthy) == {"type": "fire", "t": t, "pairs": PAIRS}
                assert all(q.qsize() <= stream.queue_size for q in stream._clients)
            assert stream.dropped == 300 - stream.queue_size
            release.set()
            assert [receive(slow)["t"] for _ in range(1 + stream.queue_size)] == list(range(5))
            stream.fire(PAIRS)
            assert receive(slow)["t"] == receive(healthy)["t"] == 301
    finally:
        release.set()
        stream.close()


def test_stalled_recording_keeps_model_publication_bounded(monkeypatch):
    reached, release = threading.Event(), threading.Event()
    lines = []

    class Sink:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def write(self, line):
            reached.set()
            assert release.wait(TIMEOUT)
            lines.append(line)

    monkeypatch.setattr("harness.viz_stream.open", lambda *args, **kwargs: Sink(), raising=False)
    stream = VizStream(record="stalled.ndjson", record_queue_size=8)
    try:
        stream.set_mapping(MAPPING)
        assert reached.wait(TIMEOUT)
        for _ in range(10_000):
            stream.fire(PAIRS)
        assert not release.is_set()
        assert stream._recorder._queue.qsize() == 8
        assert stream.recording_dropped == 10_000 - 8
    finally:
        release.set()
        stream.close()
    assert json.loads(lines[0]) == MAPPING
    assert [json.loads(line)["t"] for line in lines[1:]] == list(range(8))


def test_repeated_reconnects_and_replacements_are_mapping_first_and_release_handlers():
    stream = VizStream(port=0, queue_size=8)
    stream.set_mapping(MAPPING)
    stream.start()
    try:
        for epoch in range(30):
            replacement = {**MAPPING, "groups": [{"id": 0, "name": f"epoch {epoch}"}]}
            stream.set_mapping(replacement)
            with connect(stream.url) as first, connect(stream.url) as second:
                assert receive(first) == receive(second) == replacement
                stream.fire(PAIRS)
                assert receive(first) == receive(second) == {"type": "fire", "t": 0, "pairs": PAIRS}
            wait_until(lambda: not stream._clients)
        assert stream.harnesses_seen == 60
        wait_until(lambda: not stream._pending and not stream._drain_scheduled)
    finally:
        stream.close(drain_timeout=0.1)
    wait_until(lambda: stream._loop.is_closed())


def test_shutdown_cancels_a_writer_that_never_finishes(monkeypatch):
    reached = threading.Event()
    original = ServerConnection.send

    async def send(conn, message, *args, **kwargs):
        if json.loads(message)["type"] == "fire":
            reached.set()
            await asyncio.Future()
        return await original(conn, message, *args, **kwargs)

    monkeypatch.setattr(ServerConnection, "send", send)
    stream = VizStream(port=0, queue_size=2)
    stream.set_mapping(MAPPING)
    stream.start()
    with connect(stream.url) as ws:
        assert receive(ws) == MAPPING
        stream.fire(PAIRS)
        assert reached.wait(TIMEOUT)
        for _ in range(100):
            stream.fire(PAIRS)
        stream.close(drain_timeout=0.05)
        wait_until(lambda: stream._loop.is_closed())
    assert not stream._clients and not stream._pending


def test_failed_writer_disconnects_instead_of_leaving_a_dead_client(monkeypatch):
    original = ServerConnection.send

    async def send(conn, message, *args, **kwargs):
        if json.loads(message)["type"] == "fire":
            raise OSError("simulated transport failure")
        return await original(conn, message, *args, **kwargs)

    monkeypatch.setattr(ServerConnection, "send", send)
    stream = VizStream(port=0)
    stream.set_mapping(MAPPING)
    stream.start()
    try:
        with connect(stream.url) as ws:
            assert receive(ws) == MAPPING
            stream.fire(PAIRS)
            with pytest.raises(ConnectionClosed):
                receive(ws)
        wait_until(lambda: not stream._clients)
        with connect(stream.url) as ws:
            assert receive(ws) == MAPPING
    finally:
        stream.close()
