"""Streams FlyBrainLM activity to the visualization harness.

Implements "Fly Brain Visualization Stream Spec" version 1:
  - WebSocket server, loopback only, default ws://127.0.0.1:8765/stream; one JSON message per text frame.
  - On connect: the current `mapping`, then live `fire` messages. Integers and strings only.
  - Never blocks the model: a harness that falls behind has `fire` messages dropped (gaps in t allowed).
  - Runs normally with zero harnesses; serves several; a mid-run joiner gets the mapping, then live fires.
  - Optional recording: bounded background writer for the same messages as newline-delimited JSON.
  - Optional extension messages (SPEC.md "Extension messages"): send_event() queues them in call order, and a
    status_factory (set by harness.telemetry.adapter) adds stream_status markers; without one the wire is plain v1.
  - Full API: harness/API.md

What the mapping describes (one block of the model, default block 0):
  groups  0 Glomerulus   1 KC_gamma   2 KC_alphabeta   3 KC_alphaprime_betaprime   4 MBON
  nodes   glomeruli 0..G-1, then KCs G..G+K-1 (wiring order), then the 3 x heads_per_lobe MBON compartments
  edges   glomerulus -> KC   the connectome wiring (9592)
          KC -> MBON         each KC to the heads_per_lobe compartments of its lobe (the heads that read/write it)
What fires at a step (one token): for every active KC (code > 0), all of its glomerulus -> KC
edges and all of its KC -> MBON edges.

Serving a model: stream_model() starts one long-lived stream per model process. Every harness that
connects, whenever it connects, gets the mapping first; then each message the model reads or writes
fires one step per token. t keeps counting across messages.
"""
import asyncio
from collections import deque
import json
import queue
import threading
import time
import warnings

GROUP_NAMES = ["Glomerulus", "KC_gamma", "KC_alphabeta", "KC_alphaprime_betaprime", "MBON"]
LOOPBACK_HOST = "127.0.0.1"


class FlyGraph:
    """Snapshot one model block's topology. Refresh only while inference is paused."""

    def __init__(self, model, block=0):
        self._model, self._block = model, block
        self.refresh()

    def refresh(self):
        """Rebuild atomically from the live model; publish the returned mapping before resuming."""
        import torch

        if type(self._block) is not int or self._block < 0:
            raise ValueError("block must identify an existing model block")
        try:
            mask, lobes = self._model.kc_topology(self._block)
        except IndexError:
            raise ValueError("block must identify an existing model block") from None
        if not torch.is_tensor(mask) or mask.ndim != 2 or mask.dtype != torch.bool:
            raise ValueError("address mask must be a two-dimensional boolean tensor")
        mask = mask.detach().cpu()
        K, G = mask.shape
        heads_per_lobe = self._model.heads_per_lobe
        if type(heads_per_lobe) is not int or heads_per_lobe < 1:
            raise ValueError("heads per lobe must be a positive integer")
        if len(lobes) != 3:
            raise ValueError("lobe membership must name exactly three lobes")
        cls = [None] * K
        for lobe, members in enumerate(lobes):
            if members.ndim != 1:
                raise ValueError("lobe membership must be one-dimensional")
            for k in members.detach().cpu().tolist():
                if type(k) is not int or not 0 <= k < K or cls[k] is not None:
                    raise ValueError("lobe membership must contain distinct declared KC indices")
                cls[k] = lobe
        if any(lobe is None for lobe in cls):
            raise ValueError("every KC must belong to exactly one lobe")

        kc0, mb0 = G, G + K                                  # first KC id, first MBON id
        nodes = ([{"id": g, "group": 0} for g in range(G)] +
                 [{"id": kc0 + k, "group": 1 + cls[k]} for k in range(K)] +
                 [{"id": mb0 + c, "group": 4} for c in range(3 * heads_per_lobe)])
        kc_pairs = []                                       # a boolean mask and disjoint lobes prevent duplicate edges
        for k in range(K):
            into = [[g, kc0 + k] for g in mask[k].nonzero().flatten().tolist()]
            out = [[kc0 + k, mb0 + c] for c in range(cls[k] * heads_per_lobe, (cls[k] + 1) * heads_per_lobe)]
            kc_pairs.append(into + out)
        mapping = {"type": "mapping", "version": 1,
                   "groups": [{"id": i, "name": n} for i, n in enumerate(GROUP_NAMES)],
                   "nodes": nodes,
                   "edges": [p for pairs in kc_pairs for p in pairs]}
        self.kc_pairs, self.mapping = kc_pairs, mapping
        return mapping

    def fire_pairs(self, active_kcs):
        return [p for k in active_kcs for p in self.kc_pairs[k]]


class _NDJSONRecorder:
    """Bounded background writer. Model-thread enqueue methods never perform file I/O or wait.
    A queue item is (messages it holds that count as dropped if it is discarded, text of one or more NDJSON
    lines, earlier drops its gap marker reports)."""

    def __init__(self, path, queue_size):
        if isinstance(queue_size, bool) or not isinstance(queue_size, int) or queue_size < 1:
            raise ValueError("record_queue_size must be a positive integer")
        self.path = path
        self.dropped = 0
        self.unreported = 0              # drops no queued or written gap marker reports yet
        self.error = None
        self._queue = queue.Queue(queue_size)
        self._stop = threading.Event()
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, name="flybrain-viz-recorder", daemon=True)
        self._thread.start()

    @property
    def active(self):
        return self.error is None and not self._stop.is_set()

    def mapping(self, msg, marker=None):
        """Keep replacement mappings even when that requires dropping queued fires from the old epoch. A marker
        (epoch_reset) is written right after the mapping as part of the same queue item, so it is kept as well."""
        item = (0, msg if marker is None else f"{msg}\n{marker}", 0)
        while self.active:
            try:
                self._queue.put_nowait(item)
                return True
            except queue.Full:
                self._discard_pending()
        return False

    def fire(self, msg):
        if not self.active:
            return False
        try:
            self._queue.put_nowait((1, msg, 0))
            return True
        except queue.Full:
            self._lose(1)
            return False

    def fire_after_marker(self, make_marker, msg):
        """Queue a gap marker reporting the unreported drops, then the message it precedes, as one item written as
        two lines, only if the queue has room for both (an empty queue always has); else the message is dropped
        too. make_marker(lost) runs only when they fit. The stream's single producer holds event_lock and the
        writer only removes items, so the room check cannot go stale."""
        if not self.active:
            return False
        if self._queue.qsize() and self._queue.qsize() + 2 > self._queue.maxsize:
            self._lose(1)
            return False
        lost, self.unreported = self.unreported, 0
        self._queue.put_nowait((1, f"{make_marker(lost)}\n{msg}", lost))
        return True

    def close(self, timeout):
        self._stop.set()
        if self._done.wait(max(0.0, timeout)):
            return
        if self.error is None:
            self.error = TimeoutError(f"visualization recording did not drain within {timeout:g}s")
        warnings.warn(str(self.error), RuntimeWarning, stacklevel=2)

    def _lose(self, n, reported=0):
        self.dropped += n
        self.unreported += n + reported              # a discarded gap marker no longer reports its drops

    def _discard_pending(self):
        while True:
            try:
                lost, _, reported = self._queue.get_nowait()
                self._lose(lost, reported)
            except queue.Empty:
                return

    def _run(self):
        current = None
        try:
            with open(self.path, "w", encoding="utf-8", buffering=1, newline="\n") as rec:
                while not self._stop.is_set() or not self._queue.empty():
                    try:
                        current = self._queue.get(timeout=0.05)
                    except queue.Empty:
                        continue
                    rec.write(current[1] + "\n")
                    current = None
        except Exception as exc:
            if current is not None:
                self._lose(current[0], current[2])
            self.error = exc
            warnings.warn(f"visualization recording stopped: {exc}", RuntimeWarning, stacklevel=2)
        finally:
            self._discard_pending()
            self._done.set()


class VizStream:
    """Model side. Call set_mapping() once, then fire(pairs) per step. All calls return immediately.

    send_event(event) adds an extension message. With status_factory set ((event, dropped, seq=None) ->
    stream_status dict, see harness.telemetry.adapter) every consumer also gets markers: resync after a new
    harness's mapping, epoch_reset after a replacement mapping, and gap before the first message a consumer
    accepts after losing messages. Sequence numbers come from next_seq() under event_lock, and every message
    handed to consumers in that mode carries a value reserved just before it for its possible gap marker, so
    each consumer receives strictly increasing seq."""

    def __init__(self, host=LOOPBACK_HOST, port=8765, path="/stream", record=None, queue_size=64,
                 record_queue_size=256):
        if host != LOOPBACK_HOST:
            raise ValueError(f"visualization stream is loopback-only; host must be {LOOPBACK_HOST!r}")
        if type(queue_size) is not int or queue_size < 1:
            raise ValueError("queue_size must be a positive integer")
        self.host, self.port, self.path, self.queue_size = LOOPBACK_HOST, port, path, queue_size
        self.t = 0                       # next step index; restarts with each mapping
        self.epoch = 0                   # mapping epoch: 0 for the first mapping, +1 per replacement
        self.dropped = 0                 # fire messages dropped for slow harnesses
        self.harnesses_seen = 0
        self.status_factory = None       # stream_status factory; None keeps the plain v1 wire
        self.event_lock = threading.RLock()   # held while a message is sequenced and handed off (markers on)
        self._seq = 0                    # next sequence number (next_seq)
        self._mapping_msg = None
        self._server_mapping_msg = None  # only published mappings may precede queued fires on a new socket
        self._pending = deque()
        self._handoff_lock = threading.Lock()
        self._drain_scheduled = False
        self._clients = set()            # one asyncio.Queue per connected harness (touched only on the loop thread)
        self._n_clients = 0              # connected harnesses, including any still waiting to join
        self._joining = set()            # queues waiting for their turn in the handoff (markers on)
        self._client_dropped = {}        # queue -> messages it lost since its last gap marker
        self._client_mark = {}           # queue -> _handoff_lost already accounted for that harness
        self._handoff_lost = 0           # messages lost before reaching any queue, ever (monotonic)
        self._recorder = _NDJSONRecorder(record, record_queue_size) if record else None
        self._loop = None
        self._ready = threading.Event()
        self._closed = False
        self._error = None               # why the server thread failed to start, if it did

    # ---- model thread -------------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        if not self._ready.wait(10) or self._error:
            self.close()
            raise RuntimeError(f"visualization stream could not start on {self.host}:{self.port}: "
                               f"{self._error or 'timed out'}")
        return self

    @property
    def url(self):
        return f"ws://{self.host}:{self.port}{self.path}"

    @property
    def listening(self):
        return self._n_clients > 0 or (self._recorder is not None and self._recorder.active)

    @property
    def recording_dropped(self):
        return self._recorder.dropped if self._recorder else 0

    @property
    def recording_error(self):
        return self._recorder.error if self._recorder else None

    def set_mapping(self, mapping):
        with self.event_lock:
            replaced = self._mapping_msg is not None
            self._mapping_msg = json.dumps(mapping, separators=(",", ":"))
            self.t = 0
            if replaced:
                self.epoch += 1
            factory = self.status_factory
            if replaced and factory is not None:
                # epoch_reset travels with the mapping, so no bounded queue can separate or drop it
                marker = json.dumps(factory("epoch_reset", 0), separators=(",", ":"))
                if self._recorder:
                    self._recorder.mapping(self._mapping_msg, marker)
                self._call(self._broadcast_mapping, self._mapping_msg, marker)
            else:
                self._record(self._mapping_msg, mapping=True)
                self._call(self._broadcast_mapping, self._mapping_msg)

    def fire(self, pairs):
        """Send the pairs that fired at the current step, then advance the step."""
        t, self.t = self.t, self.t + 1
        if self._mapping_msg is None or not pairs or not self.listening:
            return                                          # an empty step may be omitted (spec)
        msg = json.dumps({"type": "fire", "t": t, "pairs": pairs}, separators=(",", ":"))
        if self.status_factory is None:
            self._record(msg)
            if self._n_clients:
                self._call(self._broadcast_payload, msg)
        else:
            with self.event_lock:
                self._hand_off(msg, self.next_seq())

    def send_event(self, event, gap_seq=None):
        """Send one extension message (a JSON object of integers and strings) to every harness and the
        recording, ordered with the other messages; never blocks and does not advance t. Returns False when
        no mapping is set or nobody is listening. A caller that gave `event` a seq from next_seq() passes
        gap_seq, a value it took from next_seq() just before, for a gap marker that may have to precede it."""
        if self._mapping_msg is None or not self.listening:
            return False
        msg = json.dumps(event, separators=(",", ":"))
        with self.event_lock:
            if self.status_factory is None:
                self._record(msg)
                if self._n_clients:
                    self._call(self._broadcast_payload, msg)
            else:
                self._hand_off(msg, self.next_seq() if gap_seq is None else gap_seq)
        return True

    def next_seq(self):
        """The next value of this stream's sequence counter, starting at 0."""
        with self.event_lock:
            seq, self._seq = self._seq, self._seq + 1
            return seq

    def skip(self):
        self.t += 1

    def wait_for_harness(self, timeout):
        end = time.time() + timeout
        while self._n_clients == 0 and time.time() < end:
            time.sleep(0.05)
        return self._n_clients > 0

    def close(self, drain_timeout=3.0):
        """Give network and recording queues up to drain_timeout seconds each, then stop."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._loop and self._loop.is_running():
                asyncio.run_coroutine_threadsafe(self._shutdown(drain_timeout), self._loop).result(drain_timeout + 5)
        finally:
            if self._recorder:
                self._recorder.close(drain_timeout)

    def _record(self, msg, mapping=False):
        if self._recorder:
            (self._recorder.mapping if mapping else self._recorder.fire)(msg)

    def _hand_off(self, msg, gap_seq):
        """Markers on, event_lock held: record and broadcast one message. A consumer that lost messages gets a
        gap marker with seq gap_seq right before it, if its queue has room for both."""
        recorder = self._recorder
        if recorder:
            if recorder.unreported:
                recorder.fire_after_marker(lambda lost: self._gap_message(lost, gap_seq), msg)
            else:
                recorder.fire(msg)
        if self._n_clients:
            # _handoff_lost here counts the handoff losses sequenced before this message (event_lock is held)
            self._call(self._broadcast_payload, msg, gap_seq, self._handoff_lost)

    def _gap_message(self, dropped, seq):
        return json.dumps(self.status_factory("gap", dropped, seq=seq), separators=(",", ":"))

    def _call(self, fn, *args):
        if not self._loop or self._closed:
            return
        with self._handoff_lock:
            if fn == self._broadcast_mapping:
                # Queued fires and extension messages belong to the old mapping; waiting joins keep their turn.
                kept = [item for item in self._pending
                        if item[0] != self._broadcast_payload and item[0] != self._broadcast_mapping]
                self._handoff_lost += sum(1 for item in self._pending   # markers on: report as lost
                                          if item[0] == self._broadcast_payload and len(item[1]) == 3)
                self._pending.clear()
                self._pending.extend(kept)
            elif len(self._pending) >= self.queue_size:
                self.dropped += self._n_clients
                self._handoff_lost += 1
                return
            self._pending.append((fn, args))
            if not self._drain_scheduled:
                self._drain_scheduled = True
                self._loop.call_soon_threadsafe(self._drain_pending)

    def _drain_pending(self):
        # Yield after a bounded batch so a fast producer cannot starve socket writers.
        for _ in range(self.queue_size):
            with self._handoff_lock:
                item = self._pending.popleft() if self._pending else None
            if item is None:
                break
            fn, args = item
            fn(*args)
        with self._handoff_lock:
            if self._pending:
                self._loop.call_soon(self._drain_pending)
            else:
                self._drain_scheduled = False

    # ---- server thread ------------------------------------------------------------------------
    def _run(self):
        try:
            asyncio.run(self._main())
        except Exception as e:                               # e.g. the port is already in use
            self._error = e
            self._ready.set()

    async def _main(self):
        from websockets.asyncio.server import serve
        self._loop = asyncio.get_running_loop()
        self._server_mapping_msg = self._mapping_msg
        self._stop = self._loop.create_future()
        async with serve(self._handler, self.host, self.port, close_timeout=1) as server:
            self.port = server.sockets[0].getsockname()[1]  # real port when 0 was requested
            self._ready.set()
            await self._stop

    async def _handler(self, conn):
        from websockets.exceptions import ConnectionClosed
        if conn.request.path != self.path:
            await conn.close(1008, f"unknown path; use {self.path}")
            return
        factory = self.status_factory
        if factory is None:
            q = asyncio.Queue(self.queue_size)
            if self._server_mapping_msg:
                q.put_nowait((self._server_mapping_msg, 0, 0))   # mapping is always the first message
            self._clients.add(q)
        else:
            # Room for a marker and the message it follows or precedes, even with queue_size 1.
            q = asyncio.Queue(max(self.queue_size, 2))
            # Join at this harness's turn in the handoff: its mapping and resync marker come after every message
            # sequenced before the resync, and everything sequenced after it follows.
            with self.event_lock:
                self._joining.add(q)
                self._n_clients = len(self._clients) + len(self._joining)
                resync = json.dumps(factory("resync", 0), separators=(",", ":"))
                with self._handoff_lock:
                    self._pending.append((self._join_client, (q, resync, self._handoff_lost)))
                    if not self._drain_scheduled:
                        self._drain_scheduled = True
                        self._loop.call_soon(self._drain_pending)
        self._n_clients = len(self._clients) + len(self._joining)
        self.harnesses_seen += 1

        async def write():
            try:
                while True:
                    await conn.send((await q.get())[0])
            except ConnectionClosed:
                pass

        writer = asyncio.create_task(write())
        closed = asyncio.create_task(conn.wait_closed())
        try:
            await asyncio.wait((writer, closed), return_when=asyncio.FIRST_COMPLETED)
            if writer.done():
                await writer
        finally:
            writer.cancel()
            closed.cancel()
            await asyncio.gather(writer, closed, return_exceptions=True)
            self._clients.discard(q)
            self._joining.discard(q)
            self._client_dropped.pop(q, None)
            self._client_mark.pop(q, None)
            self._n_clients = len(self._clients) + len(self._joining)

    # Harness queue items: (text, messages lost if the item is discarded, earlier losses its gap marker reports).
    def _broadcast_mapping(self, msg, marker=None):
        self._server_mapping_msg = msg
        markers = self.status_factory is not None
        for q in self._clients:
            lost = 0
            while not q.empty():                             # a new mapping makes queued fires meaningless
                _, n, reported = q.get_nowait()
                lost += n + reported
            if markers and lost:                             # but the next gap marker reports them
                self._client_dropped[q] = self._client_dropped.get(q, 0) + lost
            q.put_nowait((msg, 0, 0))
            if marker is not None and not q.full():          # full only for a harness joined before markers
                q.put_nowait((marker, 0, 0))                 # epoch_reset right after the mapping

    def _broadcast_payload(self, msg, gap_seq=None, mark=0):
        """Queue one fire or extension message for every harness; a full queue drops it, never waits.
        gap_seq (markers on): a harness that lost messages first gets a gap marker with this seq, but only
        when its queue has room for both; otherwise this message is lost too and counted. mark: the handoff
        losses sequenced before this message."""
        factory = self.status_factory
        for q in self._clients:
            if gap_seq is None or factory is None or q.maxsize < 2:   # plain v1, or joined before markers
                try:
                    q.put_nowait((msg, 1, 0))
                except asyncio.QueueFull:
                    self.dropped += 1                        # harness is behind: drop, never wait
                continue
            lost = self._client_dropped.pop(q, 0) + mark - self._client_mark.get(q, mark)
            self._client_mark[q] = mark
            if not lost and q.qsize() < self.queue_size:
                q.put_nowait((msg, 1, 0))
            elif lost and q.qsize() + 2 <= q.maxsize:
                q.put_nowait((json.dumps(factory("gap", lost, seq=gap_seq), separators=(",", ":")), 0, lost))
                q.put_nowait((msg, 1, 0))
            else:
                self.dropped += 1                            # harness is behind: drop, never wait
                self._client_dropped[q] = lost + 1

    def _join_client(self, q, resync, mark):
        if q not in self._joining:
            return                                           # disconnected before its turn
        self._joining.discard(q)
        self._client_mark[q] = mark                          # handoff losses before its turn are not its losses
        if self._server_mapping_msg:
            q.put_nowait((self._server_mapping_msg, 0, 0))   # mapping is always the first message
            q.put_nowait((resync, 0, 0))                     # a fresh queue holds at least two
        self._clients.add(q)
        self._n_clients = len(self._clients) + len(self._joining)

    async def _shutdown(self, timeout):
        end = self._loop.time() + timeout
        while (self._pending or any(not q.empty() for q in self._clients)) and self._loop.time() < end:
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)                             # let the last send finish
        self._stop.set_result(None)


def attach(model, stream, graph, block=0):
    """Fire one step per token that passes through `block`'s KC code (model.kc_code_module(block)). Returns the hook handle
    (call .remove() to detach). Uses batch element 0."""
    def hook(module, inputs, code):                          # code: (B, T, K)
        positive = None
        for t in range(code.shape[1]):
            if stream.listening:
                if positive is None:
                    # One host transfer per address output; avoid CUDA nonzero's per-token synchronization.
                    positive = (code[0].detach() > 0).cpu()
                active = positive[t].nonzero().flatten().tolist()
                stream.fire(graph.fire_pairs(active))
            else:
                stream.skip()
    return model.kc_code_module(block).register_forward_hook(hook)


def stream_model(model, wiring, block=0, **server):
    """Start streaming `model` to the harness and return (VizStream, FlyGraph). The mapping is set
    before the server accepts anyone; each token through `block` is one `fire`. Topology comes from
    that model block, not the `wiring` argument retained by the frozen serving API.
    `server`: VizStream arguments, including record_queue_size."""
    graph = FlyGraph(model, block)
    stream = VizStream(**server)
    stream.set_mapping(graph.mapping)
    stream.start()
    attach(model, stream, graph, block)
    return stream, graph
