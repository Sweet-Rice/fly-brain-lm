# Real model to browser: reproducible workflow

Run every command from the repository root. The integrated browser workspace in `app/`
combines WebGPU activity inspection with an in-browser prompt composer and neuron
inspector. Live activity here comes from actual PyTorch model hooks. The model is
**untrained**, so its generated text has no quality claim.

## 1. Offline review from a clean checkout

Only Python 3 and a WebGPU-capable Chrome or Edge browser are needed. No package
installation, CUDA, checkpoint, tokenizer, Node.js or model process is required.

```console
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

Use `python3` if that is your Python command. Open
**http://127.0.0.1:8772/app/** and select **Or open a recording**, then choose
[`recordings/reference.ndjson`](recordings/reference.ndjson) from the checkout.
Keep the page server running. The graph should show five named groups,
**1,958 nodes and 19,037 directed edges**. Accepted fires advance in `t` order
and brighten directed edges, including their destination arrowheads.

Playback starts automatically. Pause stops new messages, Play resumes, Restart
clears state and rereads the file from epoch 0, and speed changes the synthetic
500 ms fire cadence at 1×. The 600 ms highlight duration is independent of
playback speed. An existing highlight may finish fading after Pause. Gaps in
`t` add neither waiting time nor fabricated activity. No external network access
is used after checkout; `websockets` is unnecessary for file playback. In this
static offline mode, the prompt composer reports that the local model proxy is
unavailable (static-page mode), while file playback and graph navigation operate
normally.
The reference's adjacent
[`metadata`](recordings/reference.ndjson.metadata.json) identifies its real model,
wiring, generation settings and recording digest. It contains **two mappings and
44 actual fires**: 33 fires at `t=0..32`, then a refreshed mapping and 11 fires
at `t=0..10`. Its final playback state is epoch 1, last step 10 and 11 accepted
fires in that epoch. It is a review artifact, not a fallback response when a
production model is unavailable. The older
[`example/once_upon_a_time.ndjson`](example/once_upon_a_time.ndjson) remains an
immutable legacy fixture; the [Canvas example](example/README.md) is separate.

## 2. Install the real model dependencies

Python 3.12 was used on the target machine. Reuse an existing `.venv`; otherwise
create one. These commands install CPU PyTorch, so CUDA is unnecessary. Package
installation requires network access; `tiktoken` may also download its GPT-2
encoding on its first use. The checked-in `data/connectome/wiring.npz` supplies
the real wiring; no large connectome tables or TinyStories download are needed.

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install numpy pandas pyarrow tiktoken websockets pytest jsonschema
```

POSIX shell:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install numpy pandas pyarrow tiktoken websockets pytest jsonschema
```

For other PyTorch builds use the [installation selector](https://pytorch.org/get-started/locally/).
Optional data preparation is documented in [`../data/README.md`](../data/README.md).
The browser has no runtime npm dependencies or build step. Node.js 22+ runs its
tests; the optional development-only TypeScript checker verifies the
[UI inference contract v1](app/inference-contract/v1/README.md).

## 3. Run the headless smoke command

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m harness.workflow
```

POSIX shell:

```bash
.venv/bin/python -m harness.workflow
```

This builds the full default untrained `vibe` model from bundled wiring on CPU, using
seed 0, 12 layers and width 384. It runs greedy inference for `Once upon a time`
with up to eight generated tokens. It checks mapping-first delivery, ordered
declared fires, inference while disconnected, reconnect, mapping refresh with
restarted `t`, and unchanged generated tokens when the visualization hook is
detached. It needs no checkpoint and writes no checkpoint. Without `--record`,
its temporary recording is deleted. Failures exit unsuccessfully; passing this
command does not prove a browser has a usable WebGPU adapter.

### Run either model implementation

Add `--impl vibe2` to run the fly-dopamine implementation from PR #35 through
the same smoke scenarios; `--impl vibe` selects the existing scaffold explicitly.
Without `--impl`, the runner uses `FLYBRAIN_IMPL`, then defaults to `vibe`. Both
fresh defaults use 12 layers, width 384 and the bundled 54-glomerulus wiring:
1,958 nodes and 19,037 edges. They are different untrained models and need not
generate the same tokens or select the same KC paths. Within each implementation,
removing the hook must leave its generated tokens unchanged. The `personal`
registry entry is an unimplemented template and fails explicitly.

```console
python -m harness.workflow --impl vibe
python -m harness.workflow --impl vibe2
```

Neither command imports private trained weights. The checked-in reference remains
the historical `vibe` recording. New recording metadata identifies the selected
implementation, package and implementation-source digests; source hashes in old
reference metadata describe the code used at capture time.

## 4. Exercise the live browser workflow

Leave the static page server from step 1 running. In a second terminal start a
continuous real-model source:

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m harness.workflow --serve --port 0 --path /stream
```

POSIX shell:

```bash
.venv/bin/python -m harness.workflow --serve --port 0 --path /stream
```

Copy the exact printed `ws://127.0.0.1:<port>/stream` URL into the harness's
**WebSocket endpoint** and click **Connect**. `--port 0` reserves a free port;
the displayed port is the actual one, not zero. The source remains running until
Ctrl-C, processing the same prompt repeatedly with real greedy inference. Its
model hook spaces token steps by 100 ms for visible inspection; a one-second
pause separates rounds. This demonstration pacing is not inference throughput.
Its generated text is labelled untrained in the terminal.

For `vibe2`, add `--impl vibe2` to the live-source command. Exercise these
scenarios for each implementation, stopping one source before starting the other:

| Scenario | What to do | Expected browser result |
|---|---|---|
| Mapping first | Connect to the printed URL. | `Mapping accepted · epoch 0.`, five groups, 1,958 nodes, 19,037 edges; no fire is accepted before a mapping. |
| Real inference | Observe successive steps. | `Last step` increases within the epoch, `Accepted fires` grows, and declared edges brighten. `Dropped messages` and `Undeclared pairs` stay zero in this normal local run. |
| Reconnect during inference | Click Disconnect, leave the model running, then Connect again. | The old graph/counters clear; a fresh mapping precedes new fires. Receiver epoch starts at 0 again; the next `t` can already be above zero because inference continued. Missed activity is not replayed. |
| Mapping replacement | Stay connected for at least three inference rounds. | Inference pauses, the actual model mapping refreshes and is published, then inference resumes with `t` restarted at 0. Browser epoch increases, the graph rebuilds/refits, and old highlights/counters clear. Connectivity may be unchanged; replacement still creates a new epoch. |
| Offline recording | Disconnect, stop the model with Ctrl-C, and open the checked-in reference. | The same real topology and recorded fires render without any model or WebSocket process. Restart returns to epoch 0. |

This is a deterministic schematic, not anatomical coordinates. Drag to pan;
wheel or buttons zoom; Fit graph shows the whole graph. The
[viewer guide](app/README.md) covers keyboard controls and reduced motion.

### Record a new real-model run

Pass a **new** recording path. The command refuses to overwrite an existing
recording or its metadata file. Pick a different filename for each run; do not
replace checked-in fixtures during normal development.

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m harness.workflow --record "$env:TEMP\flybrain-review.ndjson"
```

POSIX shell:

```bash
.venv/bin/python -m harness.workflow --record /tmp/flybrain-review.ndjson
```

The adjacent `.metadata.json` records provenance and the recording digest. Use a distinct
filename for each implementation; for example add
`--impl vibe2 --record /tmp/flybrain-vibe2.ndjson` on POSIX (or a new `$env:TEMP`
path on Windows). Open
the NDJSON with the browser file picker. `--serve --record PATH` also records a
live session; stop it with Ctrl-C to finish the artifact. Recording is optional
and does not change inference. Its bounded writer can drop complete fires if
storage falls behind, producing valid `t` gaps rather than blocking the model.
This workflow requires a zero-drop run and fails if any were lost; a successful
metadata file records zero drops. See the terminal summary for the actual run.

## 5. Run the integrated browser workspace (prompting + graph visualization)

The integrated browser workspace connects live model prompting and WebGPU activity
inspection through a two-terminal loopback setup. The architecture uses clean public
mount functions (`mountPrompt`, `mountInspector`) that return disposers, backed by
DOM-free inference and topology controllers without provisional aliases (`.controller`,
`.CLASSES`). Existing visualization sources and receivers are unaffected and operate
normally even when the model API is missing or unstarted.

Checkpoints are gitignored and not bundled; initialize an untrained scratch checkpoint
first (default `model.init_model` writes `model/checkpoints/<impl>.pt`, e.g. `vibe.pt`,
not `init.pt`; do not overwrite private trained checkpoints):

```console
# Step 1: Initialize an untrained checkpoint (vibe or vibe2) to a new path
python -m model.init_model --impl vibe2 --out /tmp/flybrain-scratch.pt

# Terminal 1: Model server (HTTP API on 8771, visualization stream on 8767)
python -m model.serve.serve --ckpt /tmp/flybrain-scratch.pt --port 8771 --viz-port 8767

# Terminal 2: App server (serves /app/ and proxies /health + /v1 on 8772 to 8771)
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771
```

Open **http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8767/stream** in a WebGPU-capable
Chrome or Edge browser.

### Architecture and port safety

- **Port 8772 (App server)**: Serves `/app/` static assets from `harness/` and provides
  a same-origin reverse proxy for `/health` and `/v1` endpoints (defaulting 8772 -> 8771).
  This avoids browser CORS restrictions while accessing the model API.
- **Port 8771 (Model HTTP API)**: Serves model completions via standard HTTP/SSE.
- **Port 8767 (Visualization WebSocket)**: Serves the graph stream (`/stream`).
- **Same-origin reverse proxy**: The app server reverse proxy is a local loopback
  convenience for development, not public secure hosting. `model/serve/serve.py`
  remains completely frozen and untouched.
- **Model implementation selection**: Models (`vibe` vs `vibe2`) are chosen when
  initializing the checkpoint (default `init_model` writes `model/checkpoints/<impl>.pt`,
  e.g. `vibe.pt`, not `init.pt`; see [model initialization](../model/README.md)), not via
  a serving dropdown in the UI. Do not overwrite private trained checkpoints. Serving
  defaults to `model/checkpoints/init.pt`, so explicitly pass `--ckpt` pointing to your
  scratch checkpoint. Serving loads whichever implementation is recorded in the checkpoint.

### Prompt Composer in the workspace

- **Submit**: Type a nonblank prompt and click **Generate** or press `Ctrl+Enter` /
  `Cmd+Enter` (ordinary newlines and IME composition are preserved).
- **Cancel**: Clicking **Cancel** triggers `AbortController.abort()`. The app server
  detects the client disconnect and closes the upstream connection. The model server
  discovers the severed connection on its next token write and stops generation (best
  effort, no authoritative cancel acknowledgment). Any already-streamed partial text
  is preserved in the output display.
- **Clear & Copy**: **Clear** resets both the prompt and output (available when inactive /
  idle); **Copy** copies the generated output text only, preserving Unicode whitespace,
  rendered into the DOM strictly via `textContent`.
- **Settings validation**: Parameters validate and reject invalid values: integer
  `max_tokens` (1..128; upstream server cap is separate), finite `temperature` (0.0..2.0),
  integer `top_k` (1..50257). Optional memory-only API key is normalized (whitespace trimmed,
  empty string to null), retained only in memory, and synced across both completion
  requests and `/health` readiness checks as `Authorization: Bearer <key>`.
- **Readiness retry**: The interface queries same-origin `/health` on mount, displaying
  model ID and the untrained model notice. Click **Retry** if the model server is started
  after the app server. In static `http.server` mode, the prompt composer reports
  that the model proxy is unavailable (static mode) without breaking graph playback.
- **Separate transports**: The visualization WebSocket connects separately
  (`/?ws=ws://127.0.0.1:8767/stream`). Tokens and graph fires stream over independent
  transports; never claim fire/token alignment, synced tokens, or known checkpoint revision /
  loading status.

### Neuron Inspector in the workspace

- **Click vs pan picking**: Click a node to pick it. Dragging (movement above the
  threshold) pans the camera without picking nodes. Clicking empty background clears
  the selection.
- **Overlay highlighting**: The selected node is encircled with a highlight ring, and
  its incident incoming and outgoing directed edges brighten without per-frame geometry
  allocations or static buffer rebuilds.
- **ID lookup**: Enter any sparse node ID in the inspector form to select and navigate
  to that neuron.
- **Node role**: Role displays the declared mapping group (e.g. `Sensory`, `Expansion_0`,
  `Output`), never speculative biological anatomy.
- **Neighbor navigation**: Displays in-degree and out-degree, and navigable neighbor
  lists with pagination (`Prev` and `Next`, 10 per page) to prevent truncation of
  high-degree nodes. Clicking any neighbor button immediately selects that neighbor.
- **Observed fire history**: Displays recent observed fire steps for the selected node,
  capped to a maximum capacity of 32 steps (`MAX_RECENT_STEPS`) within the current epoch.
- **Missing-data caveat**: "No observed fire does not mean inactive; fire means positive
  KC code, not biological spikes." Steps may also be omitted or dropped by bounded queues
  under load.
- **Explicit missing body IDs**: Body IDs are not exported in standard mappings and are
  explicitly reported as unavailable (`Body ID: not exported`), never inferred or
  fabricated.
- **Epoch reset**: Mapping replacements or disconnects reset selections and clear
  observed activity histories.
- **Future timeline and memory panels**: Timeline and memory backend integration issues
  will be linked in a follow-up PR later (no placeholder doc links are created).
## 6. Existing checkpoints and visualization configuration

Existing applications can continue using the frozen entry points in
[`../model/serve/README.md`](../model/serve/README.md). Create a trusted scratch
checkpoint using [`../model/README.md`](../model/README.md), then select it with
`--ckpt`. The initializer overwrites its output, so choose a new path. The
workflow runner instead creates its full model directly from bundled wiring.
Serving loads the implementation named by the checkpoint, regardless of the
build-selection environment variable. Legacy checkpoints without `impl` load as
`vibe`; executable files under `model/serve/` remain unchanged.

| Entry point | Visualization configuration |
|---|---|
| `harness.app_server` | `--port 8772` HTTP server for `/app/` static assets and `/health` + `/v1` reverse proxy. `--api-url http://127.0.0.1:8771` points to upstream model server. Loopback only. |
| `harness.workflow` | `--impl` / `FLYBRAIN_IMPL` select a fresh implementation; default `vibe`. Loopback only; `--port 0` selects a free port; `--path /stream` or another absolute path. `--serve` keeps inference running; omit it for the finite smoke. `--record PATH` is optional. |
| `model.serve.ask` | `--host 127.0.0.1 --port 8767 --path /stream --block 0`; `--port 0` chooses a free port. Visualization is enabled; there is **no `--no-viz` flag**. |
| `model.serve.serve` | `--port 8771` is the HTTP API port; `--viz-port 8767` is the separate stream port. Stream path is `/stream`. `--no-viz` disables the stream/recorder without disabling requests. |
| Standalone page | `http.server` selects the HTTP port; the endpoint field or `?ws=ws://127.0.0.1:<port>/<path>` selects the source. File mode needs no WebSocket. |

For the HTTP API, substitute your venv interpreter and trusted checkpoint path:

```console
python -m model.serve.serve --ckpt PATH_TO_CHECKPOINT --port 8771 --no-viz
```

Send normal `/v1/completions` or `/v1/chat/completions` requests as shown in the
[serving guide](../model/serve/README.md#requests). There should be no visualization
listener; successful real model completion remains available. An idle API
produces a mapping on harness connection but no fires until inference. Prompt
messages and token steps are different counts.

Visualization listeners are loopback-only. Page, API and stream ports are
separate. Do not stop someone else's process to free a port; leave existing
services on defaults 8765 and 8000 alone. Ctrl-C stops each server you started.

## 7. Troubleshooting and measured limits

| Symptom | Check |
|---|---|
| Prompt proxy unavailable / 503 | Ensure `harness.app_server` is running on 8772 and the model server is running on 8771. Bare `http.server` does not proxy model requests (static-page mode). Click Retry on the health indicator after starting upstream. |
| Stream cancellation behavior | Cancellation aborts the client request, causing `app_server` to close upstream. Upstream model server stops on its next token write; cancellation is best-effort with no wire cancel frame. |
| Inspector shows "no observed fire" | "No observed fire does not mean inactive; fire means positive KC code, not biological spikes." Fire indicates positive KC activation in the visualized block, not biological spikes or biological inactivity. |
| Body ID not exported | Standard model mappings do not include FlyWire/hemibrain body IDs. The inspector displays them explicitly as unavailable / not exported, never inferred. |
| Unsupported mapping version | The receiver stops the source and reports logical code 1003. Browser JavaScript sends wire code **4001**, reason `Unsupported protocol version`, because it cannot call `close(1003)`. Choose a compatible source; automatic retries stop. |
| WebGPU unavailable | Use capable Chrome/Edge with an enabled adapter/driver, and serve on secure loopback `http://127.0.0.1`. Read the GPU status. Protocol/file inspection works without drawing; tests cannot establish hardware support. |
| Repeated connection failure | Keep both processes running. Use the exact printed port **and path**. Wrong paths close with 1008. Choose a free port for conflicts. HTTP page URLs and WebSocket source URLs differ. |
| Mapping but no activity | An idle API is not inference. Send a request or use the continuous workflow source. A prompt produces many token-step fires. Dense graphs may need zoom to inspect arrows. |
| Missing steps | Bounded queues drop whole fires under load; reconnects discard missed activity. Gaps in `t` are allowed. `Dropped messages` counts malformed/rejected messages, not missing sequence numbers; `Undeclared pairs` counts filtered pairs. A mapping replacement restarts ordering and counters. |
| Background tab clears graph | Live mode disconnects while hidden, then reconnects mapping-first when visible. Manual Disconnect or file selection cancels resumption. Recording delivery continues at its cadence while GPU drawing is suspended. |

[`PERFORMANCE.md`](PERFORMANCE.md) includes raw measurements and reproduction.
The actual **1,958-node / 19,037-edge** graph ran at synthetic **120 fires/s for
120 seconds** on the target CPU/Radeon machine with zero server drops. This is
an observed operating point, not a maximum or measured inference throughput.
Default server/client queues hold 64 messages each; the recorder holds 256,
plus in-progress work. Activity uploads coalesce per frame; GPU submissions are
gated. Static geometry is not rebuilt per fire. Layout still takes roughly 60 ms
per installed mapping on the measured machine. Browser-native buffers during
blocked JavaScript remain outside application control. No multi-day wall-clock
soak, CUDA extraction or hardware sleep/resume check has been performed.

## 8. Target-machine verification

Registry integration was checked on 2026-10-21 on the Windows/Radeon machine
with both `--impl vibe --path /vibe` and `--impl vibe2 --path /vibe2`. Each ran
the full 12-layer, width-384 untrained CPU model against bundled 54-glomerulus
wiring. Both drew 1,958 nodes and 19,037 edges with visible real-model activity,
mapping-epoch resets, zero rejected messages/undeclared pairs and no GPU
warnings/errors. Switching sources cleared the previous scene. `vibe2`
continued inference while disconnected and reconnected at step 13 with one
accepted fire in fresh receiver epoch 0. A genuine pre-registry checkpoint
without an `impl` field also loaded as `vibe`.

Both full local CI smoke paths initialized a checkpoint, exported its mapping,
loaded it through frozen serving, recorded actual inference, and generated a
44-fire/two-epoch workflow capture with identical tokens after hook removal.
Each fresh capture passed the JavaScript playback/layout/activity check. With
the model sources stopped, both files completed all 46 lines in the browser at
epoch 1 / step 10 / 11 accepted fires. These are fresh untrained models, not
the private trained checkpoint or its 55-glomerulus import; no private-weight
parity or CUDA result is claimed.

Historical `vibe` verification on 2026-10-21 on the Windows/Radeon development machine:

- [x] Live mapping-first delivery in the standalone WebGPU browser.
- [x] Actual full-model fires in increasing `t` order and visible highlights.
- [x] Disconnect/reconnect while the real model keeps running.
- [x] Actual mapping refresh, complete scene reset and restarted ordering.
- [x] Checked-in recording playback with no model process or model dependencies.
- [x] Real HTTP completion with `--no-viz` and no visualization listener.

The live check used a custom `/activity` path: initial mapping arrived with zero
accepted fires, successive steps increased, reconnect resumed at step 28 with a
new receiver epoch 0, and a later replacement was observed at step 0. No GPU
errors or filtered pairs were observed. The offline page server ran in a fresh
stdlib-only venv with no PyTorch, NumPy, tokenizer or WebSocket package; after the
model stopped, the checked-in file completed at epoch 1, step 10 and 11 fires,
and Restart returned to epoch 0. A scratch untrained checkpoint also served a
real HTTP completion with `--no-viz`; its only listener was the HTTP API.

### Verification commands

With test dependencies installed, run from the repository root:

```console
python -m pytest -q
python -m pytest test/test_app_server.py
npm --prefix harness/app test
```

These commands exercise:
- Python model, serve, stream, and app server reverse proxy tests (including 10 observed tests in `test/test_app_server.py`).
- Browser harness tests (`harness/app/test/`) covering `generation.test.js`, `prompt-view.test.js`,
  `inspector.test.js`, GPU picking, and v1 protocol conformance.
Follow the [app guide](app/README.md#manual-verification-instructions) for manual two-terminal
browser checks with a live model server. Browser checks exercise actual WebGPU and user
controls rather than treating protocol tests as rendering proof.
