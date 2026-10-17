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
`tiktoken` loads GPT-2 encoding data, so its first use may require a download
unless that data is cached.

| File | Behavior covered |
|---|---|
| `test/test_data.py` | GPT-2 story encoding, literal EOT handling, uint16 binary round trip, and next-token batches |
| `test/test_model.py` | Sparse address codes, masked gradients, memory, causality, step/forward agreement, greedy generation, checkpoint loading, and one-batch optimization |
| `test/test_serve.py` | Model listing, completions, chat, SSE output, and request errors against a real local HTTP server |
| `test/test_viz_stream.py` | Mapping/fire invariants, live streaming and recording, session continuity, mid-run joins, no listeners, and slow-client drops |

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
