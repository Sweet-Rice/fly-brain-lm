# Example browser harness

`index.html` is a throwaway-quality browser harness for the visualization stream: one static file, vanilla JS, Canvas 2D, no build step, no external URLs. It proves the stream works end to end. The wire protocol itself is specified in [`../API.md`](../API.md).

All commands run from the repo root (`fly-brain-lm/`) with the project venv: `.venv/bin/python -m …`. Stop each long-running command with Ctrl-C.

## 1. Serve the page

The page must be served over HTTP from loopback. Do not open `index.html` as a `file://` URL.

```bash
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

This only serves files. It does not start any stream source. Open the page with a stream URL:

```
http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream
```

## 2. Choose a stream source

Pick one source and give the page its exact `ws://…/stream` URL in `?ws=`.

| Source | Needs | Start command | Stream URL for the page |
|---|---|---|---|
| Fixed-prompt replay (default for demos) | Python + `websockets` only | `.venv/bin/python -m harness.replay_prompt` | `ws://127.0.0.1:8768/stream` |
| Live terminal chat | model dependencies and scratch checkpoint from [model setup](../../model/README.md) | `.venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767 --max-tokens 8` | `ws://127.0.0.1:8767/stream` |
| Live HTTP API | same as chat | `.venv/bin/python -m model.serve.serve --ckpt /tmp/fly-brain-init.pt --viz-port 8767 --port 8771` | `ws://127.0.0.1:8767/stream` (the API itself is on 8771) |

Replay details are in [`../README.md`](../README.md#fixed-prompt-replay-no-model-needed).

Two-terminal replay demo:

```bash
# terminal 1: stream source
.venv/bin/python -m harness.replay_prompt
# terminal 2: page server
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Then open `http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream` in Chromium.

For live chat, run the `model.serve.ask` command in terminal 1 instead. Open
`http://127.0.0.1:8770/?ws=ws://127.0.0.1:8767/stream`, wait for `connected`
and the node count, **then type a message**. A late connection does not replay
earlier live steps. Ctrl-D ends the chat.

For the HTTP API source, connect the page first, then send a completion request
using the [HTTP examples](../../model/serve/README.md). An idle API produces no fires.

Demo ports: page 8770, replay 8768, live chat 8767, live API 8771 with its stream on 8767. Ports 8765 and 8000 are the defaults of the model's own processes and may already be in use by someone's running model or API. Do not use them for these demos and do not stop processes on them.

## 3. URL selection

- `?ws=` sets the full WebSocket URL. Use the exact path printed by the source: the replay and default model path is `/stream`. A live chat started with `--path` uses its configured path instead. A mismatch closes with code 1008.
- If `?ws=` is missing, the page uses `ws://127.0.0.1:8765/stream`. That is the model's default port, so always pass `?ws=` explicitly for the demo ports.
- The page reads the URL once when it loads. To change sources, load a new URL.

## 4. Expected status

The status line at the top shows the connection and counters. The side panel shows the group legend and the last fire.

| Field | Meaning |
|---|---|
| `status` | `connected` or `disconnected` (green when connected) |
| `url` | the `?ws=` URL in use |
| `mapping version` | version of the last mapping received (`-` before any) |
| `nodes`, `edges` | size of the current mapping |
| `last t` | most recent accepted fire's `t`; cleared by an accepted v1 mapping |
| `fires received` | fires accepted since the last accepted v1 mapping |
| `gaps` | fires whose `t` skipped past the previous `t` + 1 since the last accepted v1 mapping |
| `invalid pairs` | pairs that name an edge not in the mapping (shown red if nonzero) |
| `ignored messages` | messages with an unknown `type` |
| `bad frames` | non-JSON/non-object frames, unusable v1 mappings, or fires with invalid `t`/`pairs` fields (red if nonzero) |

For the bundled replay (`once_upon_a_time.ndjson`) and for the current checkpoint, expect:

- `status` `connected`, `mapping version` 1, `nodes` 1958, `edges` 19037.
- Legend: 5 groups with counts 54 (Glomerulus), 663 (KC_gamma), 874 (KC_alphabeta), 352 (KC_alphaprime_betaprime), 15 (MBON).
- Within a loop, `fires received` counts up to 11 and `last t` reaches 10. `gaps`, `invalid pairs`, `ignored messages`, and `bad frames` stay 0.
- Five columns of nodes, one per group, with lit edges between them.
- The side panel's "Last fire" shows `t`, the pair count, and counts per type pair such as `Glomerulus -> KC_gamma`.

To inspect the state directly, run `JSON.stringify(window.harnessState)` in the browser console. The page exposes the same fields there.

## 5. Replay loops and reconnects

- The replay sends the mapping first, then its fires, then pauses, then starts again with the mapping. Each new mapping resets the counters, so `fires received` climbs to 11, drops back to 0, and repeats. With default settings one loop takes about 4.2 s (11 × 0.2 s + 2 s pause).
- Each browser connection gets its own timeline that starts at the beginning of the recording.
- When the page disconnects, it retries every 1000 ms. When the source comes back, the page shows the mapping again without a reload.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `disconnected`, `nodes` 0 | Nothing is listening on the URL's port, or the source is not running | Check that the source terminal printed `visualization stream: ws://…` and that the ports match `?ws=`. |
| `disconnected`, graph and counts still shown | The source stopped after connecting; the page retains the last mapping and retries every 1000 ms | Restart the source on the same port; the page reconnects without a reload. |
| `disconnected` on every retry, source is up | Wrong path, so the server closes with 1008 | Use the exact path printed by the source: normally `/stream`, or the live chat's configured `--path`. |
| `connected`, `mapping version -`, `nodes` 0 | No mapping has arrived. The connection may not be this stream, or the page is still waiting. | Confirm the port belongs to the stream source. |
| Banner `unsupported mapping version N` | The source sent a mapping version other than 1. This Canvas example displays a banner and ignores fires; the normative v1 harness behavior is to close (logical result 1003, browser wire code 4001). | Use a source that sends v1, or the [standalone harness](../app/README.md) for the conforming state machine and close behavior. |
| `bad frames` above 0 | Non-JSON/non-object data, an unusable v1 mapping, or malformed fire fields | Check the producer and recording against the wire API. |
| Mapping shown, `fires received` 0 | No steps have run since you connected. A harness that connects mid-run receives only later fires. | For live chat, type a message. For the HTTP API, send a [completion request](../../model/serve/README.md). For replay, wait a few seconds; if it stays at 0, check the replay terminal. |
| `invalid pairs` above 0 | Fires name edges that are not in the current mapping | Fix the producer or recording so every pair is declared in the active mapping; send replacement mappings before their fires. |
| Source fails to start with an address-in-use error | Another process owns that port | Choose a free port for the source and pass the same port in `?ws=`. Do not stop processes you do not own. |
| Browser shows no graph and no status | The page itself did not load correctly, or the wrong file/URL was opened | Confirm the HTTP page server is up and use the example URL above; opening a file directly is not the supported workflow. |
| Chrome asks for Local Network Access permission | Chrome 147+ gates WebSocket connections to loopback from pages in other address spaces | Serve the page from `http://127.0.0.1:<port>`, as above. Public https origins and `file://` pages may be prompted or blocked. |

Only one process should listen on each port. Do not run two sources or two servers on the same port.

## 7. Stopping

- Stream source: Ctrl-C in its terminal (replay, `model.serve.serve`). For `model.serve.ask`, Ctrl-D or Ctrl-C.
- Page server: Ctrl-C in its terminal.
- Browser: close the tab. A closed page stops retrying.

## 8. Limits

- Throwaway quality: it draws every edge on Canvas 2D and does not reconnect with backoff or validate deeply.
- It is not a WebGPU or production harness.
- Terminal viewer for the same stream: [`../README.md`](../README.md#terminal-viewer), or the formal spec in [`../API.md`](../API.md).
