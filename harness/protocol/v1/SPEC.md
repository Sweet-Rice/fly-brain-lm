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
