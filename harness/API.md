# Fly Brain Visualization Stream API (v1)

Serving-side reference for the stream implemented in `harness/viz_stream.py` (`FlyGraph`, `VizStream`, `attach`, `stream_model`). Harness authors and model developers read this. The normative wire contract is [`protocol/v1/SPEC.md`](protocol/v1/SPEC.md). Where this document says MUST, SHOULD, or MAY, the keywords follow RFC 2119. Symbol names are the citation targets; line numbers are deliberately omitted.

## 1. Status & scope

- [`protocol/v1/SPEC.md`](protocol/v1/SPEC.md) is the source-controlled, normative Fly Brain Visualization Stream Specification v1.
- [`protocol/v1/`](protocol/v1/) also contains Draft 2020-12 JSON Schemas and valid/invalid conformance fixtures shared by independent Python and browser implementations.
- This document describes the current model-side implementation and adds operational guidance. If it conflicts with the normative specification, the specification wins and the implementation guide MUST be corrected.
- Values in §6 are informative and may change without a version bump.

## 2. Transport

- **Server.** `VizStream` runs a `websockets` server (`websockets.asyncio.server.serve`) on a background thread. It defaults to `host="127.0.0.1"`, `port=8765`, `path="/stream"`. The port and path are configurable.
- **Loopback is enforced.** `VizStream` rejects every host other than the literal IPv4 loopback address `127.0.0.1` before opening a recording or starting its server thread. `model.serve.ask --host` is retained for its frozen call contract but accepts only `127.0.0.1`; `model.serve.serve` exposes only `--viz-port`, so its stream also stays on loopback.
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
- **Several harnesses.** Each harness has its own queue (`queue_size`, default 64). A harness that falls behind has fires dropped (`VizStream._broadcast_payload`, counted in `VizStream.dropped`). It never blocks the model, and it never loses the mapping, because the mapping is queued only after that harness's backlog is discarded.
- **Extension messages.** `VizStream.send_event(event)` queues one extension message (integers and strings only) in order with the fires, without advancing `t`. The opt-in `harness.telemetry` adapter uses it for run and token telemetry, numbers messages with `VizStream.next_seq()` and sets `VizStream.status_factory` for `stream_status` markers ([SPEC](protocol/v1/SPEC.md#extension-messages-additive)). With markers on, `resync` and `epoch_reset` always follow their mapping, and a harness or recording that lost messages gets a `gap` marker immediately before the next message it accepts, queued only together with that message (an empty queue always has room for both, so this works with a queue size of 1). Without the adapter the stream sends only `mapping` and `fire`, exactly as before.

## 4. `mapping` message

| Field | Type | Rule |
|---|---|---|
| `type` | string | Always `"mapping"`. |
| `version` | integer | `1` for this document. Checked on every mapping (§7). |
| `groups` | array of `{id: int, name: string}` | `id` values are unique. `name` is a label. Array order is the suggested layout order, input side first. |
| `nodes` | array of `{id: int, group: int}` | Ids are unique and non-negative; the current producer emits `0..N-1` in ascending array order (`nodes[i].id == i`), but receivers MUST accept other unique ids. `group` MUST equal the `id` of an entry in `groups`. |
| `edges` | array of `[src: int, dst: int]` | Pairs are unique. Both are node ids. Direction is src to dst. |

- **A node's type** is the entry in `groups` whose `id` equals `node.group`. Look it up by id. Do not index the `groups` array by `group`: the current ids happen to be `0..4` in array order, which is not a rule.
- **A node's connections** are the edges where it is `src` (its outputs) or `dst` (its inputs).
- **Extensibility.** Groups and nodes are objects, so they can gain optional fields (§7). An edge is a two-element array, not an extensible object. Optional per-edge metadata MAY use a separate new field, leaving `edges` unchanged. Changing `edges` elements into objects or longer arrays is breaking (§7). Sources: `FlyGraph.__init__`, `VizStream.set_mapping`.

Example. This is the output of `FlyGraph(model)` for a `FlyLM` built from `Wiring.random(n_kc=3, n_glom=2, per_kc=1, class_counts=(1,1,1), seed=0)` with `heads_per_lobe=1`.

```json
{"type":"mapping","version":1,"groups":[{"id":0,"name":"Glomerulus"},{"id":1,"name":"KC_gamma"},{"id":2,"name":"KC_alphabeta"},{"id":3,"name":"KC_alphaprime_betaprime"},{"id":4,"name":"MBON"}],"nodes":[{"id":0,"group":0},{"id":1,"group":0},{"id":2,"group":1},{"id":3,"group":2},{"id":4,"group":3},{"id":5,"group":4},{"id":6,"group":4},{"id":7,"group":4}],"edges":[[0,2],[2,5],[1,3],[3,6],[1,4],[4,7]]}
```

Reading it: edge `[0,2]` is glomerulus 0 to KC node 2 (`KC_gamma`), and edge `[2,5]` is that KC to MBON compartment 5.

## 5. `fire` message

- **Format.** `{"type":"fire","t":<int>,"pairs":[[src,dst], ...]}`.
- **`t`** is an integer ≥ 0: the model step, one token through the visualized block (`attach` fires once per token of the block's address code). Within one server mapping epoch `t` strictly increases. Only `VizStream.set_mapping` resets it to 0; it keeps counting across messages, requests, and client reconnects. A client's first fire after receiving a mapping may have any `t` ≥ 0. A harness MUST drop a fire whose `t` is not greater than the previous accepted fire under the current mapping.
- **`pairs`** is an array of two-integer `[src,dst]` arrays, each a declared edge, with no duplicates within a message. `VizStream.fire` omits empty arrays. Uniqueness in the model stream comes from `attach` passing each active KC once (`nonzero()`); `FlyGraph.fire_pairs` concatenates their distinct edges but does not deduplicate repeated input KC indices.
- **Gaps.** A step produces no fire when its pairs are empty (the server omits it), when nothing is listening (no harness and no recording; the server counts the step and skips it), or when a harness's queue is full (dropped). A harness cannot tell these apart. A gap means only that some steps were not delivered. A harness MUST NOT assume a fire for every `t`.
- **Order.** Each harness's fires arrive in `t` order (one FIFO queue per harness).
- **Within a fire,** the order of `pairs` carries no meaning.

The exact model-side rule, including what input/output edges mean, token timing,
opt-in attachment and GPU synchronization, is documented in
[`ACTIVITY.md`](ACTIVITY.md). A v1 fire indicates a selected KC path; it does
not report a measured edge current, activation strength, or memory update size.

## 6. Current v1 graph content (informative; may change without a version bump)

- **Groups** (`GROUP_NAMES`): 0 Glomerulus, 1 KC_gamma, 2 KC_alphabeta, 3 KC_alphaprime_betaprime, 4 MBON.
- **Nodes** (`FlyGraph.refresh`):
  - glomeruli: ids `0..G-1`, group 0;
  - KCs: ids `G..G+K-1` in the row order of the selected block's `kc_topology(block)` mask, group `1 + lobe[k]`, where lobe membership comes from the `lobes` that `kc_topology(block)` returns;
  - MBON compartments: ids `G+K..G+K+3·heads_per_lobe-1`, group 4. Compartment `c` belongs to lobe `c // heads_per_lobe`; the head count is `model.heads_per_lobe`.
- **Edges** (`FlyGraph.kc_pairs`, concatenated in KC row order): for KC `k`, one glomerulus-to-KC edge for each true entry of `mask[k]` (ascending glomerulus id), then one KC-to-compartment edge for each head of its lobe (ascending compartment id). Learned strength values do not add or remove declared edges.
- **A fire** (`attach`, `FlyGraph.fire_pairs`): all input and output edges of the active KCs, concatenated in ascending KC-index order by `attach`. A KC is active when its address code is positive (`code > 0`). Both built-in implementations retain at most `top_k` positive KCs (94 in their default configurations) and zero the remaining address values. Their address calculations differ; the shared firing rule depends only on the final positive code.
- **Connection classes.** A declared glomerulus-to-KC edge fires exactly when its destination KC is active; a declared KC-to-MBON edge fires exactly when its source KC is active. This applies to all three KC lobes. No separate glomerulus threshold, learned-weight threshold, memory-value threshold or animation-driven selection is applied.
- **Counts** for `model/checkpoints/init.pt` with `heads_per_lobe` 5: groups 54 / 663 / 874 / 352 / 15, so 54 + 1889 + 15 = 1958 nodes. Edges are 9592 + 9445 = 19037. The 9445 is 1889 × 5. Pairs per fire equal the sum, over active KCs, of (glomerulus inputs + 5); live runs observed roughly 1100–1200 pairs. These counts come from `FlyGraph.__init__` and the current checkpoint, not the wire contract.
- Harnesses MUST derive layout from the mapping, never from these numbers.

### 6.1 Exporting and replacing model topology

`FlyGraph(model, block=0)` reads the actual selected block, not a separate `Wiring` object. It copies topology tensors to CPU only during construction or an explicit refresh. It does not start a WebSocket server, run inference, import browser code, or send weights/coordinates.

The exporter rejects non-boolean or incorrectly shaped `kc_topology` masks, invalid head counts, and lobe indices that repeat, are out of range, or leave a KC unassigned. The implementation's `kc_topology` rejects incompatible address dimensions. A boolean mask and disjoint lobe membership generate each directed edge exactly once. Empty lobes remain declared groups.

For unchanged visualized topology, repeated exports have identical group/node/edge order, including after a checkpoint round trip or changes to learned weights. Node ids are positional; a topology with different dimensions may assign different ids and therefore needs a complete replacement mapping.

After changing topology or loading state into the same model, pause inference and publish the regenerated snapshot before processing the next token:

```python
stream.set_mapping(graph.refresh())
```

`refresh()` replaces both `mapping` and the KC routing table used by an existing `attach` hook. Invalid topology raises `ValueError` without replacing the previous snapshot. Refresh and publication belong on the model-owning thread while inference is paused; topology is not polled in the token hot path. Replacing module/model objects also requires removing the old hook and attaching to the new model.

To export a checkpoint without opening a server, use [`harness.export_mapping`](README.md#export-a-checkpoint-mapping):

```bash
.venv/bin/python -m harness.export_mapping --ckpt /tmp/fly-brain-init.pt --block 0 --out /tmp/fly-brain-mapping.ndjson
```

The output is a one-line mapping-only recording. Choose a scratch output path; an existing file is overwritten. CI validates this export against `protocol/v1/mapping.schema.json` and compares it with the first mapping recorded by real model inference.


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
- Allowing negative or repeated node ids, or changing the rule that a node's group is looked up by group `id`.

**Version handling.**
- Each mapping carries its own `version`. `VizStream` does not check or negotiate it because the receiver owns version enforcement.
- A harness MUST check every mapping. For an unsupported version, a live harness MUST emit protocol close result 1003 and close its connection. Browser adapters send wire code 4001 because JavaScript cannot send 1003; see [SPEC §6.1](protocol/v1/SPEC.md#61-browser-close-code-adaptation). Recording playback MUST stop with an unsupported-data result.
- The current Canvas example predates the full state machine in `app/`: it clears the graph and displays an unsupported-version banner instead of closing. This is a documented demo limitation, not conforming receiver behavior; the v1 fixtures require the logical 1003 close result.
- Every accepted mapping replaces the client's graph and last-step baseline, including connect-time replays. A replay is NOT a new server epoch: `VizStream._handler` sends the current mapping without resetting `VizStream.t`. Clients cannot distinguish a replay from a fresh `set_mapping`, so MUST NOT require the first subsequent fire to have `t=0`.

**Harness robustness.**
- A harness MUST NOT throw out of its message handler. A non-JSON frame, or a JSON value that is not an object, is counted and skipped.
- A harness SHOULD check each fire pair against its declared edge set and skip pairs that are not declared.
- The example counts malformed supported mappings as `badFrames`, clears its graph, and waits for a usable mapping. It skips fires with a missing/negative/non-integer `t` or a non-array `pairs` field, also counting them as `badFrames` (`buildMapping`, `onMapping`, `onFire`). A stale or repeated valid integer `t` drops the whole fire without changing counters. These diagnostics are example behavior, not server-side validation.

## 8. Model-side contract (changing `model/` without touching `model/serve/`)

**Layout and selection.** `model/model.py` is the public facade and registry (`IMPLEMENTATIONS` maps each name to an importable package; moving a package means editing one string there). `model/wiring.py` holds `Wiring`, shared by every implementation, this harness, and `data/build_wiring.py`. `model/vibe/` is the existing model; `model/vibe2/` is the fly-dopamine port with a trained-weight importer (its imported checkpoints carry 55 glomeruli, so their graph has 1959 nodes); `model/personal/` is the template for a new one. Build selection is `--impl` for `model.init_model`, `harness.workflow` and `harness.profile_activity`, else `FLYBRAIN_IMPL`, else `vibe`. Each checkpoint records its implementation in `"impl"`. Every implementation package exports `NOTE`, `build`, `export_config`, and `sanity_checks`, and its model provides the serving contract in §8.1–8.2 (`stream`, `heads_per_lobe`, `kc_code_module(block)`, `kc_topology(block)`). Missing members fail at build and at load. Fresh `vibe` and `vibe2` builds use the same bundled 54-glomerulus wiring; importing an external checkpoint is a separate path. No private trained checkpoint is bundled or verified by this integration. The full contract is in [model/README.md](../model/README.md#model-contract).

### 8.1 What `model/serve/` depends on (frozen)

- `model.model.load_checkpoint(path, device)` returns `(model, wiring, ck)`. `ck` is a dict. `model.serve.serve.main` reads `ck.get("note", "")` and `wiring.mask.shape`.
- `model.stream(prompt_ids, max_new_tokens, temperature, top_k, stop_ids=..., gen=...)` yields int token ids. `model.serve.ask.reply` and `model.serve.serve.Engine.run` iterate it. The HTTP handler closes the `Engine.run` generator to release its lock; it does not call `close()` directly on the model's iterator. `FlyLM.stream` currently is a generator decorated with `@torch.no_grad()`.
- `harness.viz_stream.stream_model(model, wiring, block, **server)` returns `(VizStream, FlyGraph)`. `model.serve.ask` passes `host`, `port`, `path`, and `record`. `model.serve.serve` passes `port` and `record`. The `wiring` parameter remains part of that frozen call contract, but topology is exported from the selected live model block.
- Attributes read from the returned `VizStream`: `url`, `t`, `dropped`, `harnesses_seen`, `wait_for_harness(timeout)`, `close()`. From the returned `FlyGraph`: `mapping`; `model.serve.ask` reads `graph.mapping["nodes"]` and `graph.mapping["edges"]` for its startup line. `model.serve.serve` reads only the `VizStream`.
- Both entry points load `--ckpt` (default `model/checkpoints/init.pt`, a legacy vibe checkpoint without `"impl"`). `load_checkpoint` reads `ck["impl"]` (a missing key means `vibe`), builds that implementation from `ck["config"]` via its `build()`, and strictly loads `ck["state_dict"]`. The checkpoint selects its implementation; `FLYBRAIN_IMPL` and `init_model --impl` affect builds only. Parameter names/shapes and saved config must therefore match the running implementation, or the implementation package must migrate the checkpoint while preserving this public return contract.

### 8.2 What `harness/viz_stream.py` depends on (in `model/`)

- `model.heads_per_lobe` (an `int > 0`; the vibe implementation returns `Config.heads_per_lobe`, default 5). `FlyGraph` uses it for the compartment count and the per-KC output edges.
- `model.kc_code_module(block)`: a module whose forward output is the `(B, T, K)` address code. Positive means an active KC. `attach`'s hook reads batch element 0 and iterates `T`, firing one step per position. A whole-sequence forward may expose several positions at once; incremental generation exposes one new position at a time. Each processed token must appear once, without replaying earlier context positions.
- `model.kc_topology(block)` returns `(mask, lobes)`, read live from the model so in-place edits are seen on `FlyGraph.refresh()`. `mask` is `(K, G)` bool, rows aligned with the last axis of `kc_code_module(block)`'s output and columns as glomeruli. `lobes` is a tuple of three one-dimensional integer tensors forming a disjoint partition of `range(K)` (lobe 0 gamma, 1 alphabeta, 2 alphaprime_betaprime). It raises `IndexError` for a block that does not exist.
- Optional names, used only by §8.3(c): `wiring.glom_names` and `wiring.kc_ids`. Either may be `None`.

**Token timing.** Both built-in implementations' `stream` methods run one `step` per prompt token and feed each yielded token back only when generation resumes for another token. The final yielded token is not fed back: a model stop token, token-limit completion, or a consumer stopping iteration can end generation. For `P` prompt tokens and `n ≥ 1` yielded tokens this gives `P + n - 1` steps. `Engine.run` truncates the prompt to its last `ctx` tokens. `ask.reply` excludes EOT from its printed generated-token count, whereas `Engine.run` counts it; use ask's printed `steps t=...` range to compare fires. The observed no-EOT reply `[4 prompt + 8 generated tokens; steps t=0..10]` produced 11 fires.

**Attachment and cost.** The model contains no streaming calls. Call `attach`
explicitly, or use the existing opt-in `stream_model` adapter; HTTP serving's
`--no-viz` bypasses that adapter. Removing the returned `attach` handle removes
the hook. An attached hook with no healthy recorder or connected harness only
advances the step counter: it skips tensor extraction, pair gathering and JSON.
An observed hook detaches the address code before converting positive indices
to Python integers, returns no replacement tensor and retains no activation
history. It copies one detached boolean activity mask to the CPU per observed
address output, then extracts integer indices on the CPU. On CUDA, this host
transfer can synchronize the model thread; bounded background socket/file I/O
does not remove that cost. Unobserved outputs perform no activity tensor copy.
See [activity overhead and its measurement limits](ACTIVITY.md#instrumentation-cost).

### 8.3 Migration checklist

The following are adapter changes in `harness/viz_stream.py` (and, for the model side, in the implementation package) after the model itself changes; `model/serve/` stays unchanged. Keep the public loader and streaming contracts above. If parameter keys/shapes or `Config` fields change, migrate the checkpoint inside the implementation package (`model/<impl>/`; `load_checkpoint` only dispatches on `"impl"`) or recreate an untrained checkpoint with `model.init_model --impl <impl>`; the vibe sanity checks in `model/vibe/__init__.py` reference `blocks[0].addr`. Preserve existing checkpoints rather than overwriting trained weights. None of the three wire-preserving scenarios below requires a version bump.

- **(a) Renaming or restructuring `addr`, or changing its output.** Make `kc_code_module(block)` and `kc_topology(block)` return the new module's address code and topology, so `attach()` and `FlyGraph.refresh()` need no change. If that output needs normalizing, change `attach()` only: normalize its hook output into active KC indices aligned with the rows of `kc_topology(block)`'s mask. Preserve one step per token, batch element 0, and the same active-KC meaning even if the tensor layout or activity encoding changes. No wire version bump if those semantics remain unchanged; changing token/step meaning is breaking (§7). `model/serve/` is not touched.
- **(b) Changing the lobe count or the meaning of `kc_class`.** In `harness/viz_stream.py`, update `GROUP_NAMES` and `FlyGraph.refresh()` together: read the model's ordered lobes from `kc_topology(block)`, validate a disjoint KC partition, and allocate each lobe's compartments. Place the MBON group after all KC groups instead of hard-coded group 4, and build each KC's output edges from its lobe's compartment offset. Keep `FlyGraph(model, block)` and the frozen `stream_model` contract unchanged. Update graph-content expectations such as `test_mapping_shape`'s `G + K + 15` when the model changes. Group counts and topology are data, so this alone does not require a wire-version bump. `model/serve/` is not touched.
- **(c) Adding node labels, for example glomerulus names from `wiring.glom_names`.** `FlyGraph` receives the model, not the wiring, so pass labels through model-aligned metadata with a documented row/column order: glomerulus `g` aligned with mask column `g`, KC `k` aligned with mask row `k`. Add optional `"name"` strings in `FlyGraph.refresh()`. Emit strings and omit unavailable labels rather than sending null. This is additive: no version bump; the example ignores the extra fields. `model/serve/` is not touched.

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

**V2 (current example's version guard; not close-code conformance).** Keep the page from V1 open, but change its URL to `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream`. Then run the throwaway script below from the repo root. The script exits by itself.

```bash
cat > /tmp/v2_stream.py <<'EOF'
import copy, json, sys, time
sys.path.insert(0, ".")
from harness.viz_stream import FlyGraph, VizStream
from model.model import load_checkpoint
model, wiring, _ = load_checkpoint("model/checkpoints/init.pt")
g = FlyGraph(model)
m = copy.deepcopy(g.mapping); m["extra"] = "ignored"
for n in m["nodes"]: n["name"] = f"n{n['id']}"
s = VizStream(port=8768); s.set_mapping(m); s.start()
assert s.wait_for_harness(30), "page never connected"
for _ in range(3): s.fire(g.fire_pairs([0, 1, 2])); time.sleep(0.3)
s.send_event({"type": "hello"})                                  # unknown message type
time.sleep(0.5)
m2 = copy.deepcopy(g.mapping); m2["version"] = 2; s.set_mapping(m2)
time.sleep(0.5); s.fire(g.fire_pairs([0])); time.sleep(1); s.close()
EOF
.venv/bin/python /tmp/v2_stream.py
rm -f /tmp/v2_stream.py
```

Expect, read from `window.harnessState` and a screenshot:
- Before the v2 mapping: the mapping is accepted with the same graph counts as V1 (1958 nodes today), `fires received` is 3, `invalid pairs` is 0, and `ignored messages` is 1 (from `hello`). The extra top-level field and per-node `name` are accepted. If the wiring has fewer than three KCs, use existing KC indices in the script.
- After the v2 mapping, the current Canvas example shows `unsupported mapping version 2`, clears its graph, and ignores the fourth fire. That demonstrates refusal but not the normative close behavior. The [standalone harness](app/README.md) emits logical close result 1003 and sends browser wire code 4001, as specified in SPEC §6.1; `protocol/v1/fixtures/invalid-cases.json` checks the logical result.

## 9. Recording format

- `--record FILE` (on `model.serve.ask` and `model.serve.serve`, or the `record` argument of `VizStream`) writes NDJSON: one JSON message per line, in emission order.
- File opening and writes run on a dedicated background thread. The model thread uses only non-blocking operations on a bounded queue (`record_queue_size`, default 256).
- The first retained line is a mapping. Each later `set_mapping` call adds another mapping line and starts a new `t` epoch. If the recording queue is full, a replacement mapping supersedes queued fires from the old epoch so the file stays usable.
- A full recording queue drops complete fire messages and leaves allowed gaps in `t`; `VizStream.recording_dropped` counts them. Recording counts as a listener while its writer is healthy, so it works with no harness connected.
- The producer-to-server handoff is also bounded by `queue_size` (default 64), with one scheduled drain callback. A stalled event loop drops new fires rather than accumulating callbacks. Each client has its own queue of the same capacity; `dropped` includes client deliveries lost at either stage. Replacement mappings supersede stale queued fires. `queue_size` must be a positive integer.
- Each retained line, excluding its newline terminator, is the exact JSON string offered to a harness (`VizStream._record`, `VizStream.fire`, `VizStream.set_mapping`). A normal-speed recording was verified against received text messages line for line; either a slow harness or a slow recorder may independently lose fires.
- File open/write failures emit a `RuntimeWarning`, appear in `VizStream.recording_error`, disable that recorder, and do not stop model execution. Normal shutdown drains and closes the writer; a drain timeout is also reported without hanging the model.

See [measured stress limits and reproduction commands](PERFORMANCE.md), including
the standalone browser's hidden-tab disconnection policy and the limits of v1
backpressure.
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
