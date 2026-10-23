# Live model workspace

A no-build browser app with three views: **Graph**, **Prompt**, and **Neuron**.
The normal entry point is `/app/`; the app server supplies its stream binding.
There are no Source or Settings screens, endpoint fields, file picker, playback
controls, generation parameter fields, API-key field, or placeholder panels.

## Run the live workspace (real model + app server)

Run from the repository root. Install the model dependencies using the
[workflow guide](../WORKFLOW.md#2-install-the-real-model-dependencies).
A WebGPU-capable Chrome or Edge browser is required. Node.js and npm are not
required to run the app.

Checkpoints are not bundled. For **trained text**,
[import the original TinyStories weights with their matching wiring](../../model/README.md#vibe2-trained-fly-dopamine-weights),
then launch:

```console
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --model-ckpt model/checkpoints/vibe2_tinystories.pt --viz-port 8767 --model-id vibe2-tinystories
```

Open **http://127.0.0.1:8772/app/**. No query string or Connect button is needed.
The app connects immediately, before generation. Wait for the model ID, live
connection status, and graph counts. The imported TinyStories topology has
**1,959 nodes and 19,037 directed edges**. An idle model supplies a mapping but no
new activity. Generate a prompt to observe real inference activity.

For an **untrained smoke model** instead, initialize at a new scratch path.
`model.init_model` overwrites its output; never point it at trained weights:

```console
python -m model.init_model --impl vibe2 --out model/checkpoints/scratch-vibe2.pt
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --model-ckpt model/checkpoints/scratch-vibe2.pt --viz-port 8767 --model-id vibe2-untrained
```

The bundled untrained topology has **1,958 nodes and 19,037 directed edges**.
Its generated text is not evidence of trained-model quality.

The app server owns one `harness.telemetry.serve` child. That child loads the
checkpoint and supplies the HTTP inference API, graph stream, and producer token
metadata. Ctrl-C stops the app server and its owned child. Loading returns
`503 model_loading`; an exited child returns `503 model_exited`, rather than
silently adopting another API listening on the configured port. The launcher
adds the checkpoint basename and SHA-256 to `/health`, not its full path.
The telemetry server reports checkpoint-derived notes, including the source
training step and validation loss when recorded.

`--model-id` is a display/API label. The implementation is selected by the
checkpoint, not by that label or a runtime dropdown. Fresh initialization is
untrained; generated text has no quality claim.

### Binding and ports

```text
Browser /app/ -- fetch/SSE --> app server -- HTTP --> owned telemetry model
             -- WebSocket -->           -- WebSocket --> same model /stream
```

- App HTTP: `--port 8772`; API target: `--api-url http://127.0.0.1:8771`.
- Child visualization: `--viz-port 8767`, fixed path `/stream`.
- `GET /app-config` returns `{"stream_url":"/stream"}` with `Cache-Control: no-store`.
  The browser resolves it on the page's host and port, using `ws` for HTTP or
  `wss` for HTTPS. The app relays the stream to the configured loopback model.
  An old `?ws=` query does not select or override the backend.
- Owned mode derives the stream URL from the child configuration. An explicit
  `--viz-url` must agree; it cannot redirect the app to an unrelated stream.
- Use app flags for checkpoint, endpoints, model ID, and optional `--record PATH`.
  `--model-arg` accepts other model options, for example
  `--model-arg=--device --model-arg=cpu`. It rejects overrides of app-owned binding
  options and `--no-viz`.
- The owned model API must be a plain HTTP loopback origin. Visualization URLs
  must use loopback `ws`/`wss`, without credentials, query strings, or fragments.
- Run one source per port. Choose different ports if occupied; do not stop
  someone else's service. Ports 8765 and 8000 may already belong to other models.

For network access, add **`--host 0.0.0.0`** to the app command and open
`http://<server-address>:8772/app/`. Only the app port needs exposure; the model
API and visualization listener remain on loopback. The app has no authentication;
use a trusted network or a protected reverse proxy, not public hosting.

WebGPU requires HTTPS or a browser-trusted loopback origin. Remote plain HTTP
supports prompts and stream inspection but not GPU drawing. An HTTPS reverse
proxy must also forward WebSocket upgrades for `/stream`.

### An already-running model

Proxy-only mode requires an explicit stream URL:

```console
python -m harness.telemetry.serve --ckpt model/checkpoints/scratch-vibe2.pt --port 8771 --viz-port 8767 --model-id vibe2-untrained
```

In another terminal:

```console
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --viz-url ws://127.0.0.1:8767/stream
```

Open the same bare `/app/` URL. In this mode you are responsible for binding both
URLs to the intended model. The app server neither owns nor stops that model and
cannot independently attest its checkpoint. Omitting `--viz-url` produces
`{"stream_url":null}` and an explicit unconfigured-stream message, not a guessed
connection to port 8765. The ordinary frozen `model.serve.serve` API is also
supported; without producer token telemetry, readout text is labeled **Local SSE**.

## Prompt

One prompt textarea above paginated output, with **Generate**, **Stop**, and
**Copy**. `Ctrl+Enter` / `Cmd+Enter` submits; ordinary newlines, IME composition,
and key-repeat handling are preserved. Blank input produces an inline error.

- **Generate** requires both a healthy model API and an accepted mapping on the
  live stream. A socket opening alone is insufficient. A disconnect prevents new
  requests, clears the graph, and triggers the existing automatic reconnect path.
- **Stop** aborts the active HTTP request and preserves partial text. It remains
  available if the graph connection drops during a request. The proxy closes the
  upstream connection; the model detects cancellation on its next write. This is
  best effort, not an authoritative wire cancellation acknowledgment.
- A new request replaces the previous output. There is no extra Clear action.
- **Copy** copies the full output, not just the visible page, preserving Unicode
  and whitespace. Clipboard failures are reported explicitly.
- Previous / Next / Latest appear only for multiple output pages. Pagination uses
  the measured output area, preserves Unicode code points and CRLF, and bounds
  long unbroken text without a scrolling output panel.
- State, usage, and finish reason are read-only. API health is polled
  automatically. The health banner's tooltip contains the full reported model
  and checkpoint identity.

The production UI uses supported generation defaults: 64 completion tokens,
temperature 1, and top-k 50; the server's cap remains separate. Parameter and
API-key support remains in the programmatic inference client, not in a second
hidden settings interface. The minimal UI assumes an unauthenticated loopback
API; it does not configure protected or public hosting.

## Graph and decoded readout

On wide screens the graph and the selected workbench pane share one viewport.
On narrow screens the three view buttons switch the visible pane. Fit graph and
zoom buttons operate on the camera; drag pans, the wheel zooms, a node click
selects a neuron, and a background click clears the selection.

Inactive nodes and synapses are translucent. Accepted activity pairs light the
directed edge and both endpoints for 600 ms. Reduced motion holds the highlight
then removes it without a fade. Rendering is a deterministic schematic, not
anatomical coordinates. Activity frames and last step are displayed below the graph.

Actual mapped MBON nodes connect by dashed architectural paths to a model-readout
hub and decoded-text card. The links follow camera movement; mappings without
MBONs do not acquire invented nodes. These links are **not** measured per-MBON
word attribution or biological synapses.

With producer telemetry, the card shows actual completion token IDs, incrementally
decoded text, and processed/unprocessed status. The final sampled token may be
`unprocessed (t=-1)`. Raw token bytes are available in a tooltip rather than a hex
wall. History retains 128 completion tokens and labels evictions. One navigation
row moves through tokens and bounded text pieces; it appears only when navigation
is possible. Local SSE text never invents token IDs or graph-step alignment.

## Neuron

Click a graph node or look up an actual mapping ID. Identity, Links, and Activity
show declared metadata, directed neighbors, and observed activity. Invalid IDs
produce an inline error. Selecting another neuron replaces the selection;
background deselection, mapping replacement, and disconnect clear it.

Neighbor lists are paged in groups of 10, and observed step history is capped at
32 entries. Missing body IDs are displayed as not exported, never inferred.
No observed fire does not mean inactivity: fire reports positive KC code, not
biological spikes.

## Review a recording

The live workspace does not contain recording/playback controls. Use the separate
[Canvas example](../example/README.md) with `harness.replay_prompt`, passing the
recording as its positional argument. For the checked-in real-model reference:

```console
python -m pip install websockets
python -m harness.replay_prompt harness/recordings/reference.ndjson --port 8768
```

In another terminal:

```console
python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open **http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream**. This is the separate
Canvas viewer, not `/app/`. It needs no checkpoint, PyTorch, or tokenizer. The
reference's [metadata](../recordings/reference.ndjson.metadata.json) records its
provenance. A recording is never substituted for a failed production model.

## Contracts and development

`mountPrompt`, `mountInspector`, and `mountReadout` return disposers. The DOM-free
`GenerationController` and `NeuronIndex` remain reusable. `mountPrompt` optionally
accepts `subscribeConnection(listener) -> unsubscribe`, whose immediate and later
snapshots are `{ready, message}`. Without that option, standalone consumers use API
readiness alone. Disposal removes the connection subscription.

The [v1 inference contract](inference-contract/v1/README.md),
[TypeScript declarations](inference-contract/v1/types.d.ts), and checked
[development fixture](inference-contract/v1/fixture.js) describe the existing API.
Fixtures are never production fallbacks. Graph protocol semantics remain in
[`../protocol/v1/`](../protocol/v1/). The receiver validates messages before
renderer allocation; accepted mapping replacement creates a new epoch and clears
old state. The frozen serving engine under `model/serve/` is unchanged.

The stdlib app server confines static files to `harness/`, rejects traversal and
hidden assets, proxies only the documented `/health` and `/v1` routes, and forwards
SSE incrementally. It is a local development server, not public secure hosting.

From the repository root, with Node.js 22+ for the frontend checks:

```console
npm --prefix harness/app test
python -m pytest test/test_app_server.py
```

The optional pinned TypeScript development check is unchanged:

```console
npm --prefix harness/app ci --ignore-scripts
npm --prefix harness/app run typecheck
```

Latest integration verification: 199 frontend tests passed using Bun; 37 backend
checks passed. The existing symlink-confinement test requires Windows symlink
privileges unavailable on the verification machine. A fresh bare `/app/` entry
auto-connected to the actual untrained vibe2 model before interaction; generation,
Stop, full-output clipboard copying, real graph activity, and recovery after an
owned-service restart were exercised. Thirty actual UI states across six
viewports, including 320×568, had no viewport or panel overflow.
