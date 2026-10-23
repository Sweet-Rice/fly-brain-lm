# Real model to browser: reproducible workflow

Run every command from the repository root. The integrated browser workspace in `app/`
combines WebGPU activity inspection with an in-browser prompt composer and neuron
inspector. Live activity here comes from actual PyTorch model hooks. The model is
**untrained**, so its generated text has no quality claim.

## 1. Offline review from a clean checkout

Use the separate Canvas viewer for recording review. It needs Python and
`websockets`, but no checkpoint, PyTorch, tokenizer, Node.js, or running model.

```console
python -m pip install websockets
python -m harness.replay_prompt harness/recordings/reference.ndjson --port 8768
```

In another terminal:

```console
python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open **http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream**. Keep both
processes running; Ctrl-C stops them. This is the separate recorded Canvas viewer,
not the live `/app/` workspace. The live app has no file picker or playback
settings. Replay uses loopback only and needs no external network after setup.

The reference contains five groups, **1,958 nodes and 19,037 directed edges**.
Its adjacent [metadata](recordings/reference.ndjson.metadata.json) identifies the
real model, wiring, generation settings, and recording digest. There are **two
mappings and 44 actual fires**: 33 at `t=0..32`, then a refreshed mapping and 11
at `t=0..10`. Mapping replacement clears the previous graph activity; replay loops
after the final frame. Timing is synthetic. This artifact is never substituted
for a failed production model. The older
[`example/once_upon_a_time.ndjson`](example/once_upon_a_time.ndjson) remains an
immutable legacy fixture; see the [Canvas guide](example/README.md).

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

For graph-only inspection, leave the Canvas page server from step 1 running and
stop its recorded replay. Start a continuous real-model source:

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m harness.workflow --serve --port 0 --path /stream
```

POSIX shell:

```bash
.venv/bin/python -m harness.workflow --serve --port 0 --path /stream
```

Use the exact printed stream URL in the separate Canvas viewer URL:
`http://127.0.0.1:8770/?ws=ws://127.0.0.1:<printed-port>/stream`.
`--port 0` reserves a free port; the printed port is the actual one, not zero.
The source stays running until Ctrl-C and repeatedly processes the same prompt
with real greedy inference. Its hook spaces token steps by 100 ms for inspection;
a one-second pause separates rounds. This pacing is not inference throughput.
Generated text is labeled untrained in the terminal.

For `vibe2`, add `--impl vibe2`. Stop one source before starting the other.

| Scenario | What to do | Expected browser result |
|---|---|---|
| Mapping first | Open the viewer with the printed stream URL. | Connected status, mapping version 1, five groups, 1,958 nodes and 19,037 edges. No fire is accepted before a mapping. |
| Real inference | Observe successive steps. | Last `t` and fires received increase, and declared edges brighten. Invalid pairs remain zero in a normal local run. |
| Reconnect during inference | Refresh the viewer while the source continues. | A fresh mapping precedes new fires; old activity clears. The next `t` may be above zero; missed live activity is not replayed. |
| Mapping replacement | Stay connected for three inference rounds. | Each refreshed mapping rebuilds the graph and clears old highlights/counters before inference resumes at `t=0`. |
| Recorded review | Stop the live source, restart the step-1 replay, and open its viewer URL. | The checked-in topology and recorded events render without a model. Each replay loop starts from its mapping. |

Use the bound [integrated workspace below](#5-run-the-integrated-browser-workspace-prompting--graph-visualization)
for browser prompting and WebGPU inspection from one owned model.

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

The adjacent `.metadata.json` records provenance and the recording digest. Use a
distinct filename for each implementation; for example add
`--impl vibe2 --record /tmp/flybrain-vibe2.ndjson` on POSIX (or a new `$env:TEMP`
path on Windows). Review that file with `python -m harness.replay_prompt PATH`
and the separate Canvas viewer, not a live-app file picker. `--serve --record PATH`
also records a live session; stop it with Ctrl-C to finish the artifact.
Recording is optional and does not change inference. Its bounded writer can drop complete fires if
storage falls behind, producing valid `t` gaps rather than blocking the model.
This workflow requires a zero-drop run and fails if any were lost; a successful
metadata file records zero drops. See the terminal summary for the actual run.

## 5. Run the integrated browser workspace (prompting + graph visualization)

The live workspace uses one app-owned, telemetry-enabled model for inference,
graph activity, and producer token metadata. It does not ask the user to configure
independent browser connections.

Checkpoints are gitignored and not bundled. Initialize an untrained checkpoint at
a new path; never overwrite private trained weights:

```console
python -m model.init_model --impl vibe2 --out model/checkpoints/scratch-vibe2.pt
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --model-ckpt model/checkpoints/scratch-vibe2.pt --viz-port 8767 --model-id vibe2-untrained
```

Use your venv interpreter as in earlier steps. Open
**http://127.0.0.1:8772/app/** in WebGPU-capable Chrome or Edge. The bare URL
auto-connects before generation. Wait for the model ID, connected status, and
1,958-node / 19,037-edge mapping. Ctrl-C stops the app and its owned model child.

### Architecture and port safety

- **8772** serves the app, `/app-config`, and the same-origin `/health` + `/v1` proxy.
- **8771** is the owned model's HTTP/SSE API; **8767** is its graph stream.
- The child is `harness.telemetry.serve`; the frozen serving engine under
  `model/serve/` remains unchanged.
- `/app-config` supplies the same-origin `/stream` URL with no-store caching;
  the app relays it to the loopback model. There is no browser endpoint override
  or `?ws=` setup for `/app/`.
- Owned mode reports checkpoint loading, premature exit, and basename/SHA-256.
  `--model-id` is a label; the checkpoint determines the implementation.
- Use `--viz-port`, `--model-id`, and `--record` directly. `--model-arg` is for
  other model options, not overrides of the app-owned binding.
- Choose free ports rather than stopping someone else's process. Keep services
  on the model defaults, 8765 and 8000, untouched.
- The app binds loopback by default. `--host 0.0.0.0` permits network access,
  while the model API and visualization listener remain private. This is not
  authenticated public hosting; remote WebGPU drawing requires HTTPS.
- For an already-running model, the [app guide](app/README.md#an-already-running-model)
  shows explicit `--api-url` and `--viz-url` proxy-only configuration.

### Prompt in the workspace

- **Generate** submits a nonblank prompt; `Ctrl+Enter` / `Cmd+Enter` also works.
  Both API health and an accepted live mapping are required. Disconnection
  disables new generation; reconnect and health polling are automatic.
- **Stop** aborts the request and preserves partial text. It remains available
  during an active request even if the graph disconnects. The proxy closes the
  upstream connection; the model notices on its next write. Cancellation is best
  effort, not an authoritative acknowledgment.
- **Copy** copies the complete Unicode output, not only the visible page. A new
  generation replaces old output, so there is no separate Clear button.
- One textarea sits above paginated output. Page controls appear only when
  needed; output and controls stay within the viewport.
- Model/checkpoint health, usage, state, and finish reason are read-only.
  Source/Settings screens, generation tuning fields, API-key input, manual
  endpoint controls, redundant retry buttons, and frontend run IDs are absent.
  Programmatic inference clients retain their validated parameter/auth API.
- Actual MBONs connect to a decoded-text card through architectural readout
  links. Producer telemetry supplies real token IDs and processed/unprocessed
  status, not per-MBON word attribution. Local SSE fallback is explicitly
  labeled and does not invent token IDs or graph-step alignment.

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
| `harness.app_server` | Live `/app/`, `/app-config`, and same-origin `/stream`, `/health` + `/v1` proxies. Prefer `--model-ckpt` with `--api-url` and `--viz-port` for one owned model. Proxy-only mode requires explicit `--viz-url`; no guessed stream. Loopback by default; `--host 0.0.0.0` opts into network access. |
| `harness.workflow` | `--impl` / `FLYBRAIN_IMPL` select a fresh implementation; default `vibe`. Loopback only; `--port 0` selects a free port; `--path /stream` or another absolute path. `--serve` keeps inference running; omit it for the finite smoke. `--record PATH` is optional. |
| `model.serve.ask` | `--host 127.0.0.1 --port 8767 --path /stream --block 0`; `--port 0` chooses a free port. Visualization is enabled; there is **no `--no-viz` flag**. |
| `model.serve.serve` | `--port 8771` is the HTTP API port; `--viz-port 8767` is the separate stream port. Stream path is `/stream`. `--no-viz` disables the stream/recorder without disabling requests. |
| Separate Canvas page | `http.server` serves `harness/example` on 8770; its `?ws=` URL selects a live or recorded replay stream. This is not the live `/app/` workspace. |

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
- Python model, serve, stream, app binding, and reverse-proxy behavior.
- Browser harness tests (`harness/app/test/`) covering `generation.test.js`, `prompt-view.test.js`,
  `inspector.test.js`, GPU picking, and v1 protocol conformance.
Follow the [app guide](app/README.md#run-the-live-workspace-real-model--app-server)
for the owned-model browser launch. Browser checks exercise actual WebGPU and
user controls rather than treating protocol tests as rendering proof.
