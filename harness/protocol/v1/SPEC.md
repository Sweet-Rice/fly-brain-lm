# Fly Brain Visualization Stream Specification

Version 1 · October 2026

This document is the normative wire contract. The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Overview

The model streams two kinds of messages to a visualization harness:

1. a `mapping` describing the model structure; then
2. `fire` events naming the source-to-destination connections that fired at each step.

The harness generates its visualization from the mapping and animates connections from fire events. The stream is one-way, model to harness. All scalar values in version 1 messages are integers or strings; version 1 carries no floating-point, Boolean, or null values.

## 2. Terminology

| Term | Meaning |
|---|---|
| Model | The sender. Hosts the stream and emits all messages. |
| Harness | The receiver. Builds and animates the visualization. |
| Node | A unit in the model, identified by an integer id. |
| Group | A named set of nodes, such as PN, KC, or MBON, used for layout. |
| Edge | A directed connection from a source node to a destination node, declared in the mapping. |
| Fire pair | A `[src, dst]` pair whose declared connection fired at a step. |
| Step | The non-negative integer time index `t` of a fire event, for example one token. |
| Mapping epoch | The interval beginning with an accepted mapping and ending before the next accepted mapping or reconnect. |

## 3. Transport and connection lifecycle

The model and harness run on the same machine. The model hosts a WebSocket server bound to `127.0.0.1`; the browser harness connects as a client. The endpoint defaults to `ws://127.0.0.1:8765/stream` and MUST be configurable.

Each WebSocket text frame carries exactly one UTF-8 JSON message. Binary frames are outside version 1.

1. The harness opens a connection.
2. The model MUST send exactly one mapping as the first message.
3. The model then sends zero or more fire messages in increasing `t` order.
4. The model MAY send a new mapping at any time, such as after loading a checkpoint. An accepted mapping replaces the previous mapping and starts a new mapping epoch, so `t` ordering restarts.
5. Either side MAY close the connection.

On reconnect, the harness MUST discard all state from the previous connection. The model MUST begin the new connection with the current mapping. A harness connecting during a run receives the current mapping and subsequent live fire messages, not past steps.

### 3.1 Long-running operation

The stream MUST NOT slow the model:

- Sending MUST NOT block model execution.
- If a harness falls behind, the model drops complete fire messages for that harness. Gaps in `t` are valid.
- The model MUST run normally with no harness connected.
- The model MAY serve several harnesses concurrently.

### 3.2 Recordings

A recording is the stream stored as newline-delimited JSON (NDJSON), one complete message per line in transmission order. The harness SHOULD accept a recording in place of a live connection so it can be developed and tested without the model.

A submission SHOULD include a recording so evaluators can run the harness without training or loading the model.

## 4. `mapping` message

A mapping describes the complete visualization topology. The harness MUST be able to generate its visualization from this message alone.

```json
{"type":"mapping","version":1,"groups":[{"id":0,"name":"PN"},{"id":1,"name":"KC"}],"nodes":[{"id":0,"group":0},{"id":1,"group":1}],"edges":[[0,1]]}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `type` | string | yes | Always `"mapping"`. |
| `version` | integer | yes | Protocol version. This specification defines `1`. |
| `groups` | array of Group | yes | Node groups. Array order is the suggested layout order, input side first. |
| `nodes` | array of Node | yes | Every node in the visualized model. |
| `edges` | array of `[integer, integer]` | yes | Directed connections as `[src, dst]` node ids. |

A Group contains `id` (integer, at least zero) and `name` (string). A Node contains `id` (integer, at least zero) and `group` (the integer id of a declared Group).

Constraints:

- Group ids MUST be unique.
- Node ids MUST be unique.
- Node ids SHOULD be contiguous from zero so receivers can index nodes directly.
- Every node's `group` MUST name a declared group.
- Every edge source and destination MUST name declared nodes.
- Edges MUST NOT repeat.

A mapping is atomic. A receiver MUST validate the complete message before replacing its current visualization. An invalid mapping is dropped and does not replace a previously accepted mapping.

## 5. `fire` message

A fire message names the declared connections that fired at one step.

```json
{"type":"fire","t":40,"pairs":[[0,1],[1,2]]}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `type` | string | yes | Always `"fire"`. |
| `t` | integer | yes | Step index, at least zero. |
| `pairs` | array of `[integer, integer]` | yes | Connections that fired at step `t`, as `[src, dst]` node ids. |

Constraints:

- All pairs for a step MUST be sent in one message.
- `t` MUST strictly increase across accepted fire messages in one mapping epoch.
- Gaps are allowed. A step at which nothing fired MAY be omitted.
- Every pair MUST match an edge in the current mapping.
- A pair MUST NOT repeat within one message.

The order of pairs carries no meaning.

## 6. Receiver rules

A receiver never stops the stream because of recoverable bad data. It drops or ignores what it cannot use and continues with later frames. The only version 1 data error that closes a live connection is an unsupported mapping version.

| Condition | Required receiver action |
|---|---|
| Malformed JSON, a non-object JSON value, or a malformed known message | Drop the entire message. |
| Unknown `type` | Ignore the message. |
| Unknown field in a known message | Ignore the field. |
| `fire` before an accepted mapping | Drop the message. |
| Unsupported mapping `version` | Emit the protocol close result `1003` (unsupported data) and close a live connection; browser transport uses `4001` as explained below. Stop file playback with an unsupported-data result. |
| Mapping violates a mapping constraint | Drop the message and retain the prior mapping, if any. |
| `t` is not greater than the previous accepted `t` in this mapping epoch | Drop the message. |
| Fire message contains a malformed pair or a repeated pair | Drop the entire message. |
| Pair is well formed but is not a declared edge | Drop that pair and accept the rest of the message. |
| New valid mapping | Discard the current visualization, accept the new mapping, and reset `t` ordering. |
| Reconnect | Discard all prior state and wait for a new first mapping. |

Unknown fields are ignored for forward compatibility, but a version 1 producer still MUST emit only the scalar types allowed by this specification.

### 6.1 Browser close-code adaptation

The protocol receiver reports `{action: "close", code: 1003}` consistently with
the conformance fixtures. Where the transport permits it, send close code 1003.
The [browser WebSocket API](https://websockets.spec.whatwg.org/#dom-websocket-close)
only permits application code to send 1000 or a code in 3000–4999; attempting to
send 1003 throws instead of closing the connection. Browser harnesses MUST
therefore send **4001**, reason `Unsupported protocol version`, and stop automatic
reconnection until the user explicitly retries or chooses another source.
They MUST expose the logical 1003 unsupported-data result to their caller.
Recording sources stop on that same result without any WebSocket close call.
This transport adaptation does not change the mapping/fire schemas or fixture
action objects.

## 7. Topology changes

A fire message cannot create an implicit edge. If a connection is not in the current mapping, the receiver drops that pair. A producer that changes the visualized topology MUST send a complete replacement mapping before firing any new edge. The replacement begins a new mapping epoch.

This resolves the version 1 design question about undeclared fire pairs: they are not allowed.

## 8. Example stream

This complete session has two PNs, three KCs, and one MBON. Step 2 had no activity and is omitted.

```ndjson
{"type":"mapping","version":1,"groups":[{"id":0,"name":"PN"},{"id":1,"name":"KC"},{"id":2,"name":"MBON"}],"nodes":[{"id":0,"group":0},{"id":1,"group":0},{"id":2,"group":1},{"id":3,"group":1},{"id":4,"group":1},{"id":5,"group":2}],"edges":[[0,2],[0,3],[1,3],[1,4],[2,5],[3,5],[4,5]]}
{"type":"fire","t":0,"pairs":[[0,2],[0,3]]}
{"type":"fire","t":1,"pairs":[[2,5],[3,5],[1,4]]}
{"type":"fire","t":3,"pairs":[[4,5]]}
```

The checked-in conformance fixture [`fixtures/reference.ndjson`](fixtures/reference.ndjson) additionally covers a replacement mapping and restart of `t` ordering.

## 9. Versioning

This specification defines version 1. Adding an optional field does not change the version because receivers ignore unknown fields. Removing a field, changing a field's meaning or type, or changing the shape of an edge or pair requires a new version.

Every mapping carries its version. A receiver MUST check every mapping, including replacement mappings.

## 10. Out of scope for version 1

- Activation strength, weights, or any other floating-point value.
- Node positions or layout coordinates; the harness owns layout.
- Messages from the harness to the model.
- Binary encodings.
- Implicit topology inferred from fire events.

## Extension messages (additive)

The visualization stream optionally carries additive run and token telemetry messages from an opt-in producer (`python -m harness.telemetry.serve`, built on `harness/telemetry/adapter.py`), and with `--memory-telemetry` also KC–MBON memory messages (`harness/telemetry/memory.py`). Existing `mapping` and `fire` messages are unchanged and keep their byte-for-byte form; legacy v1 receivers ignore the unknown types per [§6](#6-receiver-rules). Extension messages are sent only after a mapping, so the mapping is still the first message of every connection and recording.

Scalar rules: extension messages carry integer and string scalars only; a producer MUST NOT emit floats, Booleans, or nulls. Nanosecond wall-clock timestamps (`*_ns`) exceed 2^53 − 1 and are decimal strings (`^[0-9]+$`). Relative latencies (`*_rel_us`) are non-negative integer microseconds since the request started. Server time (`server_time_ms`) is integer milliseconds (`time.time_ns() // 1_000_000`). Clocks of different machines and processes are not comparable, so consumers SHOULD correlate events by `seq`, `t`, and `request_id`, not by wall clocks.

### Common fields

All extension messages include the following envelope fields:

| Field | Type | Meaning |
|---|---|---|
| `run_id` | string | Unique run identifier (e.g. `run-<12 hex>`). |
| `seq` | integer | One per-run counter (≥ 0) shared by all extension types. Each consumer (every harness connection and the recording) receives strictly increasing `seq`. Values are not contiguous: the producer reserves the value just before every message it hands to consumers (including `fire`, which carries no `seq`) for a `gap` marker that may have to precede that message, so holes do not indicate loss; `gap` markers do. A harness never receives a message sequenced before its `resync`. |
| `epoch` | integer | Mapping epoch (≥ 0): `0` for the first mapping, +1 for each replacement mapping, which also restarts `t` at 0. Reconnecting does not change it. |

### `request_lifecycle`

Schema: [`request_lifecycle.schema.json`](request_lifecycle.schema.json)

Emitted as an inference request advances through lifecycle phases.

```json
{"type":"request_lifecycle","run_id":"run-0123456789ab","request_id":"req-0123456789ab","seq":0,"epoch":0,"impl":"vibe","model_id":"flybrain-untrained","ckpt_digest":"sha256:0123456789ab","phase":"queued","t_start":-1,"prompt_raw_tokens":12,"prompt_tokens":0,"max_tokens":32,"completion_tokens":0,"finish_reason":"none","server_time_ms":1729548000123,"timestamp_ns":"1729548000123456789"}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `"request_lifecycle"`. |
| `request_id` | string | Unique request identifier (`req-<12 hex>`). |
| `impl` | string | Model engine implementation (e.g. `"vibe"`, `"vibe2"`). |
| `model_id` | string | Loaded model identifier string. |
| `ckpt_digest` | string | Checkpoint SHA-256 digest prefix (`"sha256:"` + 12 hex digits). |
| `phase` | string | Enum: `queued`, `prefill`, `decode`, `completed`, `cancelled`, `failed`. Phase progression order: `queued` (before engine lock) → `prefill` (first prompt step) → `decode` (first completion token) → exactly one terminal phase (`completed`, `cancelled`, or `failed`). Cancelled/failed requests may skip prefill/decode. |
| `t_start` | integer | `t` of the first prompt token, or `-1` before prompt execution starts. |
| `prompt_raw_tokens` | integer | Total token count in raw prompt before context window truncation (`len(ENC.encode_ordinary(prompt))`). |
| `prompt_tokens` | integer | Prompt tokens accepted and stepped by the engine (`0` while `queued`). |
| `max_tokens` | integer | Maximum completion tokens allowed for this request. |
| `completion_tokens` | integer | Token ids the model has yielded so far, including a final EOT (one text piece of the SSE stream may cover several tokens). |
| `finish_reason` | string | Enum: `none` for non-terminal phases; `stop`, `length`, `cancelled`, or `error` for terminal phases. |
| `server_time_ms` | integer | Server timestamp in milliseconds (`time.time_ns() // 1_000_000`). |
| `timestamp_ns` | string | Decimal string of nanosecond timestamp (`time.time_ns()`). |

### `token_step`

Schema: [`token_step.schema.json`](token_step.schema.json)

Emitted for each prompt and completion token while the stream is actively listening (connected client or recording).

```json
{"type":"token_step","run_id":"run-0123456789ab","request_id":"req-0123456789ab","seq":1,"epoch":0,"kind":"prompt","token_index":0,"token_id":15496,"token_text":"Hello","token_bytes":"48656c6c6f","step_status":"stepped_fired","t":0,"step_rel_us":1200,"emit_rel_us":1200,"step_ns":"1729548000124656789","emit_ns":"1729548000124656789"}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `"token_step"`. |
| `request_id` | string | Associated request identifier. |
| `kind` | string | Enum: `prompt` or `completion`. |
| `token_index` | integer | Position within its kind (`prompt`: 0..P-1, `completion`: 0..N-1). |
| `token_id` | integer | Vocabulary token index (≥ 0). |
| `token_text` | string | Incremental UTF-8 decoded text (`""` while a multi-byte sequence is incomplete). |
| `token_bytes` | string | Lowercase hexadecimal string of raw token bytes. |
| `step_status` | string | Enum: `stepped_fired` (step produced positive KC activations matching a `fire` at `t`), `stepped_silent` (step executed with silent KC activations), or `unprocessed` (token sampled without subsequent step). |
| `t` | integer | Model step index matching `fire.t` within the same epoch, or `-1` if unprocessed. |
| `step_rel_us` | integer | Microseconds from request start to the hook of the step that processed the token (`0` if unprocessed). |
| `emit_rel_us` | integer | Microseconds from request start to when the model yielded the completion token to the engine (prompt tokens: equal to `step_rel_us`). |
| `step_ns` | string | Decimal nanosecond time of that step hook (`"0"` if unprocessed). |
| `emit_ns` | string | Decimal nanosecond time the model yielded the completion token (prompt tokens: equal to `step_ns`). |

Semantics:
- Prompt tokens are stepped with contiguous `t` starting at `t_start`; `emit_*` equals `step_*`.
- A completion token is sampled from the previous step and processed by the next one, so its `token_step` is sent when that next step runs (`stepped_fired` or `stepped_silent`, with that step's `t`).
- The final completion token (stop token, max tokens, EOT, or cancellation) is always `unprocessed` with `t: -1`, `step_rel_us: 0`, `step_ns: "0"` because the recurrent model samples it without executing a subsequent step.
- `unprocessed` is distinct from `stepped_silent` (which executed a forward step but had no KC firings).

### `stream_status`

Schema: [`stream_status.schema.json`](stream_status.schema.json)

Emitted to communicate delivery queue gaps, harness resynchronization, or topology epoch resets.

```json
{"type":"stream_status","run_id":"run-0123456789ab","epoch":0,"seq":0,"event":"resync","dropped_steps":0,"server_time_ms":1729548000123}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | string | Always `"stream_status"`. |
| `event` | string | Enum: `resync`, `epoch_reset`, `gap`. |
| `dropped_steps` | integer | Count of dropped messages (`fire` or extension) for this consumer (`0` for `resync` and `epoch_reset`). |
| `server_time_ms` | integer | Server timestamp in milliseconds. |

Semantics:
- `resync`: Sent to a newly connected harness immediately after its mapping frame (`dropped_steps: 0`), whatever the queue capacity. Reconnecting never resets server `t`.
- `epoch_reset`: Sent to all active consumers (harnesses and recording) immediately after a replacement mapping frame (`dropped_steps: 0`), whatever the queue capacity, signaling the incremented `epoch` and restart of `t` at 0.
- `gap`: Per consumer. `dropped_steps` counts the messages (`fire` or extension) that consumer lost since its previous gap marker, including queued messages a replacement mapping discarded. The marker comes first: it is queued immediately before the next message the consumer accepts, and only when the consumer's queue has room for both (an empty queue always has); otherwise that message is lost as well and counted in the same marker. Its `seq` is the value reserved for that message, so the consumer sees mapping, messages accepted before the loss, `gap`, then the resumed message, with strictly increasing `seq`.

The normative memory schemas are [`memory_summary.schema.json`](memory_summary.schema.json) and [`memory_slice.schema.json`](memory_slice.schema.json).

### `memory_summary` message

A `memory_summary` message reports recurrent memory norms, gating levels, and decay dynamics across all computational heads for a block at step `t`.

```json
{"type":"memory_summary","seq":12,"run_id":"run-4f8a12","request_id":"req-001","epoch":0,"t":5,"scale":10000,"block":0,"heads":3,"head_dim":4,"dtype":"float32","prev_rev":4,"rev":5,"dopamine_gate":[1200,4500,3100],"dopamine_cap":[9900,9900,9900],"recovery_half_life":[150000,120000,200000],"recovery_factor":[9548,9439,9659],"s_norm_before":[12340,8560,10420],"s_norm_after":[12850,8910,10790],"s_delta_norm":[1420,950,1120]}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `type` | string | yes | Always `"memory_summary"`. |
| `seq` | integer | yes | Strictly increasing sequence number within `run_id`. |
| `run_id` | string | yes | Generation run identifier. |
| `request_id` | string | yes | Generation request identifier. |
| `epoch` | integer | yes | Mapping epoch of the stream at emission time, as reported with the run's token telemetry. |
| `t` | integer | yes | Model step index at which this write happened; equals the `t` of the token telemetry for the same step and `request_id`. |
| `scale` | integer | yes | Fixed-point scale factor (real value = integer / `scale`). |
| `block` | integer | yes | Model layer/block index. |
| `heads` | integer | yes | Total number of computational heads ($H = 3 \times \text{heads\_per\_lobe}$). |
| `head_dim` | integer | yes | Feature dimension per head ($P$). |
| `dtype` | string | yes | Memory tensor data type without `"torch."` prefix (e.g. `"float32"`). |
| `prev_rev` | integer | yes | Revision number before this update. |
| `rev` | integer | yes | Revision number after this update (`prev_rev + 1`). |
| `dopamine_gate` | array of Quantized | yes | Dopamine gate $d_t$ actually used for the write, per head, after the ceiling (length `heads`). |
| `dopamine_cap` | array of Quantized | yes | Gate ceiling per head: `vibe` 0.99 for every head; `vibe2` 0.99 except the α/β heads, which use `ab_dopamine_max` (length `heads`). |
| `recovery_half_life` | array of Quantized | yes | Recovery half-life $h = 1 + e^{\psi}$ per head, in steps (length `heads`). |
| `recovery_factor` | array of Quantized | yes | Per-step keep factor $r = 2^{-1/h}$ per head (length `heads`). |
| `s_norm_before` | array of Quantized | yes | Frobenius norm of $S$ before update per head (length `heads`). |
| `s_norm_after` | array of Quantized | yes | Frobenius norm of $S$ after update per head (length `heads`). |
| `s_delta_norm` | array of Quantized | yes | Frobenius norm of net update $S_{\text{after}} - S_{\text{before}}$ per head (length `heads`). |

A Quantized value is an integer or one of the strings `"nan"`, `"inf"`, `"-inf"`, or `"missing"`.

Constraints:

- Real values MUST be quantized as `round(value * scale)` with half-to-even rounding; nonfinite floats MUST be encoded as `"nan"`, `"inf"`, or `"-inf"`; `"missing"` is reserved for masked positions.
- Emission MUST occur only during an active request at a valid stepped token index `t >= 0`, never when `t = -1`.
- `rev` MUST start at 1 on the first write of a request (`prev_rev = 0`), increment by 1 on each observed write, and reset when `request_id` changes. Memory state $S$ at `rev = 0` is the transient zero initial state, distinct from learned model parameters.
- Messages are emitted on writes satisfying `(rev - 1) % summary_stride == 0`.
- For the same step `t`, the `memory_summary` message MUST precede all `memory_slice` messages.
- A receiver MUST NOT difference values across a revision gap (where `prev_rev` does not equal the last `rev` processed for that request and block); the next received full value MUST establish a new baseline.
- Heads are computational heads ($3 \times \text{heads\_per\_lobe}$; lobe 0 $\gamma$, 1 $\alpha/\beta$, 2 $\alpha'/\beta'$), not anatomical MBON or DAN neurons.
- Model implementations declaring `kc_mbon_memory` unsupported (such as the personal template) MUST NOT emit memory messages and MUST NOT synthesize fake memory tensors.
- Vector lengths for all vector fields in `memory_summary` MUST equal `heads`.

### `memory_slice` message

A `memory_slice` message provides high-resolution memory inspection for an individual active Kenyon cell within one computational head at step `t`.

```json
{"type":"memory_slice","seq":13,"run_id":"run-4f8a12","request_id":"req-001","epoch":0,"t":5,"scale":10000,"block":0,"lobe":0,"kc_id":42,"head":0,"k_activation":8500,"prev_rev":4,"rev":5,"s_before":[1020,530,-210,840],"s_after":[1165,602,-177,898],"read_vector":[2150,-1400,3200,900],"delta_raw":[200,100,25,100],"delta_net":[145,72,33,58]}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `type` | string | yes | Always `"memory_slice"`. |
| `seq` | integer | yes | Strictly increasing sequence number within `run_id`. |
| `run_id` | string | yes | Generation run identifier. |
| `request_id` | string | yes | Generation request identifier. |
| `epoch` | integer | yes | Mapping epoch at emission time. |
| `t` | integer | yes | Step index of the current request token. |
| `scale` | integer | yes | Fixed-point scale factor (real value = integer / `scale`). |
| `block` | integer | yes | Model layer/block index. |
| `lobe` | integer | yes | KC lobe index (0: $\gamma$, 1: $\alpha/\beta$, 2: $\alpha'/\beta'$). |
| `kc_id` | integer | yes | Global Kenyon cell identifier. |
| `head` | integer | yes | Global computational head index. |
| `k_activation` | Quantized | yes | KC code value used for the write: `vibe` top-k code scaled into [0, 1]; `vibe2` code divided by its maximum. |
| `prev_rev` | integer | yes | Revision number before this update. |
| `rev` | integer | yes | Revision number after this update (`prev_rev + 1`). |
| `s_before` | array of Quantized | yes | KC row of $S$ before step (length `head_dim`). |
| `s_after` | array of Quantized | yes | KC row of $S$ after step (length `head_dim`). |
| `read_vector` | array of Quantized | yes | Associative readout $\mathbf{y}_{\text{read}}$ for this head before skip connection (length `head_dim`). |
| `delta_raw` | array of Quantized | yes | Raw gated write update before recovery (length `head_dim`). |
| `delta_net` | array of Quantized | yes | Net update row $S_{\text{after}} - S_{\text{before}}$ (length `head_dim`). |

Constraints:

- Real values MUST be quantized as `round(value * scale)` with half-to-even rounding; nonfinite floats MUST be encoded as `"nan"`, `"inf"`, or `"-inf"`; `"missing"` is reserved for masked positions.
- Emission MUST occur only during an active request at a valid stepped token index `t >= 0`, never when `t = -1`.
- For each write satisfying `(rev - 1) % slice_stride == 0`, slices MUST be emitted for up to `max_kc_slices` KCs with addressing activation $k > 0$, ranked by descending activation with ties broken by lower `kc_id`.
- For each selected KC, one `memory_slice` MUST be emitted per local computational head of that KC's lobe in head order.
- `read_vector` represents the associative readout $\mathbf{y}_{\text{read}}$ before any skip connection (such as the vibe2 $D \odot x$ skip); it is identical for every KC of that head at that `t`.
- `delta_raw` is the raw gated write $d \cdot k \cdot (x - S_{\text{before}})$ before recovery; `delta_net` is the actual net update $S_{\text{after}} - S_{\text{before}}$.
- `rev` MUST start at 1 on the first write (`prev_rev = 0`). A receiver MUST NOT difference values across a revision gap; the new slice establishes a new baseline.
- Memory state $S$ is transient per-request state (zero at request start), not learned parameters.
- Vector lengths for `s_before`, `s_after`, `read_vector`, `delta_raw`, and `delta_net` MUST equal `head_dim`.
- Model implementations declaring `kc_mbon_memory` unsupported MUST NOT emit memory messages.

### Memory tensor registry

Producer: `python -m harness.telemetry.serve --memory-telemetry [--memory-max-kc-slices N]` attaches `harness.telemetry.memory.MemoryTelemetry` to the memory of block `--block` (default 0) through `set_memory_observer`. An implementation without the `kc_mbon_memory` capability prints `memory telemetry: unsupported by <impl>` at startup and emits no memory message; run and token telemetry continue unchanged.

The observed model calls the collector once per memory write (one model step) with the detached tensors below. Notation: `B` batch (1 when served; messages report batch element 0), `hpl` = `heads_per_lobe` from the checkpoint config, `H = 3 × hpl`, `K` KCs of the block, `K_l` the KCs of lobe `l` (`kc_topology(block)[1][l]`), `P` = `head_dim`. Row `i` of lobe `l`'s state is global KC `kc_topology(block)[1][l][i]`; local head `j` of lobe `l` is global head `l × hpl + j`. The memory dtype (`dtype` in `memory_summary`) is `S[0].dtype`, created at request start as `promote_types(value-path parameter dtype, float32)`: the step casts the code, gate and values to it and computes in it with autocast disabled. Wire values are quantized from float64 copies.

| Tensor | Shape | Scope | Dtype source | Meaning | Wire fields |
|---|---|---|---|---|---|
| `S_before` | 3 × `(B, hpl, K_l, P)` | per request, per block; transient | memory dtype | Recurrent KC→MBON state of each lobe before this write. Zero at request start (`rev` 0). | `s_norm_before`, `s_before` |
| `S_after` | 3 × `(B, hpl, K_l, P)` | per request, per block; transient | memory dtype | State after write and recovery: $r \odot (S_{\text{before}} + \Delta_{\text{raw}})$. Becomes the next step's `S_before`. | `s_norm_after`, `s_after` |
| `y_read` | `(B, H, P)` | per step, per block | memory dtype | Associative readout of `S_before` (read happens before the write). `vibe`: $\sum_k k\,S / \max(\sum_k k, 10^{-6})$. `vibe2`: $\sum_k \frac{k}{\sum k + 10^{-6}} S$, before the $D \odot x$ skip. Output gating and projection come later and are not included. | `read_vector` |
| `delta_raw` | 3 × `(B, hpl, K_l, P)` | per step, per block | memory dtype | Gated write before recovery, $d \cdot k \cdot (v - S_{\text{before}})$. Here $v$ is the head value: in `vibe`, the causal-conv value; in `vibe2`, $x = \mathrm{silu}(\text{conv value})$. | `delta_raw` |
| `delta_net` | 3 × `(B, hpl, K_l, P)` | per step, per block | memory dtype | Net change $S_{\text{after}} - S_{\text{before}}$, recovery decay included. | `s_delta_norm`, `delta_net` |
| `d_t` | `(B, H)` | per step, per block | memory dtype | Dopamine gate the write used, ceiling applied. `vibe`: $0.99\,\sigma(W u)$. `vibe2`: $\mathrm{cap} \odot \sigma(W_d u + b_d)$. | `dopamine_gate` |
| `cap` | `(H,)` | per model, per block; constant | `vibe`: memory dtype; `vibe2`: the non-persistent `DopamineMixer.cap` buffer (module dtype) | Gate ceiling. `vibe`: 0.99 for every head. `vibe2`: 0.99, except α/β heads `hpl … 2·hpl − 1`, which use `ab_dopamine_max`. | `dopamine_cap` |
| `half_life` | `(H,)` | per model, per block; fixed during inference | memory dtype | Recovery half-life in steps, $h = 1 + e^{\psi}$, from the learned parameter `psi`. | `recovery_half_life` |
| `recovery` | `(H,)` | per model, per block; fixed during inference | memory dtype | Per-step keep factor $r = 2^{-1/h}$ (`vibe` `0.5 ** (1 / h)`, `vibe2` `exp(-ln 2 / h)`). | `recovery_factor` |
| `k_code` | `(B, K)` | per step, per block | memory dtype | KC code used for the read and the write, with columns aligned with the rows of `kc_topology(block)`'s mask. `vibe`: the top-k address code, already scaled into [0, 1] by its maximum. `vibe2`: the address code divided by (its maximum + 10⁻⁶). The raw, unnormalized `vibe2` code is not exported. | `kc_id` selection (`k > 0`), `k_activation` |

- MBON targets are computational heads, 3 lobes × `heads_per_lobe` (15 for `heads_per_lobe` 5). They are not anatomical MBON or DAN neurons or connectome body IDs. `d_t` is a learned per-head gate, not a spiking dopamine neuron.
- `S` is transient activation state. `model.stream` allocates it as zeros at request start, every block has its own copy, and it is discarded at the end of the request. It is never part of a checkpoint or `state_dict`. Learned parameters (`psi`, `D`, projection and address weights) and fixed buffers (connectome `mask`, lobe index buffers) are not memory state. A write changes only `S`, and memory messages never report parameter changes.
