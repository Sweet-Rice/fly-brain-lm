# model/

FlyBrainLM **temporary scaffold**: builds a model implementation from the MaleCNS wiring, initializes it, saves an
**untrained** checkpoint, and serves it. Untrained replies are gibberish by design. Architectures are not final.
`vibe2` can also load trained weights imported from the private fly-brain-lm repo; see
[vibe2: trained fly-dopamine weights](#vibe2-trained-fly-dopamine-weights).

| Path | What it is |
|---|---|
| `model.py` | public facade and registry used by `serve/`: `IMPLEMENTATIONS`, selection, `build_model`, `save_checkpoint`, `load_checkpoint` |
| `wiring.py` | `Wiring`: implementation-independent wiring data, shared by every model, the visualization and `data/build_wiring.py` |
| `vibe/` | the AI-built model: `Config`, `FlyLM`, and the implementation interface in `__init__.py` (architecture docstring in `vibe/model.py`). Default implementation |
| `personal/` | your own model. An empty template until you fill it in; see [Personal model](#personal-model) |
| `vibe2/` | fly-dopamine: a port of the private repo's plain fly-dopamine model (equations in the `vibe2/model.py` docstring) and `import_weights.py`, which converts its trained checkpoints; see [vibe2](#vibe2-trained-fly-dopamine-weights) |
| `init_model.py` | builds an untrained checkpoint for the chosen implementation and runs its sanity checks |
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

## Choosing an implementation

Selection applies when **building** a checkpoint. The first of these that is set wins:

1. `--impl {vibe,personal,vibe2}` on `init_model`;
2. the environment variable `FLYBRAIN_IMPL` (an empty value counts as unset);
3. `vibe` (`DEFAULT_IMPL` in `model.py`).

An unknown name fails with `unknown model implementation 'bogus'; choose one of: vibe, personal, vibe2`.

**Serving does not choose.** `serve.ask` and `serve.serve` load the implementation recorded in the checkpoint
passed with `--ckpt`. If `FLYBRAIN_IMPL` names a different implementation at load time, loading still follows
the checkpoint and prints one line to stderr, for example:

```
note: FLYBRAIN_IMPL=personal selects builds only; model/checkpoints/vibe.pt was built by 'vibe', loading 'vibe'
```

**Moving a package** takes one edit. Each implementation is an importable package named in `IMPLEMENTATIONS` in
`model.py`:

```python
IMPLEMENTATIONS = {"vibe": "model.vibe", "personal": "model.personal", "vibe2": "model.vibe2"}
```

To move `model/vibe/` elsewhere, move the folder and change its string (for example `"vibe": "impls.vibe"`). This
works only because intra-package imports are relative (`from .model import ...`). Keep them relative in every
implementation. `model.py` imports implementations lazily, so a broken `personal/` never breaks loading a vibe
checkpoint.

## Create an untrained checkpoint

```bash
.venv/bin/python -m model.init_model                          # vibe      -> model/checkpoints/vibe.pt
.venv/bin/python -m model.init_model --impl personal          # personal  -> model/checkpoints/personal.pt
FLYBRAIN_IMPL=personal .venv/bin/python -m model.init_model   # same as --impl personal
.venv/bin/python -m model.init_model --impl vibe --out /tmp/fly-brain-init.pt
```

Options: `--impl {vibe,personal,vibe2}`, `--out` (default `model/checkpoints/<impl>.pt`), `--seed` (default 0).

**Safety:** the default output is named after the implementation, so building `personal` never overwrites the
vibe weights. The default path is still overwritten without asking if it already exists. To keep several
checkpoints, pass a distinct `--out`:

```bash
.venv/bin/python -m model.init_model --seed 1 --out model/checkpoints/vibe_s1.pt
```

`model/checkpoints/init.pt` is the user's legacy vibe checkpoint (no `"impl"` key). No command writes that name
any more, and serving still defaults to it (see below). Do not overwrite it.

What the command does:

1. Resolves the implementation and prints `implementation: <name> (<package>)`.
2. Loads the wiring and builds the model with `build_model` on CPU; there is no device flag.
3. Prints the wiring (KCs × glomeruli, connections, class counts) and `model: <class>, <n> parameters`.
4. Runs the implementation's sanity checks and prints `[PASS]`/`[FAIL]` for each. For `vibe` there are five:
   logits shape, finite logits, exactly `top_k` KCs active per token, zero strength where there is no wire, and
   untrained loss close to `ln(vocab)`.
5. If any check fails, it writes nothing and exits with `init checks failed; checkpoint NOT written`.
6. If the implementation is still a template, it writes nothing and exits with
   `<name> model is not implemented yet: ...`.
7. Otherwise it saves the checkpoint and prints its path and size, labelled untrained.

`--seed` controls the random generator used for initialization and sanity-check inputs.
Generation sampling has its own `--seed` in the serving commands.

## vibe2: trained fly-dopamine weights

`vibe2/` ports the plain fly-dopamine model (`fly_dopamine.py::DopamineMixer`, fly addressing) from the private
fly-brain-lm `vibes` repo. Parameter names match the private state_dict. `init_model --impl vibe2` builds it
untrained. `vibe2/import_weights.py` converts a trained private checkpoint into a normal vibe2 checkpoint:

```bash
.venv/bin/python -m model.vibe2.import_weights            # TinyStories -> model/checkpoints/vibe2_tinystories.pt
.venv/bin/python -m model.vibe2.import_weights --src /home/tai/Projects/fly-brain-lm/vibes/out/wt103_fly_dopamine/best.pt --out model/checkpoints/vibe2_wt103.pt
.venv/bin/python -m model.serve.ask "Once upon a time" --ckpt model/checkpoints/vibe2_tinystories.pt
```

Options: `--src` (default: the private repo's `out/fly_dopamine/best.pt`, TinyStories, step 2000, best val loss
2.1021), `--wiring-dir` (default `<private repo>/<model_config["wiring_dir"]>`, i.e. `vibes/mb_wiring`), `--out`.
Do not pass `--out model/checkpoints/vibe2.pt`: `init_model --impl vibe2` overwrites that path with untrained weights.

- Only plain fly-dopamine checkpoints are accepted (`memory="dopamine"`, `addressing="fly"`, no attention layers,
  15 heads, real wiring); otherwise it exits naming the field. `ab_dopamine_max` (0.2 in the private "cap" runs)
  comes from the checkpoint. A wiring dir whose `mask.pt` differs from the checkpoint's masks is rejected.
- The checkpoint stores the private wiring with KCs reordered to `(kc_class, kc_id)`, the same order as
  `data/connectome/wiring.npz`. It keeps all 55 glomeruli, including `VP2`, which has no wires but still enters the
  glomerular normalization. The visualization therefore shows 1959 nodes, not 1958; edges are unchanged at 19037.
- After saving, it prints the source step and loss, the parameter count (30,879,324), and a greedy continuation of
  "Once upon a time".
- Imported logits match the private model to 6e-8 in float64, with identical greedy tokens. In float32 the gap is
  about 1e-2, from the private model's chunked scan summing in a different order.

## What a checkpoint contains

`save_checkpoint(path, model, wiring, impl, **extra)` writes a dict with:

- `impl`: the implementation name, `"vibe"`, `"personal"` or `"vibe2"`;
- `note`: the implementation's `NOTE`;
- `config`: the implementation's `export_config(model)` output;
- `wiring`: `mask`, `theta`, `kc_class`, `kc_ids`, `glom_names`;
- `state_dict`;
- any extras passed in (`init_model` adds `seed`). `impl`, `note`, `config`, `wiring` and `state_dict` are reserved.

`load_checkpoint(path, device="cpu")` returns `(model, wiring, ck)` and does the following:

- loads with `torch.load(..., weights_only=True)`; use checkpoints from a trusted source;
- reads `ck["impl"]`. A checkpoint without that key was written before the key existed and loads as `vibe`;
- rebuilds the model from the saved `config`, and takes the wiring from the **checkpoint itself**, not from
  `data/connectome/wiring.npz`. An unregistered `impl` value fails with `ValueError`;
- loads `state_dict` strictly, then moves the model to `device` and sets eval mode.

## Compatibility rules

- Checkpoint loading requires matching parameter names and shapes. Incompatible changes fail strict
  `load_state_dict`; removed or renamed `Config` fields can leave unknown keys rejected by `Config(**config)`.
  A new field with a default can load older configs using that default, provided the weights remain compatible.
  To start with new untrained weights after an incompatible change, run `init_model` to a new `--out` path
  and pass it with `--ckpt`.
- Rebuilding `wiring.npz` does not change an existing checkpoint, because each checkpoint carries its own wiring.
- To select a checkpoint for serving, pass `--ckpt <path>` to `serve.ask` or `serve.serve`. The default is
  `model/checkpoints/init.pt`, the legacy vibe checkpoint.

```bash
.venv/bin/python -m model.serve.ask --ckpt /tmp/fly-brain-init.pt --port 8767
```

## Model contract

Every implementation package exports four names. `model.py` checks them when it imports that implementation:

| Name | Contract |
|---|---|
| `NOTE` | `str`, stored in each checkpoint as `note`. |
| `build(wiring, config=None)` | Returns a `torch.nn.Module` built from `wiring` (`model.wiring.Wiring`). `config=None` means fresh defaults; a dict is the `export_config` output of a checkpoint and must rebuild the same architecture. |
| `export_config(model)` | Returns a dict that `build` accepts back. It may contain only `str`, `int`, `float`, `bool`, `None`, `list` and `dict`, so that `torch.load(weights_only=True)` accepts it. |
| `sanity_checks(model, wiring)` | Returns `{description: passed}` for untrained-model checks. Any `False` blocks the checkpoint write. |

The model object itself must provide what serving and the visualization use. `build_model` checks this and fails
with `TypeError` if anything is missing:

- `stream(prompt_ids, max_new_tokens, temperature=1.0, top_k=None, stop_ids=(), gen=None)`: yields `int` GPT-2
  token ids (end of text is 50256). `prompt_ids` is a nonempty `list[int]`; `gen` is a CPU
  `torch.Generator` or `None`. Serving may move the model to `--device`, so create inputs on the model's device
  and sample on CPU when using `gen`. `temperature <= 0` is greedy. Stops after yielding a stop id.
- `heads_per_lobe`: `int > 0`. The visualization draws `3 * heads_per_lobe` MBON compartments.
- `kc_code_module(block)`: returns an `nn.Module` whose forward output is `(B, T, K)`, with rows aligned with
  the last axis of `kc_topology(block)`'s mask. A value `> 0` means that Kenyon cell (KC) is active. The visualization hooks this output
  and fires one step per position along `T`, not one step per forward call.
- `kc_topology(block)`: returns `(mask, lobes)`, read live from the model. `mask` is `(K, G)` bool; `lobes` is a
  tuple of three one-dimensional integer tensors partitioning `range(K)`. It raises `IndexError` for a block that does not exist.

The visualization reads only these names. It does not read implementation internals
(see [../harness/API.md](../harness/API.md) §8).

## Personal model

Your model lives in `model/personal/__init__.py`. It is a template that raises `NotImplementedError` until you
replace the three functions. Everything you need is in this section.

1. **Set the four names** in `model/personal/__init__.py`: `NOTE`, `build`, `export_config`, `sanity_checks`.
   Keep `NOTE` a short string.
2. **Write `build(wiring, config=None)`.** Use `wiring.mask` (shape `(K, G)`: KCs by glomeruli), `wiring.theta`
   and `wiring.kc_class` from the `model.wiring.Wiring` you are given. With `config=None`, choose defaults and
   derive them from `wiring` if you want. With a dict, rebuild exactly the architecture that `export_config`
   described.
3. **Write `export_config(model)`.** Return every value needed to rebuild the model, using only `str`, `int`,
   `float`, `bool`, `None`, `list` and `dict`. Anything else (a tensor, a custom class) will fail `weights_only` loading.
4. **Implement the model contract** on the object that `build` returns: the `stream` generator,
   `heads_per_lobe`, and `kc_code_module(block)` (see the list above). The KC-code module must output each
   processed token in exactly one position during a `stream()` call. If your model recomputes the whole
   context for each new token, apply this module only to new token positions; replaying old KC codes
   would replay their visualization steps.
5. **Write `sanity_checks(model, wiring)`.** Return `{description: passed}` for untrained behaviour: output shape,
   finiteness, and whatever else you want to assert. Any `False` blocks writing the checkpoint.
6. **Keep intra-package imports relative** (`from .x import y`) so the package can be moved by editing
   `IMPLEMENTATIONS`.
7. **Build and serve it**:

   ```bash
   FLYBRAIN_IMPL=personal .venv/bin/python -m model.init_model          # -> model/checkpoints/personal.pt
   .venv/bin/python -m model.serve.ask "Once upon a time" --ckpt model/checkpoints/personal.pt --port 0 --max-tokens 8 --temperature 0 </dev/null
   ```

A minimal working example of the same contract is `test/fake_impl.py`; the registry tests in
`test/test_model_registry.py` build it. It is a test fixture, not a model to copy.

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

- The models are **untrained**. There is no training entry point in `model/`, and no quality claim applies.
  Use them to prove that build, initialize, save, load, serve and visualize all work.
- Serving streams brain activity unless the HTTP server is started with `--no-viz`. The wire format is in
  [../harness/API.md](../harness/API.md), including the model-side names the stream depends on.
- `model/serve/` executable files are frozen. Preserve the `load_checkpoint` function, the returned
  model's `stream` method, and `harness.viz_stream.stream_model`, plus the return values/attributes
  listed in that API contract. Adapt the model implementation or `harness/viz_stream.py`, not the serving code.
- Export the loaded checkpoint's topology without inference or a running server using
  [`python -m harness.export_mapping`](../harness/README.md#export-a-checkpoint-mapping).
  The exporter reads the selected block's live mask and lobe membership through `kc_topology(block)`, not a separate wiring snapshot.

## Next

- Serve, chat, and visualize the checkpoint: [serve/README.md](serve/README.md)
- Data and wiring: [../data/README.md](../data/README.md)
- Harness and viewers: [../harness/README.md](../harness/README.md), wire spec [../harness/API.md](../harness/API.md)
