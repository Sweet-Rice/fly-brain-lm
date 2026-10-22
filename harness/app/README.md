# Integrated browser workspace

This browser workspace pairs a WebGPU graph activity viewer with an integrated
prompt composer and neuron inspector. Built with no-build vanilla ES modules, the
public mount functions (`mountPrompt`, `mountInspector`) return disposers, while the
core inference controller (`generation.js`), neuron index (`inspector.js`), and protocol
parsers (`protocol.js`) contain DOM-free logic so that a future React or other UI
port can import and reuse the same state machines and indexing without DOM coupling
or provisional aliases (`.controller`, `.CLASSES`). Existing visualization sources
and receivers are unaffected and operate normally even when the model API is missing
or unstarted. The existing `harness/example/` Canvas demo is unchanged.

For the canonical real-model reference, clean-checkout setup and all integration
scenarios, use the [end-to-end workflow](../WORKFLOW.md). The dashboard layout and
its data limits follow the
[dashboard visual redesign plan](dashboard-visual-redesign-plan.md); see
[Fly-brain schematic](#fly-brain-schematic) below.

## Run the live workspace (real model + app server)

To run the full integrated workspace with live model prompting and visualization,
initialize an untrained scratch checkpoint and use the two-terminal setup from
the repository root (default `model.init_model` writes `model/checkpoints/<impl>.pt`,
e.g. `vibe.pt`, not `init.pt`; do not overwrite private trained checkpoints):

```console
# Step 1: Initialize an untrained checkpoint (vibe or vibe2) to a new path
python -m model.init_model --impl vibe2 --out /tmp/flybrain-scratch.pt

# Terminal 1: Real model server (HTTP API on 8771, visualization stream on 8767)
python -m model.serve.serve --ckpt /tmp/flybrain-scratch.pt --port 8771 --viz-port 8767

# Terminal 2: App server (serves /app/ and proxies /health + /v1 on 8772 to 8771)
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771
```

Open **http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8767/stream** in a WebGPU-capable
Chrome or Edge browser.
- **Port safety**: Port **8772** serves the application and provides a same-origin stdlib
  reverse proxy for `/health` and `/v1` endpoints (defaulting 8772 -> 8771); this same-origin
  proxy avoids browser CORS restrictions. Port **8767** hosts the model visualization
  WebSocket stream (`/stream`). Run one service per port; leave program defaults 8765 and
  8000 alone.
- **Local development proxy**: The app server reverse proxy is a local loopback
  convenience, not public secure hosting. Upstream `model/serve/serve.py` remains
  frozen and untouched.
- **Implementation selection**: Model architectures (`vibe` vs `vibe2`) are chosen
  when creating the checkpoint (default `model.init_model` writes `model/checkpoints/vibe.pt`,
  not `init.pt`; do not overwrite private trained checkpoints; see
  [model initialization](../../model/README.md)), not through a runtime serving dropdown.
  Serving defaults to `model/checkpoints/init.pt`, so explicitly pass `--ckpt` pointing to
  your scratch checkpoint. `model.serve.serve` loads whichever implementation is recorded
  in the checkpoint metadata.
- **Separate transports**: The visualization WebSocket is configured separately
  (via `?ws=ws://127.0.0.1:8767/stream` or the UI field); text completions use
  same-origin HTTP/SSE. Tokens and graph fires stream over separate transports;
  never claim fire/token alignment, synced tokens, or known checkpoint revision /
  loading status.
## Run from a fresh checkout (offline review)

Python 3 serves the static application; there are no frontend dependencies, build
step, npm install or model requirements. From the repository root:

```console
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

Open **http://127.0.0.1:8772/app/** in a WebGPU-capable Chrome or Edge browser.
The page should show `WebGPU ready. Waiting for a mapping.` If an adapter is
unavailable, it shows an actionable message and protocol inspection still works.
Do not open the HTML with `file://`.
In this static offline mode, the prompt composer detects that the model reverse
proxy is unavailable (static-page mode) and displays a retryable notice, while
offline recording playback, graph navigation, and independent WebSocket
connections continue to work normally.
Choose **Open a recording** and select
`harness/protocol/v1/fixtures/reference.ndjson` or the real capture at
`harness/example/once_upon_a_time.ndjson`. This needs no network service, PyTorch,
checkpoint or tokenizer. The reference ends with 3 nodes, 2 edges and step 0
after its replacement mapping; the real capture ends with 1,958 nodes, 19,037
edges and step 10 (11 accepted fires). Playback starts automatically when a file
is selected. This is an explicit offline recording mode, not a fallback for an
unavailable production model.

### Play a recording

- **Pause** stops delivery of recording messages; **Play** resumes from that point.
  The remaining playback delay is preserved. An edge already highlighted may
  finish its 600 ms fade while playback is paused.
- **Restart** rereads the selected file from its beginning and starts playing.
  It clears the graph, counters, receiver epoch and activity; the first accepted
  mapping is epoch 0 again.
- **Playback speed** offers 0.25×, 0.5×, 1×, 2× and 4×. At the default 1×,
  accepted fires use a synthetic **500 ms** cadence. Speed changes this cadence,
  including the remaining current delay, not the renderer's 600 ms highlight
  duration.

The first mapping and first accepted fire are delivered immediately. After an
accepted fire, playback waits 500 ms at 1× before delivering the next nonblank
message; it does not add a delay after the final message. Later replacement
mappings stay at their position in the recording and clear obsolete graph
activity. The protocol's `t` only orders accepted fires: omitted steps add no
extra delay and create no synthetic fires. Recorded messages have no wall-clock timestamps, so playback
does not reproduce inference or training timing.

Reading is streamed, and choosing another file, connecting a live source or
clicking Disconnect cancels the current playback. Individual malformed lines
are counted and skipped through the same receiver used for live input; later
valid lines still play. An empty file or a file with no accepted mapping reports
an unusable-recording error. Unsupported protocol versions stop playback, clear
the graph and show an unsupported-data message. File read errors also appear in
the source status.

The graph status should match the accepted node/edge counts. Group labels follow
the mapping's array order; arrowheads point to the destination, including on
self-connections and reverse connections. Group names also appear in the table
below the graph. This is a schematic, not an anatomical reconstruction.

### Inspect the graph and select neurons

- Drag within the graph to pan; scroll to zoom around the pointer.
- Use **Zoom in (+)**, **Zoom out (−)** and **Fit graph** without a mouse wheel.
- Focus the graph with Tab: arrow keys pan, +/− zoom, and 0 or Home fits the graph.
- Resizing preserves the current view; use Fit graph to show the whole network
  after changing window size. Dense graphs need zoom to inspect individual edges.
- **Click vs pan picking**: Click directly on a node to select it. Dragging (pointer
  movement exceeding a small movement threshold) pans the camera without selecting
  nodes. Clicking empty background clears the active selection.
- **Selection overlay**: Selecting a node rings it in white, rings its neighbours,
  and draws its incoming edges in fuchsia and outgoing edges in coral along the
  same curved paths as the base edges. This overlay is rendered dynamically without
  rebuilding static graph topology or reallocating rendering pipelines.
- Selection events (`node-select` and `select-node`) work even before GPU initialization
  completes, or when WebGPU is unavailable.

### Fly-brain schematic

When any mapping group name matches the model exporter's groups, the graph is
drawn inside a frontal-view fly-brain outline (`brain-atlas.js`): central brain,
both optic lobes, esophageal foramen, and per hemisphere the antennal lobe (AL) and
mushroom body (calyx, peduncle, vertical and medial lobes). The modeled circuit
fills the viewer's-left hemisphere; the other hemisphere is outline-only context.

| Group | Placement |
|---|---|
| `Glomerulus` | Antennal lobe |
| `KC_gamma`, `KC_alphabeta`, `KC_alphaprime_betaprime` | Three adjacent calyx sectors, angular spans proportional to member counts |
| `MBON` | Lobe of the KC group supplying most of its declared incoming edges (γ medial lobe; α/β and α′/β′ vertical lobe), heel when tied or absent |

- **Schematic, not anatomy.** Positions are illustrative; the chip above the
  viewport says so whenever the template is drawn. Mappings carry no coordinates,
  body IDs or hemisphere, so the UI shows no left/right label, scale bar or
  measured shape. AL and mushroom body are enlarged so the circuit is legible.
  Glomerulus and MBON nodes are model abstractions, not single neurons.
- **Real topology only.** Every mapping node and directed edge is drawn once; context
  neuropils carry no dots. Glomerulus→KC edges curve through an antennal-lobe-tract
  waypoint and KC→MBON edges through the peduncle (4-segment quadratic curves);
  other edges stay straight and self-loops keep their loop.
- **Deterministic.** Members sort by numeric node id and fill each area with a
  golden-angle pattern; one uniform scale keeps node centres at least 2.5 × the node
  radius apart. Sparse ids do not allocate arrays sized by the largest id.
- **Fallback.** Mappings with no matching group names (for example `PN`, `KC`,
  `Sensory`) keep the grouped grid with no brain outline. In mixed mappings,
  unmatched groups form a labelled grid row beneath the brain. Empty groups keep a
  label and isolated nodes remain visible.
- Positions are computed locally; no coordinates or floating-point fields are added
  to the protocol.

Geometry for the real capture (1,958 nodes, 19,037 edges, no self-edges), measured
2026-10-21 on this branch with `stress.html` in headless Chromium on the SwiftShader
software adapter (single samples; not native-GPU timings):

| | Grid (`4d371cd`) | Fly brain |
|---|---:|---:|
| Static geometry bytes (regions + edges + nodes) | 6,770,988 | 16,516,164 |
| Edge buffer bytes | 4,797,324 | 14,391,972 |
| Layout, Node p50 / p95 (30 runs) | 122.9 / 136.8 ms | 82.4 / 125.2 ms |
| Layout in browser, first run | 189.5 ms | 181.7 ms |
| GPU upload CPU / with fence | 29.3 / 55.0 ms | 40.0 / 80.6 ms |
| Submitted-work fence p50 / p95 | 61.3 / 79.1 ms | 87.6 / 115.8 ms |
| Steady / peak live buffers | 4 / 7 | 5 / 9 |
| Static buffer creations during activity | 0 | 0 |

Layout preallocates typed arrays, so it got faster despite 3× the edge vertices.
The extra fence time is software rasterization of the larger edge buffer.

### Neuron inspector panel

The neuron inspector (`inspector.js`) is backed by a DOM-free topology index (`NeuronIndex`)
that manages sparse node IDs, adjacency lists, and per-node observed activity:

- **ID selection form**: Enter any numeric sparse node ID (`#inspector-node-input`) and
  click Inspect (`#inspector-select-btn`) or press Enter to inspect that node.
- **Node attributes**: Displays the selected node ID and its declared group / model role
  label (e.g. `Sensory`, `Expansion_0`, `Output`). Group names reflect actual mapping
  declarations; no speculative biological anatomy is invented.
- **Missing body IDs**: FlyWire/hemibrain body IDs are not present in exported model
  mappings. The panel explicitly displays body IDs as unavailable / not exported
  (`Body ID: not exported`), rather than inferring or hallucinating them.
- **Topological neighbor navigation**: Shows exact in-degree and out-degree. Full lists
  of upstream (incoming) and downstream (outgoing) neighbor node IDs are displayed with
  pagination controls (`Prev` and `Next`, 10 per page) so high-degree nodes are never
  silently truncated. Clicking any neighbor button immediately selects that node and
  dispatches `select-node`.
- **Observed fire history**: Displays the most recent observed fire steps for the
  selected node, bounded to a maximum capacity of 32 steps (`MAX_RECENT_STEPS`) within
  the current epoch. Memory usage is strictly bounded ($O(\text{nodes} + \text{edges} + \text{nodes}\times\text{history})$);
  the inspector never accumulates an unbounded event stream.
- **Missing-data caveat**: "No observed fire does not mean inactive; fire means positive
  KC code, not biological spikes." Steps may also be omitted or dropped by bounded queues
  under load.
- **Epoch reset**: When a mapping replacement arrives or the connection resets, previous
  selections and observed fire histories are cleared to prevent stale state from leaking
  across epochs.

### Prompt composer

The prompt composer (`prompt-view.js` and `generation.js`) provides an in-browser
interface for submitting generation requests to the local model reverse proxy:

- **Prompt input**: Multiline, nonblank text area (`#prompt-input`). Submitting an
  empty or whitespace-only prompt displays an inline validation error.
- **Keyboard shortcut**: `Ctrl+Enter` or `Cmd+Enter` submits generation immediately,
  without intercepting ordinary newlines or interfering with IME composition.
- **Controls**:
  - **Generate** (`#prompt-generate-btn`): Validates settings and initiates SSE streaming.
    Disabled while an active request is in flight or when model readiness is not ready.
  - **Cancel** (`#prompt-cancel-btn`): Aborts the active generation via `AbortController`.
    The app server detects client disconnect and closes the upstream socket; the upstream
    model server discovers the severed connection on its next token write and terminates
    generation (best effort, no wire cancel acknowledgment). Any partial text already
    received is preserved in the output display.
  - **Clear** (`#prompt-clear-btn`): Clears both prompt input and output text; enabled only
    when generation is inactive (idle).
  - **Copy** (`#prompt-copy-btn`): Copies generated text only to the system clipboard,
    preserving Unicode whitespace. Text is inserted into the DOM strictly via `textContent`,
    preventing HTML injection. Rapid repeat clicks reset the copied feedback timer.
- **Inference settings**:
  - `max_tokens` (`#prompt-max-tokens`): Integer between 1 and 128 (validated and rejected
    if out of bounds; upstream server cap is separate).
  - `temperature` (`#prompt-temperature`): Finite float between 0.0 and 2.0 (validated and
    rejected if out of bounds).
  - `top_k` (`#prompt-top-k`): Integer between 1 and 50257 (validated and rejected if out of bounds).
  - Optional API key (`#prompt-api-key`): Memory-only authorization field passed in the
    `Authorization: Bearer <key>` header to upstream. It is normalized (whitespace trimmed,
    empty string to null), retained only in JavaScript memory for the active session (never
    persisted to localStorage, cookies, or disk), and synced to `/health` readiness checks as well.
- **Model readiness and health**:
  - Queries same-origin `GET /health` to confirm the model server is reachable.
  - Displays model status, model ID (`flybrain-untrained`), and the untrained model note.
    No checkpoint revisions or loading statuses are reported.
  - Includes a manual retry button (`#prompt-health-retry-btn`) to recheck availability.
  - In static offline mode (`http.server`), reports that the model proxy is unavailable
    (static-page mode) with clear guidance rather than crashing.
- **State machine and announcements**:
  - Strict states: `idle`, `validating`, `submitting`, `streaming`, `cancelling`,
    `completed`, `cancelled`, and `failed`.
  - Accessible announcements (`#prompt-announcement`) announce terminal completion or
    errors without flooding screen readers on every token chunk.
- **Future timeline and memory panels**:
  - Timeline and memory backend integration issues will be linked in a follow-up PR later
    (no placeholder doc links are created).
### Activity highlights

Every accepted source-to-destination pair brightens its entire directed edge,
including the destination arrowhead, then fades linearly to its base color over
**600 ms** of local elapsed time. The highlight mixes 80% white into the edge's
group color and raises its opacity to 95% at the start. A repeat restarts that
edge's 600 ms highlight; it does not add intensity. Other active edges keep their
own start times. With the system's reduced-motion preference enabled, the edge
holds its full highlight for 600 ms and then returns to its base appearance.

The protocol's `t` determines message order only. A jump in `t` highlights the
received pairs immediately, without waiting or inventing intermediate fires.
Filtered undeclared pairs cannot light an edge; valid pairs in the same accepted
fire still do. Mapping replacement, source switch, disconnect and reconnect
discard all prior activity, even when an edge id is reused. Recording playback
delivers the same validated fire events at its selected synthetic cadence.

For live input, install the replay's sole dependency if needed, then start it in
a second terminal from the repository root:

```console
python -m pip install websockets
python -m harness.replay_prompt --port 8768
```

Open **http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8768/stream** to connect
automatically, or enter that WebSocket endpoint and click Connect. The default
endpoint without a query parameter is the protocol default,
`ws://127.0.0.1:8765/stream`; startup does not connect until requested. To use a
live model instead, enter its printed stream URL, usually port 8767 in the
repository guides. Run one source per stream port. Leave other people's services
on 8765 and 8000 alone; choose another page/replay port if needed. Ctrl-C stops
each server you started.

Hiding the tab closes the live connection and clears its graph. Returning to the
tab reconnects to the requested endpoint and requires a fresh mapping; activity
missed while hidden is discarded. Disconnect or choosing a recording cancels
that automatic resumption. Recording delivery keeps its selected cadence while
GPU drawing is suspended in a hidden tab.

Measured limits and repeatable stress checks are in
[`../PERFORMANCE.md`](../PERFORMANCE.md).

## Receiver and renderer boundary

`protocol.js` has no DOM, WebSocket or model imports. `ProtocolReceiver.process`
accepts a raw JSON text message and returns the same action objects as the
shared [v1 fixtures](../protocol/v1/README.md). `receiver.mapping` is the current
validated mapping; `lastT` is the accepted step. A valid mapping replaces the
previous graph atomically; an invalid mapping preserves it. Node/group ids are
lookup keys, including sparse ids. Malformed or duplicate fire pairs reject
that whole fire without advancing the step. Undeclared pairs are filtered.
Unknown fields and message types remain forward compatible.

`sources.js` passes live message text and recording lines through that same
`process` method. `playback.js` gates the streaming reader before validation to
pause delivery and schedule the next message without caching the recording.
A source switch/disconnect/reconnect clears protocol state;
late callbacks from an old socket or cancelled file cannot install old data.
An unexpected socket close retries after one second with a single retry timer.
Disconnect cancels that timer. File errors are displayed; malformed lines are
counted and skipped so later valid activity continues. Unsupported versions stop
either source until the user chooses a source again.

`main.js` publishes these DOM events on `#viewport`:

- `mapping`: `event.detail` is the fully validated mapping; discard the old scene.
- `fire`: `event.detail` is `{t, pairs}`, containing only accepted declared pairs.
- `reset`: discard all scene and animation state, including on reconnect.

`gpu.js` consumes mapping/fire/reset events, retaining the latest mapping and its
recent activity while the GPU initializes. `layout.js` builds static triangle
geometry; `renderer.js` uploads it to edge/node buffers and draws them through a
native WGSL pipeline. `activity.js` uses a dense edge lookup and reusable typed
arrays for local start times, independent of sparse node ids and protocol steps.
`camera.js` handles fit, pan and anchored zoom in CSS pixels. Navigation and
resize update the camera without rebuilding geometry. Rendering runs only on
mapping, reset, navigation or resize, and while any highlight is active. Fires
update reusable CPU timestamps; the next rendered frame uploads activity once
for the entire burst. Frames also update camera/time uniforms.
Neither path rebuilds or uploads static graph geometry, and the renderer creates
no per-edge objects each frame. The animation loop stops when highlights expire.

A replacement mapping rebuilds the complete scene and fits its bounds. While a
frame is in flight or the tab is hidden, only the latest mapping is retained;
layout and upload wait for a visible frame. Obsolete buffer handles are destroyed
on replacement; WebGPU retains submitted uses until completion. Disconnect/reset clears
the viewport and labels. Device loss stops drawing and releases resources; reload
to retry. Allocation failures show a message and clear the old scene so it cannot
be mistaken for the new topology.

The UI retains only the latest mapping and a short latest-fire text preview;
it does not accumulate a history of fire events.

### Unsupported versions in browsers

The v1 contract and issue #18 request close code `1003`. The receiver emits that
exact logical action, and all contract fixtures are checked unchanged. However,
the [browser WebSocket API](https://websockets.spec.whatwg.org/#dom-websocket-close)
only permits application code to send `1000` or `3000–4999`: attempting
`close(1003)` throws and leaves the connection open. The browser adapter therefore
sends **4001** with reason `Unsupported protocol version`, reports protocol code
1003 in the UI, and stops automatic retries. This is an explicit browser transport
adaptation; the actual wire close code is 4001. Other protocol behavior follows
the checked-in contract.

## Versioned inference contract

The workspace implements [UI inference contract v1](inference-contract/v1/README.md):
typed health/model metadata, prompt requests, completion/SSE events, terminal usage,
structured errors, and best-effort cancellation through the same-origin proxy.
[`types.d.ts`](inference-contract/v1/types.d.ts) is the portable TypeScript boundary;
[`fixture.js`](inference-contract/v1/fixture.js) is checked development/test data,
never a production model fallback.

The contract distinguishes local run ids from server completion ids, and decoded text
chunks from model tokens. It does not fabricate loading phases, checkpoint identity,
cancel acknowledgments, or token/fire alignment. Frozen `model/serve/` code is unchanged.

## Verify

Node.js 22+ runs the frontend tests without installing npm dependencies. From this folder:

```console
npm test
```

Or from the repository root:

```console
npm --prefix harness/app test
```

The pinned TypeScript checker validates the inference declarations, shared fixture,
and positive/negative consumer examples. It is development-only; running the
browser or the JavaScript tests still needs no npm installation:

```console
npm --prefix harness/app ci --ignore-scripts
npm --prefix harness/app run typecheck
```

To verify the app server reverse proxy, run pytest from the repository root:

```console
python -m pytest test/test_app_server.py
```

### Test coverage

- **`test/test_app_server.py`**: Loopback-only binding, static asset confinement under `harness/`,
  rejection of parent directory traversal (`..`) and hidden files/repo secrets, root `/` redirect
  to `/app/`, proxy route whitelist (`GET /health`, `GET /v1/models`, `POST /v1/completions`,
  `POST /v1/chat/completions`), structured JSON 503 when upstream is down, incremental SSE
  streaming without buffering the full response, closing of upstream socket on client abort,
  and memory-only `Authorization` header pass-through (10 observed tests).
- **`generation.test.js`**: Parameter validation and rejection (empty/whitespace rejection,
  bounds validation for `max_tokens` [1..128], `temperature` [0..2], and `top_k` [1..50257];
  upstream server cap is separate), inference state machine transitions (`idle`, `validating`,
  `submitting`, `streaming`, `cancelling`, `completed`, `cancelled`, `failed`), SSE line and
  JSON chunk parser, usage chunk handling, terminal `[DONE]` detection, UTF-8 multi-byte split
  handling across chunk boundaries, malformed/truncated stream error recovery with preserved partial
  text, cancellation abort signal handling, reader lock release on terminal `[DONE]` or cancellation,
  health readiness checks and retry, normalized API key header sync, actionable proxy errors
  (501/405/503), traceback sanitization, and terminal accessibility announcements.
- **`prompt-view.test.js`**: DOM rendering with stable `prompt-*` IDs and accessible announcements,
  keyboard shortcut `Ctrl+Enter` / `Cmd+Enter` (ignores repeat keydown, preserves newlines and
  IME composition), Generate, Cancel, Clear, and Copy buttons lifecycle, Copy button clipboard
  interaction via `navigator.clipboard.writeText` with rapid feedback timer reset, Clear action
  resetting prompt input and output when idle (disabled during generation), readiness gating of
  submission, manual health retry button with typed API key sync and clearing, error banner display,
  terminal status announcements with accurate Unicode codepoint counting, and safe disposer cleanup.
- **`inspector.test.js`**: DOM-free `NeuronIndex` (sparse node ID indexing, integer ID parsing,
  incoming/outgoing degree and neighbor list computation, self-loop activity deduplication per
  step, per-node recent observed fire history capped at `MAX_RECENT_STEPS` [32 steps] within current
  epoch, epoch reset and mapping replacement clearing stale state), `mountInspector` DOM rendering
  with stable `inspector-*` IDs, selected node role (declared group name), explicit `Body ID: not exported`
  status, keyboard selection form, custom event dispatch (`select-node` and `node-select` without
  echo loops), paginated neighbor navigation (`Prev`/`Next`, 10 per page) without truncation,
  plain-words missing-data caveat ("No observed fire does not mean inactive; fire means positive KC code, not biological spikes"),
  canvas-null tolerance, and disposer cleanup.
- **`gpu.test.js` and `layout.test.js`**: Node picking under camera pan/zoom transformations,
  drag vs click threshold differentiation, background click clearing selection, dynamic
  selection ring and incident edge overlay rendering without per-frame allocations,
  selection events prior to GPU readiness, and the `data-layout` marker through
  replacement and reset. Layout tests check real-capture anatomical placement against
  the same world-space areas the layout used, node spacing, determinism under node
  reordering, curved tract edges with arrowheads at destinations, overlays following
  those curves, non-overlapping areas, callouts near their own groups, fit dot size,
  grid fallback, mixed mappings and empty/sparse/self-loop cases.
- **Existing protocol and rendering suites**: `protocol.test.js`, `sources.test.js`,
  `playback.test.js`, `activity.test.js`, `camera.test.js`, `renderer.test.js`,
  `main.test.js`, and `workflow.test.js` continue to verify normative v1 contract fixtures,
  real capture validation, live/file parity, reconnect/reset, deterministic layout,
  sparse IDs, buffer release, and reduced motion.
### Manual verification instructions

1. **Offline recording check**:
   Start `python -m http.server 8772 --bind 127.0.0.1 --directory harness`.
   Open `http://127.0.0.1:8772/app/`. Verify that the prompt composer displays a
   notice that the local model proxy is unavailable (static mode) with a retry button.
   Open `recordings/reference.ndjson`; verify graph renders, play/pause/restart/speed
   controls work, and edges highlight on accepted fires.
2. **Live two-terminal workspace check**:
   Initialize an untrained scratch checkpoint (default `model.init_model` writes `model/checkpoints/<impl>.pt`,
   e.g. `vibe.pt`, not `init.pt`; do not overwrite private trained checkpoints: `python -m model.init_model --impl vibe2 --out /tmp/flybrain-scratch.pt`).
   Start `python -m model.serve.serve --ckpt /tmp/flybrain-scratch.pt --port 8771 --viz-port 8767`
   in Terminal 1, and `python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771`
   in Terminal 2. Open `http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8767/stream`.
   - Verify `#prompt-health-status` reports the configured model ID and note, and enables Generate.
   - Enter a prompt, press `Ctrl+Enter` or click **Generate**; verify incremental text
     appears in `#prompt-output` and the finish reason is reported.
   - Start a longer generation and click **Cancel**; verify generation stops, already
     received partial text remains displayed, and upstream disconnects.
   - Click **Copy**; verify the copied clipboard contents match the generated output.
   - Click a node in the graph; verify the node is highlighted with a ring, incident
     edges highlight, and the inspector displays its sparse ID, role label, degree,
     paginated neighbors, and `Body ID: not exported`.
   - Click a neighbor button in the inspector; verify selection jumps to that neighbor.
   - Drag across the graph; verify camera pans without picking nodes. Click background
     to clear selection.
   - Stop Terminal 1 and click Retry on the health indicator; verify an actionable 503
     unavailable notice is shown.

### Observed workspace smoke

Checked with a fresh, untrained full `vibe2` checkpoint, the unchanged Python model
server, and the same-origin app server in headless Chromium using SwiftShader WebGPU.
Observed real SSE output and graph fires, cancel/resubmit, exact clipboard copying
with browser permission, invalid-input rejection, API-down offline inspection, and
API-key rejection/recovery. Node picking, neighbor focus, recording restart and
recorded-to-live switching worked. Layout stayed within the viewport at 360 px and
with CSS zoom set to 200%. This is software-GPU evidence, not native-device benchmarking.

### Observed fly-brain dashboard smoke

Checked on 2026-10-21 in headless Chromium with the SwiftShader WebGPU adapter.
Canvas presentation is not captured in this headless setup, so frames were read back
through a test-only `copyTextureToBuffer` shim; this is software-GPU evidence. At
1586×992 the canvas was 919×615 CSS px and Fit framed the whole brain (dots 2.56 px
across by camera math). Recording fires and live fires from an untrained `vibe2`
checkpoint brightened curved AL-tract and peduncle bundles. Clicking KC node 700
selected it (in-degree 11, out-degree 5 to MBONs 1943–1947) and fuchsia/coral overlays
followed the curves. Grid, mixed and real mappings replaced each other without GPU
errors, toggling the schematic chip. Play/Pause/Restart/4× speed, Generate, Cancel
with partial output, exact Copy, Clear, API-key rejection and recovery, and
recorded-to-live switching on Generate worked. No horizontal overflow or nested
scroll areas at 1586×992, 1024×768, 390×844 and 793×496 at 2× scale (200% zoom);
touch layouts gave every control at least 44 px; Tab reached every control in order
with a 2 px focus ring; reduced motion was honoured.
