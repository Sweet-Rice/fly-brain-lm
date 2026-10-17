# model/serve/

Two entry points for the untrained model. Both load a checkpoint and stream brain activity to a visualization
harness over `ws://127.0.0.1:<port>/stream`. **These files are frozen**: do not edit them. Model changes
belong in `model/model.py`; see [../README.md](../README.md) for the compatibility rules.

Run everything from the repo root. Create a checkpoint first (see [../README.md](../README.md)); the examples
use `/tmp/fly-brain-init.pt`, or omit `--ckpt` to use `model/checkpoints/init.pt`.

## Ports used by the demos

| Service | Command | Port |
|---|---|---|
| Example harness page | `python -m http.server` on `harness/example` | 8770 |
| Terminal chat (`ask.py`) | `--port 8767` | stream 8767 |
| HTTP API (`serve.py`) | `--port 8771 --viz-port 8767` | API 8771, stream 8767 |

Ports 8765 and 8000 are the defaults. They may already belong to your own processes, so the examples
pass explicit ports. The startup commands below are alternatives: stop one before starting another
on the same port. If chat holds visualization port 8767, run the HTTP API with `--no-viz`;
`ask.py` itself has no `--no-viz` option.

## Example harness page

Start the page server (leave it running):

```bash
.venv/bin/python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open the page with the stream URL in the query string:

```
http://127.0.0.1:8770/?ws=ws://127.0.0.1:8767/stream
```

Without `?ws=`, the page connects to the default `ws://127.0.0.1:8765/stream`. Serve the page from
`http://127.0.0.1` as shown; an opened `file://` or `about:blank` page may fail to connect. The page reconnects
every second, so you may start the model before or after it. Details of the page are in
[../../harness/README.md](../../harness/README.md).

## Terminal chat: `ask.py`

```bash
.venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767 --max-tokens 8 --wait 30
```

`--wait 30` waits up to 30 s for a harness before the first message. Type a message and press Enter. Each
message prints the reply and a summary, for example `[4 prompt + N generated tokens; steps t=0..M]`.

**Two-message flow** (with the page open as above):

1. Start the chat, then type `Once upon a time` and press Enter. Wait for the summary line.
2. Type `The fly said` and press Enter. `t` continues where the first message stopped.
3. Press Ctrl-D (end of input) or Ctrl-C to quit.

Non-interactive equivalent, which needs no terminal:

```bash
printf 'Once upon a time\nThe fly said\n' | .venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767 --max-tokens 8 --wait 30
```

A message can also be given on the command line; the chat keeps reading lines afterwards:

```bash
.venv/bin/python -m model.serve.ask "Once upon a time" --ckpt /tmp/fly-brain-init.pt --port 8767 --max-tokens 8 --wait 30
```

**Options** (defaults in brackets): `--ckpt` [`model/checkpoints/init.pt`], `--device` [`cpu`; `cuda` for GPU],
`--max-tokens` [50], `--temperature` [1.0], `--top-k` [50], `--seed` [0, sampling only], `--host` [`127.0.0.1`],
`--port` [8765], `--path` [`/stream`], `--block` [0; which of the 12 blocks to visualize], `--wait` [0 s],
`--record FILE`.

**Recording:** `--record FILE` writes the stream as NDJSON, first the mapping line, then one line per fire.
Use a scratch path, because an existing file is overwritten. This one-shot command uses a free stream
port and closes stdin, so it finishes after the prompt; then view the recording:

```bash
.venv/bin/python -m model.serve.ask "Once upon a time" --ckpt /tmp/fly-brain-init.pt --port 0 --max-tokens 8 --record /tmp/fly-brain-story.ndjson </dev/null
.venv/bin/python -m harness.watch_stream /tmp/fly-brain-story.ndjson --brief
```

**Alternate port:** `--port 0` asks the OS for a free port. The banner prints the real URL, for example
`visualization stream: ws://127.0.0.1:<port>/stream`. Use that URL in `?ws=`.

**Shutdown:** Ctrl-D or Ctrl-C. The last line summarizes messages, steps streamed, harness connections and
dropped fire messages. The page shows `disconnected` and keeps retrying until you start the chat again.

## HTTP API: `serve.py`

Start with viz on 8767 (the page then shows the stream):

```bash
.venv/bin/python -m model.serve.serve --ckpt /tmp/fly-brain-init.pt --port 8771 --viz-port 8767
```

Start without the stream, for example while `ask.py` holds 8767:

```bash
.venv/bin/python -m model.serve.serve --ckpt /tmp/fly-brain-init.pt --port 8771 --no-viz
```

Require a key (any client sends `Authorization: Bearer <key>`):

```bash
.venv/bin/python -m model.serve.serve --ckpt /tmp/fly-brain-init.pt --port 8771 --viz-port 8767 --api-key local-test-key
```

**Options** (defaults in brackets): `--ckpt` [`model/checkpoints/init.pt`], `--device` [`cpu`], `--host`
[`127.0.0.1`; `0.0.0.0` exposes the API beyond this machine, while the stream stays on loopback], `--port`
[8000], `--model-id` [`flybrain-untrained`], `--ctx` [256; prompt tokens kept, from the end], `--max-tokens`
[128; cap per reply], `--api-key` [none; any key accepted], `--seed` [0], `--viz-port` [8765], `--block` [0],
`--record FILE`, `--no-viz`.

### Requests

Health and model list (`/v1` is optional for `/models` and the POST routes; `/health` has no `/v1` form):

```bash
curl -s http://127.0.0.1:8771/health
curl -s http://127.0.0.1:8771/v1/models
```

`/health` returns `{"status":"ok","model":"flybrain-untrained","note":...}`. `/v1/models` returns a list
with one model, `id` = `flybrain-untrained`.

Text completion:

```bash
curl -s http://127.0.0.1:8771/v1/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"flybrain-untrained","prompt":"Once upon a time","max_tokens":16,"temperature":1.0}'
```

The response has `object: "text_completion"`, `choices[0].text`, `choices[0].finish_reason` (`length` or
`stop`) and `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`).

Chat completion (no tools; the reply is plain text):

```bash
curl -s http://127.0.0.1:8771/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"flybrain-untrained","messages":[{"role":"system","content":"Be brief."},{"role":"user","content":"Hi"}],"max_tokens":16}'
```

The response has `object: "chat.completion"`, `choices[0].message` (`role`, `content`) and `usage`.

Streaming (Server-Sent Events; `-N` disables curl buffering):

```bash
curl -sN http://127.0.0.1:8771/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"flybrain-untrained","messages":[{"role":"user","content":"Hi"}],"max_tokens":16,"stream":true,"stream_options":{"include_usage":true}}'
```

Events use `data: {...}` with `object: "chat.completion.chunk"` (text completions use `text_completion`).
The first choice chunk carries the role, content arrives in `delta.content`, and the final choice
chunk has `finish_reason`. With `include_usage`, a further chunk has empty `choices` and `usage`.
The stream ends with `data: [DONE]`.

With `--api-key`, add `-H 'Authorization: Bearer local-test-key'`. A missing or wrong key returns HTTP 401 with
`{"error":{"message":"bad API key","type":"authentication_error"}}`.

Stop strings: send `"stop":"\n"` or `"stop":["\n"]`; the text is cut before the stop string.

### Limits

- **Prompt:** the last `--ctx` tokens are kept (GPT-2 BPE). `usage.prompt_tokens` reports the kept count. A
  chat's system prompt at the start is the part that falls off first.
- **Chat format:** each message becomes `role: content` on its own line, followed by `assistant:`. This is not a
  model-specific chat template.
- **Output:** `max_tokens` (default 64 when absent) is capped at `--max-tokens`.
- **Concurrency:** one generation at a time; other requests wait for the lock.
- **No tools:** `tools` and `tool_choice` are ignored.
- **Errors:** 400 for invalid JSON, a non-list `messages`, or a non-string `prompt`; 401 for a bad key; 404 for an
  unknown route.

### Visualization

With viz enabled, every request streams one `fire` per token through `--block` to the harness. Start the page
(`http://127.0.0.1:8770/?ws=ws://127.0.0.1:8767/stream`) before or after the API. The page reconnects by itself.
Record a run with `--record /tmp/fly-brain-api.ndjson` and view it with
`.venv/bin/python -m harness.watch_stream /tmp/fly-brain-api.ndjson --brief`.

## Shutdown

Press Ctrl-C in the server's terminal. The HTTP server stops and the stream closes.

## See also

- Model and checkpoint setup: [../README.md](../README.md)
- Data and wiring: [../../data/README.md](../../data/README.md)
- Harness, page and viewers: [../../harness/README.md](../../harness/README.md)
- Wire format and model contract: [../../harness/API.md](../../harness/API.md)
