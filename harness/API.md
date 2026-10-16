# Fly Brain Visualization Stream API (v1)

Serving-side reference for the stream implemented in `harness/viz_stream.py` (`FlyGraph`, `VizStream`, `attach`, `stream_model`). Harness authors and model developers read this. Where this document says MUST, SHOULD, or MAY, the keywords follow RFC 2119. Symbol names are the citation targets; line numbers are deliberately omitted.

## 1. Status & scope

- This document describes "Fly Brain Visualization Stream Spec v1" as implemented by `harness/viz_stream.py`.
- The team spec at https://claude.ai/code/artifact/3c7476db-401d-4d3f-b92e-0ab223f8af71 is authoritative for the wire format. This document was written from the code. The spec URL could not be read: the reader returned only an artifact shell and a notice about user-generated content. Nothing here has been checked against the spec's text.
- If the spec and this document conflict, the spec wins. Then this document and `harness/viz_stream.py` MUST be corrected to match it.
- Values in §6 are informative and may change without a version bump.

## 2. Transport

- **Server.** `VizStream` runs a `websockets` server (`websockets.asyncio.server.serve`) on a background thread. Its constructor defaults are `host="127.0.0.1"`, `port=8765`, `path="/stream"`. These are parameters, not constants. `model.serve.ask` exposes `--host`, `--port`, and `--path`. `model.serve.serve` exposes only `--viz-port`, so its stream keeps the default host.
- **Loopback is the default, not enforced.** `VizStream(host="0.0.0.0")` accepts connections from other machines. Nothing in `VizStream` rejects a non-loopback peer.
- **Wrong path.** `VizStream._handler` uses an exact match against the configured request target, including any query string. With the default path, `/stream/` and `/stream?client=x` are rejected. This check runs after the handshake: open is followed by close code 1008, reason `unknown path; use /stream` (or the configured path). Code 1008 and that default reason were observed.
- **Frames.** Each message is one JSON object in one text frame, with compact separators (`json.dumps(..., separators=(",", ":"))`). The server sends no binary frames. Required v1 values have integer or string scalars, never floats or nulls (`FlyGraph.__init__`, `VizStream.fire`). `VizStream` does not validate mappings or fire pairs: custom producers MUST satisfy §4 and §5 themselves. Harnesses MUST NOT crash on malformed frames (§7).
- **Client to server.** The server never reads application messages (`VizStream._handler` only sends). Harnesses send nothing.
- **Reconnect.** A harness MUST reconnect after any close. The example retries every 1000 ms (`connect`, `scheduleRetry`). Every connection begins with the current mapping (§3), resetting client state, not the server's step counter.
- **Shutdown.** `VizStream.close(drain_timeout=3.0)` gives queued messages up to 3 seconds to be taken, then signals server shutdown (`VizStream._shutdown`). The HTTP source produced a clean close code 1001 with an empty reason. Connection/retry observations also included 1006. Close codes are not a protocol guarantee: 1001 comes from the server library, not an explicit code in `viz_stream.py`. Harnesses MUST reconnect regardless of close code.
- **Message size.** The v1 mapping for the current graph is 239,205 bytes of compact JSON (measured). The example harness in headless Chromium and `harness.watch_stream` (which connects with `max_size=None`) handle it. No portable message-size limit is promised, so harnesses SHOULD NOT assume one in either direction.
- **Browser note (Chrome Local Network Access).** The [Chrome 147 release notes](https://developer.chrome.com/release-notes/147#local-network-access) describe Local Network Access permission prompts for WebSockets into a more-local address space; see also the [LNA overview](https://developer.chrome.com/blog/local-network-access). A public HTTPS page connecting to loopback is subject to that permission, with enterprise policy and existing grants affecting prompts. Serve this example from `http://127.0.0.1:<port>`: same-loopback connections worked in headless Chromium. `file://` is not guaranteed prompt-free. An opaque `about:blank` page previously failed with close code 1006. These browser observations are not protocol guarantees; see [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket).

## 3. Session lifecycle

```mermaid
sequenceDiagram
    participant M as Model process (VizStream)
    participant H as Harness
    H->>M: connect ws://<host>:<port>/stream
    alt path is not /stream
        M-->>H: close 1008 "unknown path; use /stream"
    else
        M-->>H: mapping (always the first message)
        loop each model step that has pairs
            M-->>H: fire {t, pairs}
        end
        opt set_mapping called again (new epoch)
            M-->>H: mapping (replaces everything; t restarts at 0)
        end
        M-->>H: close (on shutdown; queued messages drained up to 3 s)
    end
```

- **One server per model process.** `stream_model` calls `VizStream.set_mapping` before the server accepts anyone, so the first message to every harness is the mapping, including harnesses that connect mid-run.
- **Lifetime.** The stream stays up across every message of `model.serve.ask` and every request of `model.serve.serve`. `t` keeps counting across them.
- **Mid-run join.** A harness that connects later receives the current mapping and then only live fires. Earlier fires are not replayed.
- **New mapping.** `set_mapping` called again starts a new epoch. Every connected harness receives the new mapping. Fires still queued for that harness are discarded (`VizStream._broadcast_mapping`). `t` restarts at 0. Fires already sent on a socket cannot be recalled.
- **Several harnesses.** Each harness has its own queue (`queue_size`, default 64). A harness that falls behind has fires dropped (`VizStream._broadcast_fire`, counted in `VizStream.dropped`). It never blocks the model, and it never loses the mapping, because the mapping is queued only after that harness's backlog is discarded.

## 4. `mapping` message

| Field | Type | Rule |
|---|---|---|
| `type` | string | Always `"mapping"`. |
| `version` | integer | `1` for this document. Checked on every mapping (§7). |
| `groups` | array of `{id: int, name: string}` | `id` values are unique. `name` is a label. |
| `nodes` | array of `{id: int, group: int}` | Ids are exactly `0..N-1` in ascending array order (`nodes[i].id == i`). `group` MUST equal the `id` of an entry in `groups`. |
| `edges` | array of `[src: int, dst: int]` | Pairs are unique. Both are node ids. Direction is src to dst. |

- **A node's type** is the entry in `groups` whose `id` equals `node.group`. Look it up by id. Do not index the `groups` array by `group`: the current ids happen to be `0..4` in array order, which is not a rule.
- **A node's connections** are the edges where it is `src` (its outputs) or `dst` (its inputs).
- **Extensibility.** Groups and nodes are objects, so they can gain optional fields (§7). An edge is a two-element array, not an extensible object. Optional per-edge metadata MAY use a separate new field, leaving `edges` unchanged. Changing `edges` elements into objects or longer arrays is breaking (§7). Sources: `FlyGraph.__init__`, `VizStream.set_mapping`.

Example. This is the real output of `FlyGraph` for a tiny wiring: `Wiring.random(n_kc=3, n_glom=2, per_kc=1, class_counts=(1,1,1), seed=0)` with `heads_per_lobe=1`.

```json
{"type":"mapping","version":1,"groups":[{"id":0,"name":"Glomerulus"},{"id":1,"name":"KC_gamma"},{"id":2,"name":"KC_alphabeta"},{"id":3,"name":"KC_alphaprime_betaprime"},{"id":4,"name":"MBON"}],"nodes":[{"id":0,"group":0},{"id":1,"group":0},{"id":2,"group":1},{"id":3,"group":2},{"id":4,"group":3},{"id":5,"group":4},{"id":6,"group":4},{"id":7,"group":4}],"edges":[[0,2],[2,5],[1,3],[3,6],[1,4],[4,7]]}
```

Reading it: edge `[0,2]` is glomerulus 0 to KC node 2 (`KC_gamma`), and edge `[2,5]` is that KC to MBON compartment 5.

## 5. `fire` message

- **Format.** `{"type":"fire","t":<int>,"pairs":[[src,dst], ...]}`.
- **`t`** is an integer ≥ 0: the model step, one token through the visualized block (`attach` fires once per token of the block's address code). Within one server mapping epoch `t` strictly increases. Only `VizStream.set_mapping` resets it to 0; it keeps counting across messages, requests, and client reconnects. A client's first fire after receiving a mapping may have any `t` ≥ 0.
- **`pairs`** is an array of two-integer `[src,dst]` arrays, each a declared edge, with no duplicates within a message. `VizStream.fire` omits empty arrays. Uniqueness in the model stream comes from `attach` passing each active KC once (`nonzero()`); `FlyGraph.fire_pairs` concatenates their distinct edges but does not deduplicate repeated input KC indices.
- **Gaps.** A step produces no fire when its pairs are empty (the server omits it), when nothing is listening (no harness and no recording; the server counts the step and skips it), or when a harness's queue is full (dropped). A harness cannot tell these apart. A gap means only that some steps were not delivered. A harness MUST NOT assume a fire for every `t`.
- **Order.** Each harness's fires arrive in `t` order (one FIFO queue per harness).
- **Within a fire,** the order of `pairs` carries no meaning.

## 6. Current v1 graph content (informative; may change without a version bump)

- **Groups** (`GROUP_NAMES`): 0 Glomerulus, 1 KC_gamma, 2 KC_alphabeta, 3 KC_alphaprime_betaprime, 4 MBON.
- **Nodes** (`FlyGraph.__init__`):
  - glomeruli: ids `0..G-1`, group 0;
  - KCs: ids `G..G+K-1` in wiring order, group `1 + kc_class[k]`. Current wiring is class-sorted (`data.build_wiring.build`), but harnesses MUST NOT assume contiguous group membership;
  - MBON compartments: ids `G+K..G+K+3·heads_per_lobe-1`, group 4. Compartment `c` belongs to lobe `c // heads_per_lobe`.
- **Edges** (`FlyGraph.kc_pairs`, concatenated in KC order): for KC `k`, one glomerulus-to-KC edge for each glomerulus in `mask[k]` (ascending id), then one KC-to-compartment edge for each of the `heads_per_lobe` compartments of its lobe.
- **A fire** (`attach`, `FlyGraph.fire_pairs`): all input and output edges of the active KCs, concatenated in ascending KC-index order by `attach`. A KC is active when its address code is positive (`code > 0`). `FlyAddress.forward` retains the top `top_k` values (94 in the current checkpoint) and zeroes the rest, so at most 94 KCs are active.
- **Counts** for `model/checkpoints/init.pt` with `heads_per_lobe` 5: groups 54 / 663 / 874 / 352 / 15, so 54 + 1889 + 15 = 1958 nodes. Edges are 9592 + 9445 = 19037. The 9445 is 1889 × 5. Pairs per fire equal the sum, over active KCs, of (glomerulus inputs + 5); live runs observed roughly 1100–1200 pairs. These counts come from `FlyGraph.__init__` and the current checkpoint, not the wire contract.
- Harnesses MUST derive layout from the mapping, never from these numbers.

## 7. Compatibility rules (migration policy)

**Additive. No version bump.**
- New optional fields on any object (mapping, group, node, fire) or a new top-level optional field (for example, a parallel edge array).
- New groups, different node or edge counts, different group names.
- New message `type`s.
- Harnesses MUST ignore unknown fields and unknown message types. The example harness counts unknown types under `ignored messages` and does not fail.

**Breaking. Bump `version` to 2.**
- Removing or renaming a field.
- Changing a field's type or meaning.
- Changing the shape of `edges` or `pairs` elements.
- Changing the meaning of `t`.
- Changing the node id convention (`0..N-1`) or the rule that a node's group is looked up by `id`.

**Version handling.**
- Each mapping carries its own `version`. `VizStream` does not check it and does not negotiate it. A connection can receive a version 1 mapping and then a version 2 mapping, because `set_mapping` can be called again on a live connection. Do not treat the version as fixed per connection.
- A harness MUST check `version` on every mapping. For an unsupported version it MUST refuse that mapping and ignore fires until a mapping it supports arrives.
- The counter-reset policy belongs to the harness. In the example (`onMapping`, `resetCounters`), an accepted v1 mapping zeroes `fires`, `invalidPairs`, `ignored`, `badFrames`, `lastT`, and `gaps`. A rejected mapping clears the graph (`nodes`/`edges` become 0 and `groups` becomes empty), shows the rejected `version`, and retains the step/fire/diagnostic counters. Invalid v1 mapping data also increments `badFrames`.
- Every accepted mapping replaces the client's graph and last-step baseline, including connect-time replays. A replay is NOT a new server epoch: `VizStream._handler` sends the current mapping without resetting `VizStream.t`. Clients cannot distinguish a replay from a fresh `set_mapping`, so MUST NOT require the first subsequent fire to have `t=0`.

**Harness robustness.**
- A harness MUST NOT throw out of its message handler. A non-JSON frame, or a JSON value that is not an object, is counted and skipped.
- A harness SHOULD check each fire pair against its declared edge set and skip pairs that are not declared.
- The example counts malformed supported mappings as `badFrames`, clears its graph, and waits for a usable mapping. It skips fires with a missing/negative/non-integer `t` or a non-array `pairs` field, also counting them as `badFrames` (`buildMapping`, `onMapping`, `onFire`). These diagnostics are example behavior, not server-side validation.

## 8. Model-side contract (changing `model/` without touching `model/serve/`)

### 8.1 What `model/serve/` depends on (frozen)

- `model.model.load_checkpoint(path, device)` returns `(model, wiring, ck)`. `ck` is a dict. `model.serve.serve.main` reads `ck.get("note", "")` and `wiring.mask.shape`.
- `model.stream(prompt_ids, max_new_tokens, temperature, top_k, stop_ids=..., gen=...)` yields int token ids. `model.serve.ask.reply` and `model.serve.serve.Engine.run` iterate it. The HTTP handler closes the `Engine.run` generator to release its lock; it does not call `close()` directly on the model's iterator. `FlyLM.stream` currently is a generator decorated with `@torch.no_grad()`.
- `harness.viz_stream.stream_model(model, wiring, block, **server)` returns `(VizStream, FlyGraph)`. `model.serve.ask` passes `host`, `port`, `path`, and `record`. `model.serve.serve` passes `port` and `record`.
- Attributes read from the returned `VizStream`: `url`, `t`, `dropped`, `harnesses_seen`, `wait_for_harness(timeout)`, `close()`. From the returned `FlyGraph`: `mapping`; `model.serve.ask` reads `graph.mapping["nodes"]` and `graph.mapping["edges"]` for its startup line. `model.serve.serve` reads only the `VizStream`.
- Both entry points load `--ckpt` (default `model/checkpoints/init.pt`). `load_checkpoint` constructs `Config(**ck["config"])` and strictly loads `ck["state_dict"]`. Parameter names/shapes and saved config must therefore match the running model, or the loader must migrate the checkpoint while preserving this public return contract.

### 8.2 What `harness/viz_stream.py` depends on (in `model/`)

- `model.cfg.heads_per_lobe` (`Config.heads_per_lobe`, default 5). `FlyGraph` uses it for the compartment count and the per-KC output edges.
- `model.blocks[block].addr`: a module whose forward output is the `(B, T, K)` address code. Positive means an active KC. `attach`'s hook reads batch element 0 and iterates `T`, firing one step per position. Because the hook is on the module's forward output, `Block.step` (one token at a time) fires once per token.
- `wiring.mask`: `(K, G)` bool.
- `wiring.kc_class`: `(K,)` long, values 0, 1, 2 meaning gamma, alphabeta, alphaprime_betaprime.
- Optional names, used only by §8.3(c): `wiring.glom_names` and `wiring.kc_ids`. Either may be `None`.

**Token timing.** `FlyLM.stream` runs one `step` per prompt token and feeds each yielded token back only when generation resumes for another token. The final yielded token is not fed back: a model stop token, token-limit completion, or a consumer stopping iteration can end generation. For `P` prompt tokens and `n ≥ 1` yielded tokens this gives `P + n - 1` steps. `Engine.run` truncates the prompt to its last `ctx` tokens. `ask.reply` excludes EOT from its printed generated-token count, whereas `Engine.run` counts it; use ask's printed `steps t=...` range to compare fires. The observed no-EOT reply `[4 prompt + 8 generated tokens; steps t=0..10]` produced 11 fires.

### 8.3 Migration checklist

The following are adapter changes in `harness/viz_stream.py` after the model itself changes; `model/serve/` stays unchanged. Keep the public loader and streaming contracts above. If parameter keys/shapes or `Config` fields change, migrate the checkpoint in `load_checkpoint` or recreate an untrained checkpoint with an updated `model.init_model`; its sanity checks also reference `blk.addr`. Preserve existing checkpoints rather than overwriting trained weights. None of the three wire-preserving scenarios below requires a version bump.

- **(a) Renaming or restructuring `addr`, or changing its output.** In `harness/viz_stream.py`, update `attach()` only: find the new module and normalize its hook output into active KC indices aligned with the rows of `wiring.mask`. Preserve one step per token, batch element 0, and the same active-KC meaning even if the tensor layout or activity encoding changes. No wire version bump if those semantics remain unchanged; changing token/step meaning is breaking (§7). `model/serve/` is not touched.
- **(b) Changing the lobe count or the meaning of `kc_class`.** In `harness/viz_stream.py`, update `GROUP_NAMES` and `FlyGraph.__init__`:
  1. Define the model's ordered lobe-class values explicitly (for example `(0, 1, 2, 3)` for four classes); map each value to its KC group and compartment offset.
  2. Allocate `len(lobe_classes) * heads_per_lobe` MBON nodes, place the MBON group after all KC groups instead of hard-coded group 4, and build each KC's output edges from its mapped lobe offset.
  3. Keep `FlyGraph(wiring, heads_per_lobe)` unchanged so `stream_model` and V2 need no new parameter. Current hard-codes are `3 * heads_per_lobe`, `1 + cls[k]`, group 4, and the `cls * heads_per_lobe` output range.
  4. Update graph-content expectations such as `test_mapping_shape`'s `G + K + 15` when the model changes. No wire version bump: group identities and counts are data. `model/serve/` is not touched.
- **(c) Adding node labels, for example glomerulus names from `wiring.glom_names`.** In `harness/viz_stream.py`, add optional `"name"` strings in `FlyGraph.__init__`: glomerulus `g` uses `wiring.glom_names[g]`, aligned with mask column `g`; KC `k` may use `str(wiring.kc_ids[k])`, aligned with mask row `k`. Omit a name when that optional source is `None`; never emit null. No plumbing change is needed because `FlyGraph` already receives `wiring`. This is additive: no version bump; the example ignores the extra fields. `model/serve/` is not touched.

### 8.4 Verification after any model change

Run V1 and V2 below after any change under `model/` or `harness/`. Prerequisites: repo root as working directory, installed project `.venv`, and a compatible `model/checkpoints/init.pt` (gitignored). Resolve checkpoint/config migration first (§8.3). To create an untrained checkpoint, use `model.init_model` with `--out` pointing to a new file; pass that file via V1's `--ckpt` and V2's `load_checkpoint` path rather than overwriting existing weights. Verification uses ports 8767, 8768, and 8770 only. The user's processes on 8765 and 8000 MUST NOT be touched. Stop services you start when finished.

**V1 (live end to end, in a browser).**
1. Terminal A, service: `.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example`
2. Terminal B, service (interactive): `.venv/bin/python -m model.serve.ask --port 8767 --max-tokens 8`
3. Open `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8767/stream` in Chromium. Expect status `connected`, node/edge counts equal to ask's startup counts, and legend counts summing to the node count. Current checkpoint baseline: 5 groups, 54 / 663 / 874 / 352 / 15, 1958 nodes, 19037 edges; changed graphs may legitimately differ. Expect `invalid pairs` 0 and `gaps` 0. `window.harnessState` exposes these values.
4. In terminal B, type `Once upon a time` and press Enter. ask prints `[4 prompt + N generated tokens; steps t=0..M]`. Expect `fires received` = M + 1, `last t` = M, `invalid pairs` 0, `gaps` 0. The observed no-EOT 8-token reply gave 11 fires. The panel lists type pairs such as `Glomerulus -> KC_gamma`. Take a screenshot: one column per mapping group (5 today) and lit edges.
5. In terminal B, type a second message and press Enter. ask prints `steps t=M+1..` for the new reply, so `t` continues from M + 1 with no reset. Expect `fires received` to grow by the number of steps that message printed.
6. In terminal B, press Ctrl-D. ask exits, the page shows `disconnected`, and it keeps retrying once per second.
7. In terminal B, rerun step 2. The page reconnects without a reload and shows the mapping again. Counters reset: `fires received` is 0 and `last t` is `-` until the next fire.

**V2 (version guard and forward compatibility).** Keep the page from V1 open, but change its URL to `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream`. Then run the throwaway script below from the repo root. The script exits by itself.

```bash
cat > /tmp/v2_stream.py <<'EOF'
import copy, json, sys, time
sys.path.insert(0, ".")
from harness.viz_stream import FlyGraph, VizStream
from model.model import load_checkpoint
model, wiring, _ = load_checkpoint("model/checkpoints/init.pt")
g = FlyGraph(wiring, model.cfg.heads_per_lobe)
m = copy.deepcopy(g.mapping); m["extra"] = "ignored"
for n in m["nodes"]: n["name"] = f"n{n['id']}"
s = VizStream(port=8768); s.set_mapping(m); s.start()
assert s.wait_for_harness(30), "page never connected"
for _ in range(3): s.fire(g.fire_pairs([0, 1, 2])); time.sleep(0.3)
s._call(s._broadcast_fire, json.dumps({"type": "hello"}))       # unknown message type
time.sleep(0.5)
m2 = copy.deepcopy(g.mapping); m2["version"] = 2; s.set_mapping(m2)
time.sleep(0.5); s.fire(g.fire_pairs([0])); time.sleep(1); s.close()
EOF
.venv/bin/python /tmp/v2_stream.py
rm -f /tmp/v2_stream.py
```

Expect, read from `window.harnessState` and a screenshot:
- Before the v2 mapping: the mapping is accepted with the same graph counts as V1 (1958 nodes today), `fires received` is 3, `invalid pairs` is 0, and `ignored messages` is 1 (from `hello`). The extra top-level field and per-node `name` are accepted. If the wiring has fewer than three KCs, use existing KC indices in the script.
- After the v2 mapping: the banner reads `unsupported mapping version 2`; `version` is 2, `nodes`/`edges` are 0, and `groups` is empty. The fourth fire is ignored: `fires` stays at 3, `ignored` stays at 1, and diagnostic counters are retained.

## 9. Recording format

- `--record FILE` (on `model.serve.ask` and `model.serve.serve`, or the `record` argument of `VizStream`) writes NDJSON: one JSON message per line, in emission order.
- The first line is the mapping. Each later `set_mapping` call adds another mapping line, so a recording can hold several mappings.
- Every fire actually emitted is recorded (not the skipped steps). Recording counts as a listener, so fires are recorded even when no harness is connected.
- Each recording line, excluding its newline terminator, is the exact JSON string sent to a harness (`VizStream._record`, `VizStream.fire`, `VizStream.set_mapping`). It matches the decoded WebSocket text message, not protocol headers or potentially compressed wire-frame bytes. A recording was verified against received text messages line for line. A slow client can receive fewer fires than the recording because recording precedes per-client queue drops.
- Viewer: `.venv/bin/python -m harness.watch_stream FILE` (§10).

## 10. Tools

- **Viewer (terminal, not a harness).** `.venv/bin/python -m harness.watch_stream [ws-url|file] [--brief]`. Default source `ws://127.0.0.1:8765/stream`, so pass an explicit URL for the test ports. `--brief` skips the per-node list.
- **Example harness (browser).** Serve `harness/example` on a loopback port and open the page with its stream URL: `.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example`, then `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8767/stream`. Use §8.4 for the exact checks.
- **Model side (the stream source).** `.venv/bin/python -m model.serve.ask --port 8767 --max-tokens 8` (terminal chat) or `.venv/bin/python -m model.serve.serve --viz-port 8767 --port 8771` (HTTP API). Run one source at a time. For tests, do not use 8765 or 8000.
- **Recording and replay (no harness needed).** After V2 exits, port 8768 is free; this command can run while V1's source still holds 8767. `--record` writes the stream; the positional prompt sends one message and closed stdin (`</dev/null`) ends the session:

```bash
.venv/bin/python -m model.serve.ask --port 8768 --max-tokens 8 --record /tmp/fly-brain-demo.ndjson "Once upon a time" </dev/null
.venv/bin/python -m harness.watch_stream /tmp/fly-brain-demo.ndjson --brief
rm -f /tmp/fly-brain-demo.ndjson
```

- **Live viewer on 8767** (run while V1's terminal B service or §10's HTTP source is up). `timeout` ends it after 10 seconds with exit status 124; if the model closes first it exits normally:

```bash
timeout 10 .venv/bin/python -m harness.watch_stream ws://127.0.0.1:8767/stream --brief
```

- Verification commands: §8.4.

### Fixed-prompt replay for harness development

`harness.replay_prompt` serves a bundled recording of the real model processing
**`Once upon a time`**. It needs Python and `websockets`, but does not import the
model, load a checkpoint, or require PyTorch. The capture is
`harness/example/once_upon_a_time.ndjson`: one v1 mapping and 11 fires, `t=0..10`,
with the current 1958-node, 19037-edge graph. This is real captured activity,
not randomly generated or mocked pairs.

Run the replay server:

```bash
.venv/bin/python -m harness.replay_prompt
```

If the browser page is not already being served, start it in another terminal:

```bash
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream. Keep the replay command
running; no interactive prompts are needed. Ctrl-C stops it.

Playback behavior (`harness.replay_prompt.replay` and `run`):
- Loopback WebSocket server, default port 8768, exact path `/stream`.
- Each connection gets its own playback starting with the mapping, then every
  recorded fire. Late joiners and reconnects start at the beginning, not at
  another client's current position.
- Default timing is 0.2 seconds before each fire and a 2-second pause after the
  recording. The entire recording then repeats, starting with a new mapping;
  the example harness resets its counters each loop.
- JSON message text is sent unchanged, excluding NDJSON newline terminators.
  Playback preserves the recorded `t` values and pairs; timing is synthetic,
  not the original inference latency. It is not a live model or a slow-client
  drop simulator.
- `--port`, `--interval`, and `--pause` change the listening port and cadence.
  An optional positional path selects another NDJSON recording.

Capture provenance: block 0, CPU, `model/checkpoints/init.pt`, 8 generated tokens,
temperature 0 (greedy), top-k 50, seed 0. The prompt has 4 tokens; the final
generated token is not fed back, giving 11 model steps. The continuation was
` time Integrated Integrated Integrated Integrated Integrated Integrated Integrated`.
The checkpoint SHA-256 was
`7a7f402e0a05cc169b780209582de4d6fef923e9b55ac4b5b01bd08f0d241df5`.
The bundled capture fixes the payloads even if a developer's model or checkpoint
later changes; rerunning generation is not a cross-checkpoint reproducibility
guarantee.

To capture a different prompt, keep the serving entry points unchanged and use
their existing recording support. This command uses an automatically assigned
stream port, so it does not compete with a running model or replay:

```bash
.venv/bin/python -m model.serve.ask "Once upon a time" --port 0 --max-tokens 8 --temperature 0 --top-k 50 --seed 0 --record /tmp/prompt.ndjson </dev/null
```

Change the quoted prompt as needed. Stop the default replay before starting this
alternate recording on the same port:

```bash
.venv/bin/python -m harness.replay_prompt /tmp/prompt.ndjson --interval 0.1 --pause 1
```

After stopping the replay, `/tmp/prompt.ndjson` can be deleted. The bundled
recording is a permanent development fixture; do not delete it.
