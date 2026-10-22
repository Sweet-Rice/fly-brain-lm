# Tests

Run commands from the repository root, not from `test/`. Install the model/test
dependencies described in the [root setup guide](../README.md#run-the-real-model-or-tests).

## Run the suite

```bash
.venv/bin/python -m pytest -q test
```

To select a subset, pass one of the test file paths below instead of `test`.
No saved checkpoint, external connectome download, prepared `train.bin`/`val.bin`,
GPU, or pre-existing model/API server is required. Tests build CPU models with
`Wiring.random()` or the bundled `data/connectome/wiring.npz`, and use temporary
paths for recordings and checkpoints. The workflow tests require that bundled
wiring file.
Contract tests use `jsonschema` against the checked-in Draft 2020-12 schemas and
fixtures. `tiktoken` loads GPT-2 encoding data, so its first use may require a
download unless that data is cached.

| File | Behavior covered |
|---|---|
| `test/test_data.py` | GPT-2 story encoding, literal EOT handling, uint16 binary round trip, and next-token batches |
| `test/test_vibe_model.py` | Vibe implementation: sparse address codes, masked gradients, memory, causality, step/forward agreement, greedy generation, checkpoint loading (including `"impl"`), and one-batch optimization |
| `test/test_vibe2_model.py` | vibe2 (fly-dopamine) implementation: step/forward agreement, logits invariant under the importer's KC permutation, one KC-code output per processed token during `stream`, alpha/beta dopamine cap, and checkpoint loading |
| `test/test_model_registry.py` | Implementation selection (`--impl`, `FLYBRAIN_IMPL`, default `vibe`), legacy checkpoints without `"impl"`, checkpoint dispatch to a second implementation, and rejection of unknown implementations or models missing the serving contract |
| `test/test_activity.py` | Exact positive-KC routes from real model outputs, batch-0/token/block boundaries, determinism, empty steps, unchanged logits and gradients, released activations, idle skips, and one host mask copy per observed address output |
| `test/test_activity_profile.py` | Registry-selected real-model overhead profile with disabled/idle/recording/live modes, identical logits, real consumers, zero drops, restored thread/RNG state and explicit unavailable-CUDA failure |
| `test/test_serve.py` | Model listing, completions, chat, SSE output, and request errors against a real local HTTP server |
| `test/test_app_server.py` | App server loopback binding, static asset confinement under `harness/`, rejection of directory traversal and repo secrets, root `/` redirect to `/app/`, proxy route whitelist (`GET /health`, `GET /v1/models`, `POST /v1/completions`, `POST /v1/chat/completions`), upstream unavailable 503 JSON, incremental SSE streaming without buffering, upstream socket closure on client abort, and memory-only `Authorization` header pass-through (10 observed tests) |
| `test/test_viz_stream.py` | Exact model-block topology and active-KC routing, schema-valid deterministic export across checkpoint round trips, invalid topology rejection, live streaming and recording, joins/reconnects, refreshed topology epochs, empty steps, and deterministic backpressure/drop recovery |
| `test/test_protocol_contract.py` | Portable v1 JSON Schemas, valid lifecycle fixture, invalid receiver cases, mapping epochs, and semantic id/reference constraints |
| `test/test_workflow.py` | Both built-in implementations through full real-wiring CPU inference over real sockets, reconnects, replacement epochs, disabled-hook token equality, implementation-aware provenance, and overwrite protection |
| `test/test_workflow_reference.py` | Checked-in real-model workflow recording, provenance digest, schemas, declared edges, and restarted step ordering across replacement mappings; no model import required |
## Continuous integration

[GitHub Actions CI](../.github/workflows/ci.yml) runs independent checks on PRs,
pushes to `main`, and manual dispatches. The Python checks use CPU-only PyTorch;
the separate browser-harness check uses Node.js without model dependencies:

| Check | Scope |
|---|---|
| Data/tokenization | `test/test_data.py` |
| Model/core | All tests under `test/` except the dedicated data, HTTP API, and graph/WebSocket suites; new model modules are included automatically |
| HTTP API & App server proxy | `test/test_serve.py` and `test/test_app_server.py` (10 tests) |
| Graph/WebSocket | `test/test_viz_stream.py` and `test/test_protocol_contract.py` |
| Smoke (vibe / vibe2 checkpoint, serve, record) | Independent jobs for both implementations: build a real-wiring checkpoint, export and schema-validate its mapping, compare it with real inference's recorded mapping, run the finite workflow, then feed its fresh recording through the shipped JavaScript playback, receiver, graph layout and edge activity |
| Browser harness | Actual JavaScript receiver against shared v1 fixtures, live/file parity, recording play/pause/restart/speed and error states, reconnects, cancellation, graph layout, activity highlights, camera navigation, static GPU buffers, node picking and overlay selection, neuron inspector topology indexing and bounded fire history, prompt composer validation and rejection, state transitions, SSE stream parsing, and error handling; see [`harness/app/README.md`](../harness/app/README.md) |
The jobs have no dependency edges. A failed suite does not cancel the other
suites or skip the smoke check. Each test job prints individual cases and adds
their results, timings, and failure details to the run's **Summary** page;
downloadable `junit-*` artifacts contain the machine-readable reports.
`smoke-outputs-vibe` and `smoke-outputs-vibe2` contain each model's standalone
mapping, prompt output, recording, and viewer
output, plus the workflow recording, Python and JavaScript run logs, and
provenance/SHA-256 metadata.
The checkpoint is not uploaded. Reports are uploaded even when a check fails.

The backpressure test deliberately holds one client's server-side WebSocket
send, fills its bounded queue, and verifies drops, producer progress, unaffected
delivery to another client, recovery, and a complete recording. It does not rely
on OS socket-buffer sizes or a sub-50-ms scheduling deadline.
The workflow graph shows suites, not individual test cases or proof of browser
rendering. Run the full local suite with the command above; the smoke script can
also be run from the repository root with
`PYTHON=.venv/bin/python .github/scripts/smoke.sh`.

### JavaScript harness test suites (`harness/app/test/`)

Run with Node.js 22+:

```bash
npm --prefix harness/app test
```

Or directly with Node's native test runner:

```bash
node --test harness/app/test/*.test.js
```

The browser-harness CI job also checks the [UI inference contract v1](../harness/app/inference-contract/v1/README.md).
The shared fixture is exercised through `GenerationController` with fragmented
Unicode SSE data. TypeScript validates the actual service client, declarations,
fixture, and consumer examples; no production bundle is generated:

```console
npm --prefix harness/app ci --ignore-scripts
npm --prefix harness/app run typecheck
```

Lifecycle regressions cover late preparation failures after cancellation,
validation subscribers that dispose or replace the run, and rejected submission
or polling after disposal. They assert terminal state, request suppression, and
new-run ownership rather than implementation wiring.
They also preserve completion/error results when terminal subscribers start a
new run, and prevent old cancellation callbacks from overwriting a newer
validation failure.

| Suite | Scope covered |
|---|---|
| `generation.test.js` | Parameter validation and rejection (empty/whitespace rejection, bounds validation for `max_tokens` [1..128], `temperature` [0..2], and `top_k` [1..50257]; upstream server cap is separate), inference state machine transitions (`idle`, `validating`, `submitting`, `streaming`, `cancelling`, `completed`, `cancelled`, `failed`), SSE line and JSON chunk parser, usage chunk handling, terminal `[DONE]` detection, UTF-8 multi-byte split handling across chunk boundaries, malformed/truncated stream error recovery with preserved partial text, cancellation abort signal handling, reader lock release, health readiness checks and retry, normalized API key header sync, actionable proxy errors (501/405/503), traceback sanitization, and terminal accessibility announcements |
| `prompt-view.test.js` | DOM rendering with stable `prompt-*` IDs and accessible announcements, keyboard shortcut `Ctrl+Enter` / `Cmd+Enter` (ignores repeat keydown, preserves newlines and IME composition), Generate, Cancel, Clear, and Copy buttons lifecycle, Copy button clipboard interaction via `navigator.clipboard.writeText` with rapid feedback timer reset, Clear action resetting prompt input and output when idle (disabled during generation), readiness gating of submission, manual health retry button with typed API key sync and clearing, error banner display, terminal status announcements with accurate Unicode codepoint counting, and safe disposer cleanup |
| `inspector.test.js` | Sparse node ID indexing, incoming/outgoing degree and neighbor list computation, neighbor list pagination without truncation (`Prev` and `Next`, 10 per page), self-loop activity deduplication per step, bounded per-node recent observed fire history capped at 32 steps (`MAX_RECENT_STEPS`) within the current epoch, epoch reset and mapping replacement clearing stale selections and histories, keyboard selection form, custom event dispatch (`select-node` and `node-select` without echo loops), explicit `Body ID: not exported` status, role display from declared group, and plain-words missing-data caveat ("No observed fire does not mean inactive; fire means positive KC code, not biological spikes") |
| `gpu.test.js` & `layout.test.js` | Node picking under camera pan/zoom transformations, drag vs click threshold differentiation, background click clearing selection, dynamic selection ring and incident edge overlay rendering without per-frame allocations, and selection events prior to GPU readiness |
| `protocol.test.js` | Shared v1 contract fixtures, action outputs, invalid line and version handling |
| `sources.test.js` & `playback.test.js` | Live WebSocket and file stream ingestion, cadence pacing, pause/play/restart, gap handling, and replacement mappings |
| `activity.test.js` & `camera.test.js` & `renderer.test.js` | Highlight decay, reduced motion, camera pan/zoom/fit coordinate math, WGSL pipeline upload, and burst buffer reuse |

## Network and visual checks

The HTTP and WebSocket tests bind loopback on automatically assigned ports
(`port=0`). They do not need to take ports 8000 or 8765 away from another process.
The environment must allow local socket binding.

The suite uses a Python WebSocket client; it does **not** prove that a browser
page renders correctly. Follow the [standalone WebGPU workflow](../harness/WORKFLOW.md#4-exercise-the-live-browser-workflow)
for live and offline visual checks, and the [stream API verification instructions](../harness/API.md#84-verification-after-any-model-change)
when changing the model/stream adapter.

Before running API §8.4's V2 check, stop the recorded replay if it is using 8768:
V2 binds that same port. Reuse an existing page server on 8770 rather than starting
a second one there.
