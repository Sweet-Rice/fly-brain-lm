# Fly Brain LM

Experimental PyTorch fly-brain language models with an integrated browser workspace
pairing WebGPU activity inspection with a prompt composer and neuron inspector. The
registry includes the legacy `vibe` scaffold and the `vibe2` fly-dopamine
implementation. Fresh initializations are **untrained**; their generated text has no
quality claim.

## Start the live vibe2 workspace

Install the [model dependencies](harness/WORKFLOW.md#2-install-the-real-model-dependencies),
then run from the repository root. Trained checkpoints are private and are not
bundled. [Import the original TinyStories weights with their matching wiring](model/README.md#vibe2-trained-fly-dopamine-weights),
then launch:

```console
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771 --model-ckpt model/checkpoints/vibe2_tinystories.pt --viz-port 8767 --model-id vibe2-tinystories
```

Do not run `model.init_model` against that checkpoint: it overwrites its output
with random, untrained weights. For an untrained smoke model, use the separate
scratch-path example in the [workspace guide](harness/app/README.md).

Open **http://127.0.0.1:8772/app/** in a WebGPU-capable Chrome or Edge browser.
No query string, endpoint field, or Connect button is needed. The app server owns
one telemetry-enabled model child and supplies the browser's graph binding via
`/app-config`. Its HTTP inference API, graph activity, and producer token metadata
come from that same child. Ctrl-C stops both processes.

The page connects before generation. Wait for `vibe2-tinystories`, the live
connection status, and **1,959 nodes / 19,037 edges**, then enter a prompt.
Generate requires both a healthy API and an accepted live mapping. The launcher
reports loading/exited failures and the checkpoint basename/SHA-256; it does not
silently substitute a recording or another backend.

## Browser workspace

- **Graph**: Real activity, camera pan/zoom/fit, and node picking. Accepted pairs
  light the directed edge and both endpoints for 600 ms; inactive topology stays
  translucent. The layout is schematic, not anatomical coordinates.
- **Prompt**: One textarea above paginated output, with **Generate**, **Stop**, and
  **Copy**. `Ctrl+Enter` / `Cmd+Enter` submits without swallowing ordinary newlines
  or IME composition. New generation replaces old output; Copy preserves the full
  Unicode output across pages. Stop preserves partial text and closes the upstream
  connection, with best-effort termination on the model's next write.
- **Neuron**: Actual mapped-ID lookup, Identity / Links / Activity, paginated
  directed neighbors, and up to 32 observed steps per neuron. Missing body IDs
  remain explicitly unavailable; observed fires are not biological spikes.
- **No control-panel setup**: Source and Settings screens, manual endpoints,
  playback controls, parameter/API-key fields, redundant retry/clear buttons, and
  frontend run IDs are absent. Model/checkpoint identity, usage, finish reason,
  and connection state are read-only. Health polling and stream reconnection are
  automatic.
- **MBON → decoded text**: Actual MBON nodes connect to a readout hub and decoded
  text on the graph. Producer telemetry supplies real token IDs and
  processed/unprocessed status, including a potentially unprocessed last sample.
  Dashed paths are architectural links, not per-MBON word attribution or
  biological synapses. Legacy mappings without MBONs do not gain invented nodes.
- **One viewport**: Graph and workbench share wide screens; Graph / Prompt / Neuron
  switch the visible pane on narrow screens. Long output and neighbor lists are
  paged instead of placed in scrolling panels.

The checkpoint selects `vibe` versus `vibe2`; `--model-id` is only a label.
Fresh checkpoints are **untrained**. The frozen engine under `model/serve/`
remains untouched. The no-build frontend keeps public mount/dispose functions,
DOM-free controllers, and the portable
[v1 inference contract](harness/app/inference-contract/v1/README.md).

See the [workspace guide](harness/app/README.md) for an explicit proxy-only setup,
binding/port rules, reusable client APIs, and troubleshooting. The app server is
loopback by default; `--host 0.0.0.0` opts into trusted-network access. It is not
public secure hosting. Choose free ports rather than stopping someone else's service.

<a id="start-with-the-recorded-example"></a>

## Review a recording without a model

Use the separate [Canvas example](harness/example/README.md) and recorded-stream
replay. This path needs Python and `websockets`, but no checkpoint, PyTorch,
tokenizer, Node.js, or running inference model:

```console
python -m pip install websockets
python -m harness.replay_prompt harness/recordings/reference.ndjson --port 8768
```

In another terminal:

```console
python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open **http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream**. This is the separate
recorded Canvas viewer, not the live `/app/` workspace. The reference contains
real untrained-model events and adjacent provenance
[metadata](harness/recordings/reference.ndjson.metadata.json); replay timing is
synthetic. There is no file picker or playback setup in the live app.

## Run the real model or tests

The [workflow guide](harness/WORKFLOW.md) contains Windows PowerShell and POSIX
setup commands, a headless smoke command, a live model-to-browser demonstration,
reconnect and mapping-replacement checks, reference-recording provenance, and
troubleshooting. It uses the bundled wiring, so no large connectome download or
existing checkpoint is required. Installing model packages and the first
tokenizer load can require network access.

For existing checkpoint users, see [model initialization](model/README.md) and
[terminal chat / HTTP API](model/serve/README.md). The HTTP API supports
`--no-viz` to run normally without the visualization stream. The harness never
substitutes a recording for a failed production model.

The model registry keeps `vibe` as the default scaffold and adds `vibe2`, the
fly-dopamine implementation from PR #35. Both can run the same checkpoint-free
workflow with `--impl vibe` or `--impl vibe2`. Fresh builds are untrained; no
private trained checkpoint is bundled or independently verified here. See
[implementation selection and checkpoint compatibility](model/README.md#choosing-an-implementation).

## Folder guides

| Folder | Documentation |
|---|---|
| `harness/` | [End-to-end workflow](harness/WORKFLOW.md), [stream tools](harness/README.md), [measured limits](harness/PERFORMANCE.md) |
| `harness/app/` | [Bound live WebGPU workspace: graph, prompt, and neurons](harness/app/README.md) |
| `harness/example/` | [Separate legacy Canvas demo and fixed-prompt replay](harness/example/README.md) |
| `model/` | [Checkpoint initialization and model prerequisites](model/README.md) |
| `model/vibe/`, `model/vibe2/` | [Model implementations and selection](model/README.md#choosing-an-implementation) |
| `model/personal/` | [Writing your own model](model/README.md#personal-model) |
| `model/serve/` | [Terminal chat, HTTP API and visualization flags](model/serve/README.md) |
| `data/` | [Bundled wiring, optional downloads and token data](data/README.md) |
| `test/` | [Tests, coverage and runtime requirements](test/README.md) |

The normative wire contract, portable schemas and conformance fixtures are in
[`harness/protocol/v1/`](harness/protocol/v1/). Model integration and migration
policy are in [`harness/API.md`](harness/API.md).

The [visualization epic acceptance guide](harness/ACCEPTANCE.md) maps issue #23's
criteria to implementation, tests, browser evidence and pending child PRs.

<a id="ports-in-these-guides"></a>

## Ports in the guides

| Service | Loopback port |
|---|---:|
| App server HTTP (static assets + `/health` and `/v1` proxy) | 8772 |
| Model HTTP API | 8771 |
| Existing chat or API visualization WebSocket | 8767 |
| Workflow live WebSocket | Chosen by the OS with `--port 0`; use the printed URL |
| Legacy recorded replay WebSocket / Canvas page | 8768 / 8770 |
Run one source per stream port. If a port is occupied, choose another and update
the app-server configuration (or the separate Canvas viewer URL); do not stop
someone else's process. Leave existing services on the program defaults, 8765
and 8000, alone.
