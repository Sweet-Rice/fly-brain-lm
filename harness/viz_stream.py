"""Streams FlyBrainLM activity to the visualization harness.

Implements "Fly Brain Visualization Stream Spec" version 1:
  - WebSocket server, loopback only, default ws://127.0.0.1:8765/stream; one JSON message per text frame.
  - On connect: the current `mapping`, then live `fire` messages. Integers and strings only.
  - Never blocks the model: a harness that falls behind has `fire` messages dropped (gaps in t allowed).
  - Runs normally with zero harnesses; serves several; a mid-run joiner gets the mapping, then live fires.
  - Optional recording: the same messages as newline-delimited JSON.
  - Full API: harness/API.md

What the mapping describes (one block of the model, default block 0):
  groups  0 Glomerulus   1 KC_gamma   2 KC_alphabeta   3 KC_alphaprime_betaprime   4 MBON
  nodes   glomeruli 0..G-1, then KCs G..G+K-1 (wiring order), then the 15 MBON compartments
  edges   glomerulus -> KC   the connectome wiring (9592)
          KC -> MBON         each KC to the 5 compartments of its lobe (the heads that read/write it)
What fires at a step (one token): for every active KC (the top-94), all of its glomerulus -> KC
edges and all of its KC -> MBON edges.

Serving a model: stream_model() starts one long-lived stream per model process. Every harness that
connects, whenever it connects, gets the mapping first; then each message the model reads or writes
fires one step per token. t keeps counting across messages.
"""
import asyncio
import json
import threading
import time

GROUP_NAMES = ["Glomerulus", "KC_gamma", "KC_alphabeta", "KC_alphaprime_betaprime", "MBON"]
LOOPBACK_HOST = "127.0.0.1"


class FlyGraph:
    def __init__(self, wiring, heads_per_lobe=5):
        mask = wiring.mask.cpu()
        K, G = mask.shape
        cls = wiring.kc_class.cpu().tolist()
        kc0, mb0 = G, G + K                                  # first KC id, first MBON id
        nodes = ([{"id": g, "group": 0} for g in range(G)] +
                 [{"id": kc0 + k, "group": 1 + cls[k]} for k in range(K)] +
                 [{"id": mb0 + c, "group": 4} for c in range(3 * heads_per_lobe)])
        self.kc_pairs = []                                   # kc_pairs[k] = every edge that fires when KC k is active
        for k in range(K):
            into = [[g, kc0 + k] for g in mask[k].nonzero().flatten().tolist()]
            out = [[kc0 + k, mb0 + c] for c in range(cls[k] * heads_per_lobe, (cls[k] + 1) * heads_per_lobe)]
            self.kc_pairs.append(into + out)
        self.mapping = {"type": "mapping", "version": 1,
                        "groups": [{"id": i, "name": n} for i, n in enumerate(GROUP_NAMES)],
                        "nodes": nodes,
                        "edges": [p for pairs in self.kc_pairs for p in pairs]}

    def fire_pairs(self, active_kcs):
        return [p for k in active_kcs for p in self.kc_pairs[k]]


class VizStream:
    """Model side. Call set_mapping() once, then fire(pairs) per step. Both return immediately."""

    def __init__(self, host=LOOPBACK_HOST, port=8765, path="/stream", record=None, queue_size=64):
        if host != LOOPBACK_HOST:
            raise ValueError(f"visualization stream is loopback-only; host must be {LOOPBACK_HOST!r}")
        self.host, self.port, self.path, self.queue_size = LOOPBACK_HOST, port, path, queue_size
        self.t = 0                       # next step index; restarts with each mapping
        self.dropped = 0                 # fire messages dropped for slow harnesses
        self.harnesses_seen = 0
        self._mapping_msg = None
        self._clients = set()            # one asyncio.Queue per connected harness (touched only on the loop thread)
        self._n_clients = 0
        self._rec = open(record, "w", buffering=1) if record else None   # line-buffered: survives Ctrl-C
        self._loop = None
        self._ready = threading.Event()
        self._closed = False
        self._error = None               # why the server thread failed to start, if it did

    # ---- model thread -------------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        if not self._ready.wait(10) or self._error:
            raise RuntimeError(f"visualization stream could not start on {self.host}:{self.port}: "
                               f"{self._error or 'timed out'}")
        return self

    @property
    def url(self):
        return f"ws://{self.host}:{self.port}{self.path}"

    @property
    def listening(self):
        return self._n_clients > 0 or self._rec is not None

    def set_mapping(self, mapping):
        self._mapping_msg = json.dumps(mapping, separators=(",", ":"))
        self.t = 0
        self._record(self._mapping_msg)
        self._call(self._broadcast_mapping, self._mapping_msg)

    def fire(self, pairs):
        """Send the pairs that fired at the current step, then advance the step."""
        t, self.t = self.t, self.t + 1
        if self._mapping_msg is None or not pairs or not self.listening:
            return                                          # an empty step may be omitted (spec)
        msg = json.dumps({"type": "fire", "t": t, "pairs": pairs}, separators=(",", ":"))
        self._record(msg)
        if self._n_clients:
            self._call(self._broadcast_fire, msg)

    def skip(self):
        self.t += 1

    def wait_for_harness(self, timeout):
        end = time.time() + timeout
        while self._n_clients == 0 and time.time() < end:
            time.sleep(0.05)
        return self._n_clients > 0

    def close(self, drain_timeout=3.0):
        """Give connected harnesses up to drain_timeout seconds to receive what is queued, then stop."""
        if self._closed:
            return
        self._closed = True
        if self._loop:
            asyncio.run_coroutine_threadsafe(self._shutdown(drain_timeout), self._loop).result(drain_timeout + 5)
        if self._rec:
            self._rec.close()

    def _record(self, msg):
        if self._rec:
            self._rec.write(msg + "\n")

    def _call(self, fn, *args):
        if self._loop and not self._closed:
            self._loop.call_soon_threadsafe(fn, *args)      # hands off to the server thread; never waits

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
        self._stop = self._loop.create_future()
        async with serve(self._handler, self.host, self.port) as server:
            self.port = server.sockets[0].getsockname()[1]  # real port when 0 was requested
            self._ready.set()
            await self._stop

    async def _handler(self, conn):
        from websockets.exceptions import ConnectionClosed
        if conn.request.path != self.path:
            await conn.close(1008, f"unknown path; use {self.path}")
            return
        q = asyncio.Queue(self.queue_size)
        if self._mapping_msg:
            q.put_nowait(self._mapping_msg)                  # mapping is always the first message
        self._clients.add(q)
        self._n_clients = len(self._clients)
        self.harnesses_seen += 1
        try:
            while True:
                await conn.send(await q.get())
        except ConnectionClosed:
            pass
        finally:
            self._clients.discard(q)
            self._n_clients = len(self._clients)

    def _broadcast_mapping(self, msg):
        for q in self._clients:
            while not q.empty():                             # a new mapping makes queued fires meaningless
                q.get_nowait()
            q.put_nowait(msg)

    def _broadcast_fire(self, msg):
        for q in self._clients:
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                self.dropped += 1                            # harness is behind: drop, never wait

    async def _shutdown(self, timeout):
        end = self._loop.time() + timeout
        while any(not q.empty() for q in self._clients) and self._loop.time() < end:
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)                             # let the last send finish
        self._stop.set_result(None)


def attach(model, stream, graph, block=0):
    """Fire one step per token that passes through `block`'s address code. Returns the hook handle
    (call .remove() to detach). Uses batch element 0."""
    def hook(module, inputs, code):                          # code: (B, T, K)
        for t in range(code.shape[1]):
            if stream.listening:
                active = (code[0, t].detach() > 0).nonzero().flatten().tolist()
                stream.fire(graph.fire_pairs(active))
            else:
                stream.skip()
    return model.blocks[block].addr.register_forward_hook(hook)


def stream_model(model, wiring, block=0, **server):
    """Start streaming `model` to the harness and return (VizStream, FlyGraph). The mapping is set
    before the server accepts anyone, so it is every harness's first message; after that each token
    through `block` is one `fire`. `server`: VizStream arguments (loopback host, port, path, record)."""
    graph = FlyGraph(wiring, model.cfg.heads_per_lobe)
    stream = VizStream(**server)
    stream.set_mapping(graph.mapping)
    stream.start()
    attach(model, stream, graph, block)
    return stream, graph
