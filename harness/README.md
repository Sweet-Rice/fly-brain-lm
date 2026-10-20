# Harness: visualization stream tools

The model streams its activity over WebSocket (`ws://127.0.0.1:<port>/stream`): a `mapping` describes the graph, and live `fire` messages name activated edges at processed token steps. This directory holds the server, tools that read the stream, and a browser example. The normative wire contract and portable fixtures are in [`protocol/v1/`](protocol/v1/).

All commands run from the repo root (`fly-brain-lm/`) with the project venv: `.venv/bin/python -m …`. Stop each long-running command with Ctrl-C.

| Path | Role |
|---|---|
| `viz_stream.py` | Stream server used by `model.serve.ask` and `model.serve.serve`. |
| `export_mapping.py` | Exports one checkpoint's actual model topology without opening a stream or browser. |
| `replay_prompt.py` | Replays the bundled "Once upon a time" recording. Does not load a model. |
| `watch_stream.py` | Terminal viewer for a live stream or an NDJSON recording. |
| `example/` | Browser example harness and the bundled recording. See [`example/README.md`](example/README.md). |
| `protocol/v1/` | Normative v1 specification, JSON Schemas, and conformance fixtures. |
| `API.md` | Model-side implementation guide, current graph details, and migration policy. |

Demo ports used across these docs: page 8770, replay 8768, live chat 8767, live API 8771 (its stream on 8767). Ports 8765 and 8000 are the model's defaults and may belong to someone's running model or API. Do not use them and do not stop processes on them.

## Fixed-prompt replay (no model needed)

`replay_prompt.py` serves a recorded stream of the real model processing "Once upon a time". It needs only Python and `websockets`; install it using the [root setup guide](../README.md#start-with-the-recorded-example). No model, checkpoint, PyTorch, or tiktoken is needed.

The bundled recording is `harness/example/once_upon_a_time.ndjson`: one v1 mapping (1958 nodes, 19037 edges) followed by 11 fires with `t` = 0..10. It is a permanent development fixture. Do not overwrite or delete it.

```bash
.venv/bin/python -m harness.replay_prompt
```

It prints the recording path, the message and fire counts, and the stream URL (`ws://127.0.0.1:8768/stream` by default).

Options:

| Argument | Default | Meaning |
|---|---|---|
| `recording` (positional) | `harness/example/once_upon_a_time.ndjson` | NDJSON file; its first line must be a mapping. |
| `--port` | `8768` | Loopback port on `127.0.0.1`. The path is always `/stream`. |
| `--interval` | `0.2` | Seconds before each fire. Synthetic timing. |
| `--pause` | `2.0` | Seconds between loops. |

Negative `--interval` or `--pause` values are rejected.

Behavior:

- Each connection gets its own playback. It starts with the mapping, then sends every fire in the recording.
- After the last fire the loop pauses, then repeats from the mapping. Each mapping resets the page's counters, so the bundled recording shows 11 fires per loop.
- A reconnecting or late-joining client starts again from the beginning, not from another client's position.
- JSON text is sent unchanged. `t` values and pairs come from the recording. Timing is synthetic, not inference latency.
- Replay does not respond to prompts. It is not a live model and does not simulate slow clients.

### Browser demo (two terminals)

Terminal 1, stream source:

```bash
.venv/bin/python -m harness.replay_prompt
```

Terminal 2, page server:

```bash
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open this URL in Chromium:

```
http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream
```

The `?ws=` value must match the replay's port. The page shows `connected`, 1958 nodes, and 19037 edges, then counts 0..11 fires per loop. See [`example/README.md`](example/README.md) for the expected counters, reconnect behavior, and troubleshooting.

### Terminal viewer on the replay

In a third terminal, while the replay runs:

```bash
.venv/bin/python -m harness.watch_stream ws://127.0.0.1:8768/stream --brief
```

## Terminal viewer

`watch_stream.py` prints what the harness reads from the stream. It is a debugging viewer, not a harness.

```bash
.venv/bin/python -m harness.watch_stream ws://127.0.0.1:8767/stream   # live: a running model on 8767
.venv/bin/python -m harness.watch_stream harness/example/once_upon_a_time.ndjson   # recording file
.venv/bin/python -m harness.watch_stream harness/example/once_upon_a_time.ndjson --brief
```

- With no argument, it connects to `ws://127.0.0.1:8765/stream`, the model's default port. Pass an explicit URL for the demo ports.
- The viewer retries connection failures for up to 60 s while a live source starts, then exits with `nothing listening at …`.
- It connects once. If the stream closes, it prints `stream closed` and exits. It does not reconnect.
- `--brief` prints only neuron types and connection counts, not the per-node list.
- Each `fire` line shows `t`, the number of connections that fired, and counts per type pair.

## Export a checkpoint mapping

With a [compatible checkpoint](../model/README.md#create-an-untrained-checkpoint), export the selected model block without running inference or opening a WebSocket:

```bash
.venv/bin/python -m harness.export_mapping --ckpt /tmp/fly-brain-init.pt --block 0 --out /tmp/fly-brain-mapping.ndjson
.venv/bin/python -m harness.watch_stream /tmp/fly-brain-mapping.ndjson --brief
```

The output is a one-line v1 mapping-only recording: ordered groups, contiguous node ids, and unique directed edges, with no weights or coordinates. It comes from the loaded model block's mask and lobe buffers rather than a separate wiring snapshot. `--block` defaults to 0. Use a scratch output path; an existing file is overwritten.

The same visualized topology exports identically across repeated exports and checkpoint round trips. For topology changes during a run, pause inference and call `stream.set_mapping(graph.refresh())` before resuming. This updates both the declared graph and routing used by the existing model hook; see [API §6.1](API.md#61-exporting-and-replacing-model-topology).

## Live model sources

Both live sources need the model dependencies and a compatible checkpoint. The commands below use the scratch checkpoint created by the [model initialization guide](../model/README.md#create-an-untrained-checkpoint). Run one live source at a time on the stream port.

| Source | Command | Stream |
|---|---|---|
| Terminal chat | `.venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767 --max-tokens 8` | `ws://127.0.0.1:8767/stream` |
| HTTP API | `.venv/bin/python -m model.serve.serve --ckpt /tmp/fly-brain-init.pt --viz-port 8767 --port 8771` | `ws://127.0.0.1:8767/stream` (API on 8771) |

`model.serve.ask` reads messages from the terminal. Ctrl-D ends the session. Each reply prints `steps t=A..B`, and `t` keeps counting across messages.

Connect the browser page or terminal viewer to the stream URL **before typing a chat message**; wait for the mapping first. Browser steps are in [`example/README.md`](example/README.md). For the HTTP source, connect first, then send a request using the [HTTP examples](../model/serve/README.md). Starting the API alone produces no fires.

## Record a different prompt

The bundled recording is fixed. With the [model dependencies and scratch checkpoint](../model/README.md) ready, record another prompt using unchanged `model.serve.ask` on a free port (`--port 0`). The output goes to `/tmp`, not the bundled fixture; an existing output file is overwritten.

```bash
.venv/bin/python -m model.serve.ask "Once upon a time" --ckpt /tmp/fly-brain-init.pt --port 0 --max-tokens 8 --temperature 0 --top-k 50 --seed 0 --record /tmp/prompt.ndjson </dev/null
```

- Change the quoted prompt as needed.
- `</dev/null` closes stdin, so `ask` exits after the first message.
- The recording normally contains the mapping and every emitted fire. Its bounded background writer never waits on file I/O in the model thread; if storage falls behind, complete fire messages are dropped and the resulting gaps in `t` remain valid.

Then replay it. Stop the default replay first (Ctrl-C in its terminal), because both use port 8768:

```bash
.venv/bin/python -m harness.replay_prompt /tmp/prompt.ndjson --interval 0.1 --pause 1
```

The page at `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream` reconnects on its own and shows the new mapping. No reload is needed.

When finished, stop the replay with Ctrl-C and remove the temporary file with `rm -f /tmp/prompt.ndjson`. Do not delete `harness/example/once_upon_a_time.ndjson`.

## Stopping

- Replay and viewer: Ctrl-C.
- `model.serve.ask`: Ctrl-D or Ctrl-C.
- `model.serve.serve`: Ctrl-C.
- Page server (`http.server`): Ctrl-C.

## Further reading

- [`protocol/v1/`](protocol/v1/): normative stream specification, JSON Schemas, and valid/invalid conformance fixtures.
- [`API.md`](API.md): model-side implementation details, lifecycle notes, and migration policy. Stop the replay before §8.4's V2 check, which also binds port 8768.
- [`example/README.md`](example/README.md): browser example, URLs, expected counters, troubleshooting.
- [`../README.md`](../README.md): repository overview.
