# model/

FlyBrainLM **temporary scaffold**: builds the model from the MaleCNS wiring, initializes it, saves an
**untrained** checkpoint, and serves it. Its replies are gibberish by design. The architecture is not
final (see the docstring in `model.py`).

| Path | What it is |
|---|---|
| `model.py` | `Config`, `Wiring`, `FlyLM`, `save_checkpoint`, `load_checkpoint` |
| `init_model.py` | builds the untrained checkpoint and runs sanity checks |
| `serve/` | `ask.py` (terminal chat) and `serve.py` (HTTP API); frozen, see [serve/README.md](serve/README.md) |
| `checkpoints/` | output folder for checkpoints; gitignored, never committed |

Run everything from the repo root with the venv interpreter, `.venv/bin/python -m <module>`. Root setup
is in [../README.md](../README.md).

## Prerequisites

- Python packages imported by these files: `torch`, `numpy`, `pandas` (imported by `data/build_wiring.py`),
  `tiktoken` (serving), `websockets` (the visualization stream). No requirements file is in the repo.
- `data/connectome/wiring.npz` must exist. It is committed (not gitignored). Rebuilding it from the MaleCNS
  tables is covered in [../data/README.md](../data/README.md). `init_model` reads only `wiring.npz`; it does not
  need the large feather files.

## Create an untrained checkpoint

```bash
.venv/bin/python -m model.init_model --out /tmp/fly-brain-init.pt
```

**Safety:** with no arguments, `python -m model.init_model` writes `model/checkpoints/init.pt` and
**overwrites an existing file without asking**. Pass `--out` to a path you choose, as above, so an existing
checkpoint is not replaced by accident. To keep several checkpoints in the repo, use a distinct name:

```bash
.venv/bin/python -m model.init_model --seed 1 --out model/checkpoints/init_s1.pt
```

What the command does:

1. Loads the wiring and builds `FlyLM` from `Config.from_wiring(...)`. It runs on CPU; there is no device flag.
2. Prints the wiring (KCs × glomeruli, connections, class counts) and the model (blocks, `d_model`, parameter count).
3. Runs five sanity checks and prints `[PASS]`/`[FAIL]` for each: logits shape, finite logits, exactly `top_k`
   KCs active per token, zero strength where there is no wire, and untrained loss close to `ln(vocab)`.
4. If any check fails, it writes nothing and exits with `init checks failed; checkpoint NOT written`.
5. Otherwise it saves the checkpoint and prints its path and size, labelled TEMPORARY, untrained.

`--seed` controls the random generator used for initialization and sanity-check inputs.
Generation sampling has its own `--seed` in the serving commands.

## What a checkpoint contains

`save_checkpoint` writes a dict with `note`, `config` (the fields of `Config`), `wiring` (`mask`, `theta`,
`kc_class`, `kc_ids`, `glom_names`) and `state_dict`. `load_checkpoint(path, device="cpu")` does the following:

- loads with `torch.load(..., weights_only=True)`; use checkpoints from a trusted source;
- rebuilds the architecture from the saved `config`, and takes the wiring from the **checkpoint itself**,
  not from `data/connectome/wiring.npz`;
- loads `state_dict` strictly, then moves the model to `device` and sets eval mode.

## Compatibility rules

- Checkpoint loading requires matching parameter names and shapes. Incompatible changes fail strict
  `load_state_dict`; removed or renamed `Config` fields can leave unknown keys rejected by `Config(**config)`.
  A new field with a default can load older configs using that default, provided the weights remain compatible.
  To start with new untrained weights after an incompatible change, run `init_model` to a new `--out` path
  and pass it with `--ckpt`.
- Rebuilding `wiring.npz` does not change an existing checkpoint, because each checkpoint carries its own wiring.
- To select a checkpoint for serving, pass `--ckpt <path>` to `serve.ask` or `serve.serve`. The default is
  `model/checkpoints/init.pt`.

```bash
.venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767
```

## Generation parameters (used by `serve/`)

| Parameter | Default | Meaning |
|---|---|---|
| `temperature` | 1.0 | `<= 0` means greedy (argmax) |
| `top_k` | 50 | keep the k most likely tokens; a falsy value (0) disables the filter in `ask.py` |
| `max_tokens` | 50 in `ask.py`; 64 per request and 128 cap in `serve.py` | tokens generated per reply |
| stop | GPT-2 end-of-text token | generation stops there, or at a stop string in the HTTP API |

Tokens are GPT-2 BPE (`tiktoken`, encoding `gpt2`). `tiktoken` may download its vocabulary on first use if it
is not cached.

## Scope and status

- The model is **untrained**. There is no training entry point in `model/`, and no quality claim applies.
  Use it to prove that build, initialize, save, load, serve and visualize all work.
- Serving streams brain activity unless the HTTP server is started with `--no-viz`. The wire format is in
  [../harness/API.md](../harness/API.md), including the model-side names the stream depends on.
- `model/serve/` executable files are frozen. Preserve the `load_checkpoint` function, the returned
  model's `stream` method, and `harness.viz_stream.stream_model`, plus the return values/attributes
  listed in that API contract. Adapt the model or `harness/viz_stream.py`, not the serving code.
- Export the loaded checkpoint's topology without inference or a running server using
  [`python -m harness.export_mapping`](../harness/README.md#export-a-checkpoint-mapping).
  The exporter reads the selected block's live mask and lobe membership, not a separate wiring snapshot.

## Next

- Serve, chat, and visualize the checkpoint: [serve/README.md](serve/README.md)
- Data and wiring: [../data/README.md](../data/README.md)
- Harness and viewers: [../harness/README.md](../harness/README.md), wire spec [../harness/API.md](../harness/API.md)
