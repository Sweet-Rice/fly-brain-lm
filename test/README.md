# Tests

Run commands from the repository root, not from `test/`. Install the model/test
dependencies described in the [root setup guide](../README.md#run-the-real-model-or-tests).

## Run the suite

```bash
.venv/bin/python -m pytest -q test
```

To select a subset, pass one of the test file paths below instead of `test`.
No saved checkpoint, real connectome files, prepared `train.bin`/`val.bin`, GPU,
or running model/API server is required. The tests build CPU models with
`Wiring.random()` and use temporary paths for recordings and checkpoints.
Contract tests use `jsonschema` against the checked-in Draft 2020-12 schemas and
fixtures. `tiktoken` loads GPT-2 encoding data, so its first use may require a
download unless that data is cached.

| File | Behavior covered |
|---|---|
| `test/test_data.py` | GPT-2 story encoding, literal EOT handling, uint16 binary round trip, and next-token batches |
| `test/test_model.py` | Sparse address codes, masked gradients, memory, causality, step/forward agreement, greedy generation, checkpoint loading, and one-batch optimization |
| `test/test_serve.py` | Model listing, completions, chat, SSE output, and request errors against a real local HTTP server |
| `test/test_viz_stream.py` | Exact model-block topology and active-KC routing, schema-valid deterministic export across checkpoint round trips, invalid topology rejection, live streaming and recording, joins/reconnects, refreshed topology epochs, empty steps, and deterministic backpressure/drop recovery |
| `test/test_protocol_contract.py` | Portable v1 JSON Schemas, valid lifecycle fixture, invalid receiver cases, mapping epochs, and semantic id/reference constraints |
| `test/test_workflow.py` | Full real-wiring CPU inference over real sockets, reconnects, replacement epochs, disabled-hook token equality, recording provenance, and overwrite protection |
| `test/test_workflow_reference.py` | Checked-in real-model workflow recording, provenance digest, schemas, declared edges, and restarted step ordering across replacement mappings; no model import required |

## Continuous integration

[GitHub Actions CI](../.github/workflows/ci.yml) runs independent checks on PRs,
pushes to `main`, and manual dispatches. The Python checks use CPU-only PyTorch;
the separate browser-harness check uses Node.js without model dependencies:

| Check | Scope |
|---|---|
| Data/tokenization | `test/test_data.py` |
| Model/core | All tests under `test/` except the dedicated data, HTTP API, and graph/WebSocket suites; new model modules are included automatically |
| HTTP API | `test/test_serve.py` |
| Graph/WebSocket | `test/test_viz_stream.py` and `test/test_protocol_contract.py` |
| Smoke (checkpoint, serve, record) | Build a real-wiring checkpoint, export and schema-validate its mapping, compare it with real inference's recorded mapping, inspect the NDJSON recording, and run the finite end-to-end workflow with a replacement mapping and provenance metadata |
| Browser harness | Actual JavaScript receiver against shared v1 fixtures, live/file parity, recording play/pause/restart/speed and error states, reconnects, cancellation, graph layout, activity highlights, camera navigation, static GPU buffers and device lifecycle; see [`harness/app/README.md`](../harness/app/README.md) |

The jobs have no dependency edges. A failed suite does not cancel the other
suites or skip the smoke check. Each test job prints individual cases and adds
their results, timings, and failure details to the run's **Summary** page;
downloadable `junit-*` artifacts contain the machine-readable reports.
`smoke-outputs` contains the standalone mapping, prompt output, recording, and viewer
output, plus the workflow recording, run log, and provenance/SHA-256 metadata.
The checkpoint is not uploaded. Reports are uploaded even when a check fails.

The backpressure test deliberately holds one client's server-side WebSocket
send, fills its bounded queue, and verifies drops, producer progress, unaffected
delivery to another client, recovery, and a complete recording. It does not rely
on OS socket-buffer sizes or a sub-50-ms scheduling deadline.

The workflow graph shows suites, not individual test cases or proof of browser
rendering. Run the full local suite with the command above; the smoke script can
also be run from the repository root with
`PYTHON=.venv/bin/python .github/scripts/smoke.sh`.

## Network and visual checks

The HTTP and WebSocket tests bind loopback on automatically assigned ports
(`port=0`). They do not need to take ports 8000 or 8765 away from another process.
The environment must allow local socket binding.

The suite uses a Python WebSocket client; it does **not** prove that a browser
page renders correctly. Follow the [browser example guide](../harness/example/README.md)
for a visual smoke check, and the [stream API verification instructions](../harness/API.md#84-verification-after-any-model-change)
when changing the model/stream adapter.

Before running API §8.4's V2 check, stop the recorded replay if it is using 8768:
V2 binds that same port. Reuse an existing page server on 8770 rather than starting
a second one there.
