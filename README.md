# Fly Brain LM

Experimental PyTorch fly-brain language models with an integrated browser workspace
pairing WebGPU activity inspection with a prompt composer and neuron inspector. The
registry includes the legacy `vibe` scaffold and the `vibe2` fly-dopamine
implementation. Fresh initializations are **untrained**; their generated text has no
quality claim.
<a id="start-with-the-recorded-example"></a>

## Start with the offline graph

From a clean checkout, only Python 3 and a WebGPU-capable Chrome or Edge browser
are needed. There is no frontend build, package installation, checkpoint, CUDA,
tokenizer download or running model for this path.

Run from the repository root:

```console
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

On systems where Python is named `python3`, use that name instead. Open
**http://127.0.0.1:8772/app/**, click **Or open a recording**, and choose
[`harness/recordings/reference.ndjson`](harness/recordings/reference.ndjson).
Expect five groups, **1,958 nodes and 19,037 directed edges**, followed by
brightening edges as recorded fires play. Use Pause, Play, Restart and Playback
speed to inspect the capture. Timing is synthetic; the events were generated
by the real untrained model. Keep the page server running; Ctrl-C stops it.
This works without `websockets`, PyTorch or Node.js. After checkout, the offline
demo needs no external network access. Serve it on loopback as shown, rather
than opening the HTML with `file://`. In this static offline mode, the prompt
composer detects that the local model proxy is unavailable (static-page mode),
while recording playback and graph controls continue to work normally.

## Browser workspace: prompt composer and live inspection

The browser workspace extends the no-build ES module architecture with public
mount functions (`mountPrompt`, `mountInspector`) that return clean disposers, backed
by DOM-free inference (`GenerationController`) and topology (`NeuronIndex`) classes.
Future UI ports (such as React) can import and reuse the same state machines and
indexing directly without provisional interface aliases (`.controller`, `.CLASSES`).
Existing visualization sources and receivers are unaffected and operate normally even
when the model API is missing or unstarted.

The frontend consumes [UI inference contract v1](harness/app/inference-contract/v1/README.md),
with portable TypeScript declarations and a checked, development-only session
fixture. The browser remains no-build; TypeScript is only a development checker.

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
- **Port safety**: Port **8772** serves static assets and provides same-origin reverse
  proxying for `/health` and `/v1` endpoints (defaulting 8772 -> 8771) to avoid browser
  CORS restrictions. Port **8771** is the model HTTP API. Port **8767** is the
  visualization WebSocket stream. Run one source per port; leave program defaults 8765
  and 8000 alone.
- **Local development proxy**: The app server reverse proxy is a loopback convenience
  to keep browser SSE/fetch same-origin, not a public secure hosting server. The
  upstream `model/serve/serve.py` remains frozen and untouched.
- **Implementation selection**: Selected via checkpoint initialization (default
  `init_model` writes `model/checkpoints/<impl>.pt`, e.g. `vibe.pt`, not `init.pt`; see
  [model initialization](model/README.md)), not through a runtime serving dropdown.
  Do not overwrite private trained checkpoints. The model server loads whichever
  implementation is declared in the checkpoint.
- **Prompt Composer**: Nonblank prompt editor with `Ctrl+Enter` / `Cmd+Enter` submit
  (without swallowing regular newlines or IME composition), Generate, Cancel, Clear,
  and Copy buttons. Clear resets both prompt input and output when inactive. Copy
  copies generated output only, preserving Unicode whitespace and rendering via
  `textContent` rather than HTML. Settings validate and reject invalid parameters:
  integer `max_tokens` (1..128; upstream server cap is separate), finite `temperature`
  (0..2), integer `top_k` (1..50257), and an optional memory-only API key with no storage
  persistence, normalized and synced to health checks. Model readiness queries `/health`
  with manual retry and safe unmount.
- **Cancellation**: Client abort closes the upstream HTTP connection; upstream detects
  the broken pipe on its next token write and terminates generation (best effort, no
  authoritative wire cancel acknowledgment).
- **Separate WebSocket stream**: The visualization WebSocket is configured separately
  (via `/?ws=ws://127.0.0.1:8767/stream` or the UI field). Tokens and graph fires stream
  over separate transports; never claim fire/token alignment, synced tokens, or known
  checkpoint revision / loading status.
- **Neuron Inspector**: Clicking a node picks it; dragging above the movement threshold
  pans the camera without selecting; clicking the background clears selection. Supports
  sparse ID input lookup, neighbor navigation with pagination for high-degree nodes,
  and capped observed fire history per node (up to 32 steps) within the current epoch.
  Neuron role reflects the declared mapping group (e.g. `Sensory`, `Expansion_0`, `Output`),
  never speculative anatomy. Body IDs are not exported in standard mappings and are
  explicitly displayed as unavailable / not exported (never inferred).
  "No observed fire does not mean inactive; fire means positive KC code, not biological spikes."
- **Future timeline and memory panels**: Timeline and memory backend integration issues
  will be linked in a follow-up PR later (no placeholder doc links are created).
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
| `harness/app/` | [Standalone WebGPU viewer, playback and controls](harness/app/README.md) |
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
| Standalone offline page HTTP (`http.server`) | 8772 |
| Model HTTP API | 8771 |
| Existing chat or API visualization WebSocket | 8767 |
| Workflow live WebSocket | Chosen by the OS with `--port 0`; use the printed URL |
| Legacy recorded replay WebSocket / Canvas page | 8768 / 8770 |
Run one source per stream port. If a port is occupied, choose another and update
the browser URL; do not stop someone else's process. Leave existing services on
the program defaults, 8765 and 8000, alone.
