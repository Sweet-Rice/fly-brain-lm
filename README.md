# Fly Brain LM

An experimental, **untrained** PyTorch language model whose activity streams to a
standalone WebGPU graph viewer. Generated text is not expected to be useful.
The visualization harness inspects activity; prompt UI work belongs to #13.

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
than opening the HTML with `file://`.

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
| Standalone page HTTP | 8772 |
| Workflow live WebSocket | Chosen by the OS with `--port 0`; use the printed URL |
| Legacy recorded replay WebSocket / Canvas page | 8768 / 8770 |
| Existing chat or API visualization WebSocket | 8767 |
| Model HTTP API | 8771 |

Run one source per stream port. If a port is occupied, choose another and update
the browser URL; do not stop someone else's process. Leave existing services on
the program defaults, 8765 and 8000, alone.
