# Model edge-firing rule

This is the model-side meaning of v1 activity for issue #3. The wire format is
defined in [the protocol](protocol/v1/SPEC.md); [API.md](API.md) describes the
adapter and stable topology ids. For setup and the actual-model browser smoke,
use [WORKFLOW.md](WORKFLOW.md).

## A fire selects a KC path

`attach(model, stream, graph, block=0)` observes the selected block's
`FlyAddress.forward` output, `code` with shape `(batch, tokens, KCs)`. For each
token position, a KC is active exactly when `code[0, position, kc] > 0`.
Only batch element 0 is visualized. This rule is deterministic for fixed
address output; it adds no randomness and does not modify model calculations.

The address module computes a glomerular projection, masked KC drive,
centering, ReLU, top-k selection and normalization. The rule uses the final
address code, not the pre-selection drive. There can be fewer than `top_k`
active KCs when selected values are zero. Zero values do not produce activity.

| Declared connection | Firing rule | Meaning |
|---|---|---|
| Glomerulus (PN-side input) → KC_gamma | Destination KC's address code is positive | Input wiring of a selected gamma KC |
| Glomerulus → KC_alphabeta | Destination KC's address code is positive | Input wiring of a selected alpha/beta KC |
| Glomerulus → KC_alphaprime_betaprime | Destination KC's address code is positive | Input wiring of a selected alpha'/beta' KC |
| Any KC → each MBON compartment of that KC's lobe | Source KC's address code is positive | The selected KC participates in that lobe's memory read/write path |

Each active KC emits **all** its declared input and output edges. The graph
does not declare glomerulus-to-MBON or inter-KC edges. A glomerulus edge has no
additional activation or learned-weight threshold. A KC-to-MBON edge has no
additional dopamine, stored-memory, output-gate or update-magnitude threshold.
Consequently, a lit edge does not assert that its numerical contribution or
memory delta is nonzero. It identifies the sparse address-selected path.
V1 sends neither strengths nor weights, and never invents activity for visual
effect. Browser pulse duration and brightness are separate presentation policy.

## Stable ids and one message per token

`FlyGraph` snapshots the actual selected block. For `G` glomeruli and `K` KCs,
glomerulus column `g` has id `g`, KC mask row `k` has id `G + k`, and memory
compartment `c` has id `G + K + c`. A KC's output compartments are the heads of
its actual memory lobe. These are the same ids and edges exported by issue #15.

The positive-index CPU `nonzero()` traversal selects each KC once in ascending
row order. A boolean mask gives each KC distinct input edges, and disjoint lobe
membership gives it distinct output edges. Different KCs have different KC ids,
so their pairs cannot duplicate one another. `FlyGraph.fire_pairs` concatenates
these existing routes; the production hook supplies unique KC indices. Calling
that helper directly with repeated indices is outside this hook's guarantee.

All pairs for one token go to one `VizStream.fire` call. Its integer `t`
advances even for an empty active set or when nobody is observing. Empty steps
are omitted. Within one mapping epoch, delivered `t` values strictly increase;
bounded queues may drop complete fire messages and leave gaps. Reconnecting
does not reset server `t`. Publishing a replacement mapping resets it to zero;
refresh the graph and publish while inference is paused.

For whole-sequence `model.forward`, the hook emits positions in sequence order
when the selected block's address tensor is computed, before that block's
memory finishes. These are token positions, not wall-clock completion events.
For incremental `model.step`, that tensor has one position, so each call emits
one step. Generation includes prompt-token processing. With `P` prompt tokens
and `N >= 1` generated tokens, it processes `P + N - 1` positions: the final
generated token is yielded without feeding it back. Counters continue across
requests within the same epoch.

## Instrumentation cost

The model has no streaming dependency or implicit hook. Constructing and using
`FlyLM` alone does no visualization work. The HTTP CLI's existing `--no-viz`
branch avoids `stream_model` entirely. Both serving CLIs enable their adapter
by default; `ask` has no `--no-viz` flag. Direct callers opt in with `attach` or
`stream_model`; an `attach` handle's `.remove()` detaches it.

When attached but neither a client nor a healthy recorder is listening, the
hook reads the tensor shape and listener state and advances integer counters.
It does not inspect tensor values, call `nonzero()`/`.tolist()`, gather pairs,
serialize JSON, enqueue a fire, or synchronize CUDA for activity extraction.
The connected/recording path detaches the selected code before extracting
indices, returns `None` from the forward hook and retains no tensors or activity
history after the callback. It therefore leaves autograd and the model output intact.

Enabled extraction and JSON serialization run on the model thread. At the first
observed token in an address output, the hook computes
`(code[0].detach() > 0).cpu()` once. It uses CPU `nonzero()` and `.tolist()` for
each position after that. The local boolean mask exists only for that hook
invocation and has `T * K` bytes; it is never stored in the stream or recorder.

On CUDA, making that mask available on the CPU requires a host transfer and
can synchronize the device. The adapter avoids a separate CUDA `nonzero()`
and host index-list transfer at every token of a whole-sequence call. It adds
no explicit global `torch.cuda.synchronize()`. This trades transfer size for
fewer synchronization points: the default wiring uses 1,889 boolean bytes per
token, versus 752 bytes for 94 int64 KC indices, excluding intermediate results
and transfer overhead. Incremental inference still has one position per call.
No CUDA speed improvement is claimed without CUDA measurements. When idle or
detached, there is no activity-mask transfer. Topology tensor copies happen
only during graph construction or an explicit refresh. File and socket writes
use bounded background queues; slow consumers cause whole-message drops rather
than model-thread I/O waits.

The existing [stage measurements](PERFORMANCE.md#separate-stages) measure
CPU extraction and pair gathering separately; they exclude full inference,
training and GPU transfer. They must not be presented as total instrumentation
overhead or CUDA timings.

### Full inference measurement

[Profile output](activity-profile.json) records the full default untrained
model: 12 layers, width 384, the checked-in real wiring, 1,958 nodes and 19,037
edges. Each sample runs a batch-1, four-token `model.forward` under inference
mode with one CPU thread. There are five warmups and 30 measured samples per
mode. All modes use the same initialized model, seed 0 and token ids
`[7454, 2402, 257, 640]` (GPT-2's `Once upon a time`).

Measured on 2026-10-21 on Windows 11, AMD64 Family 25 Model 80 Stepping 0,
Python 3.12.10 and PyTorch 2.14.1+cpu:

| Mode | p50 / p95 per four-token forward (ms) | Observed median delta from disabled |
|---|---:|---:|
| Disabled | 105.3660 / 132.1423 | Baseline |
| Attached, idle | 112.6864 / 133.0689 | +6.95% |
| Recording | 113.5839 / 128.2543 | +7.80% |
| Live client | 112.8051 / 139.9657 | +7.06% |

Every measured mode produced bitwise-identical logits. Each attached mode
counted 140 token steps, including warmups. Network and recording drop counts
were zero; the recording contained its mapping plus 140 fires. Idle mode also
had a higher median in this run even though it extracts no tensor values.
Modes run serially, so scheduling and thermal variation are not isolated from
hook costs. Differences between enabled modes are small relative to the
observed latency spread; these deltas are not pure attributable hook overhead.
Positive as well as negative deltas can contain measurement noise.

Disabled means no hook or stream; idle means an attached hook and server with
no observer; recording means a healthy background NDJSON writer and no client;
live means one actual loopback WebSocket client. The timed region includes
full inference, extraction, pair gathering, serialization and publication.
Setup, mapping construction, output comparisons, socket receipt and final
writer draining are outside it; the writer/server threads run concurrently.
This measures four-token forward latency, not autoregressive tokens/second or
training overhead. Timings and percentage differences are observations on this
machine, not CI thresholds; negative overhead is measurement noise.

From the repository root with model dependencies installed:

```console
python -m harness.profile_activity --repeat 30 --warmup 5
```

On a CUDA-capable machine with CUDA PyTorch, add `--device cuda`. That profile
synchronizes at inference boundaries so asynchronous kernel launches are not
mistaken for completed inference. Its enabled timing includes the adapter's
host-mask transfer. A requested unavailable CUDA device fails explicitly rather
than silently substituting CPU measurements. This checkout's CPU-only PyTorch
cannot measure CUDA synchronization latency; CUDA overhead remains an explicit
measurement gap.

## Verification

Run the focused instrumentation tests together with the existing stream and
workflow tests listed in [test/README.md](../test/README.md). They check exact
active paths, unique declared integer pairs, empty steps, batch selection,
unchanged outputs/gradients, idle extraction avoidance and mapping epochs.
The real-model [workflow smoke](WORKFLOW.md#3-run-the-headless-smoke-command) additionally
checks live mapping-first delivery, reconnects, a topology refresh, recording
and identical greedy output after hook removal. Its checked-in reference and
browser replay provide a review path without loading PyTorch in the browser.

Browser verification on 2026-10-21 used the full untrained CPU model with a
custom `/firing` stream on the Windows/Radeon machine. The WebGPU viewer drew
1,958 nodes and 19,037 directed edges, with real glomerulus-to-KC and KC-to-MBON
highlights, mapping-epoch resets, zero rejected messages/undeclared pairs and
no GPU warnings or errors. Inference continued through Disconnect; reconnect
received a mapping with zero accepted fires before activity resumed.
