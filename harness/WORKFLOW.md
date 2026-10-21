# Real model to browser: reproducible workflow

Run every command from the repository root. The standalone harness in `app/`
only displays validated graph/activity data. It has no prompt UI; that belongs
to #13. Live activity here comes from actual PyTorch model hooks. The model is
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
is used after checkout; `websockets` is unnecessary for file playback.

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
The browser has no npm dependencies. Node.js 22+ is needed only to run its tests.

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

## 5. Existing checkpoints and visualization configuration

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

## Troubleshooting and measured limits

| Symptom | Check |
|---|---|
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

## Target-machine verification

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

With test dependencies installed, run from the repository root:

```console
python -m pytest -q
npm --prefix harness/app test
```

The headless smoke complements these tests; browser checks exercise actual
WebGPU and user controls rather than treating protocol tests as rendering proof.
