# Fly Brain LM

An experimental, **untrained** language model whose activity can be streamed to a
browser over WebSocket. Generated text is not expected to be useful. For harness
UI development, use the bundled replay instead of running the model.

Run the commands below from the repository root. Use module invocations
(`python -m ...`), not direct paths to Python source files.

## Start with the recorded example

This path needs only Python and `websockets`: no PyTorch, checkpoint, GPU, or data
download. The recording is already included in the repository.

For a fresh checkout, create the environment and install the replay dependency.
If `.venv` already exists, reuse it rather than recreating it:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install websockets
```

Terminal A — replay the real captured prompt **`Once upon a time`**:

```bash
.venv/bin/python -m harness.replay_prompt
```

Terminal B — serve the example page (skip if it is already served on 8770):

```bash
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open **http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream**.
Expect `connected` and a graph. Playback repeats automatically; there is no prompt
to type. Keep both terminals running. Ctrl-C stops each server.

The page server and stream source are separate processes. Starting the page
server alone does not start a replay or model. A disconnected page with zero
nodes has not received a mapping; see the [browser troubleshooting guide](harness/example/README.md).

## Run the real model or tests

The model/data tools additionally use PyTorch, NumPy, pandas, PyArrow, and
`tiktoken`. Tests use `pytest`. A CPU-only PyTorch install is sufficient for the
documented examples:

```bash
.venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install numpy pandas pyarrow tiktoken websockets pytest
```

For another platform or GPU build, use the [PyTorch installation selector](https://pytorch.org/get-started/locally/).
Package installation requires network access. The first GPT-2 tokenizer load may
also download encoding data; replay alone does not load the tokenizer.

- [Initialize a checkpoint](model/README.md). A fresh checkout has bundled wiring,
  but **no checkpoint**: `model/checkpoints/` is gitignored. Do not overwrite an
  existing trained checkpoint when creating an untrained example.
- [Run terminal chat or the HTTP API](model/serve/README.md). These use a real
  checkpoint and generate a live visualization stream.
- [Run the tests](test/README.md). Tests use generated wiring and temporary files;
  they do not require a saved model or the full connectome download.
- [Prepare or rebuild data](data/README.md). The large connectome download and
  TinyStories preparation are optional for the replay and existing bundled wiring.

## Folder guides

| Folder | Documentation |
|---|---|
| `harness/` | [Replay options, recordings, and terminal viewer](harness/README.md) |
| `harness/example/` | [Browser page, connection URLs, and troubleshooting](harness/example/README.md) |
| `model/` | [Checkpoint initialization and model prerequisites](model/README.md) |
| `model/serve/` | [Terminal chat, HTTP API, and live visualization](model/serve/README.md) |
| `data/` | [Bundled wiring, optional downloads, and token data](data/README.md) |
| `test/` | [Test command, coverage, and runtime requirements](test/README.md) |

The formal wire contract and model migration policy are in [harness/API.md](harness/API.md).

## Ports in these guides

| Example service | Loopback port |
|---|---:|
| Recorded replay WebSocket | 8768 |
| Browser page HTTP | 8770 |
| Live chat or API visualization WebSocket | 8767 |
| Model HTTP API | 8771 |

These are documentation examples, not changes to the program defaults. Chat and
API examples share visualization port 8767, so run one live source at a time.
Do not stop someone else's process to free a port: select another port with the
relevant flag and update the browser/client URL. In particular, leave existing
services on 8765 and 8000 alone.
