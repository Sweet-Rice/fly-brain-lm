# data/

Everything here produces or reads the inputs for the model: the fly wiring (which
glomeruli wire to which Kenyon cells, KCs) and, optionally, GPT-2-tokenized TinyStories.

Run commands from the **repo root** with `.venv/bin/python -m …`. Scripts use
repo-relative input/output paths such as `data/connectome` and `data/train.bin`;
running elsewhere can read the wrong location, create outputs there, or fail.

Replay users do not need anything in this folder. The stream replay uses the bundled
`harness/example/once_upon_a_time.ndjson` and needs no network, no model, and no `data/` files.
See [`../model/README.md`](../model/README.md) for model setup and the root
[`../README.md`](../README.md) for environment setup.

## What is where

| Path | Status | Used by | Needed for |
|---|---|---|---|
| `data/connectome/wiring.npz` | **tracked** in git | `load_wiring()`, `model.init_model` | initialization (required) |
| `data/connectome/pn_kc_edges.csv` | **tracked** in git (cache, ~22.6k rows) | `build_wiring.get_edges`, `search_wiring_rules.py` | rebuilding without the 1 GB file (optional) |
| `data/connectome/body-annotations-male-cns-v1.0-minconf-0.5.feather` | **ignored** by `.gitignore`; ~14.5 MB | `build_wiring.py`, `search_wiring_rules.py` | rebuilding/searching only (optional) |
| `data/connectome/connectome-weights-male-cns-v1.0-minconf-0.5.feather` | **ignored**; ~1.05 GB | `build_wiring.get_edges` only when `pn_kc_edges.csv` is absent | rebuilding from scratch only (optional) |
| `data/train.bin`, `data/val.bin` | **ignored** (`data/*.bin`); generated | `prepare_data.py` writes; `data.load_bin` / `sample_batch` read | future training only (optional, no current consumer) |
| `data/*.py`, `data/download_connectome.sh` | tracked | — | source |
| `model/checkpoints/*.pt` | **ignored** (`model/` docs) | `ask`, `serve`, `init_model` | model state, not data |

Initialization needs only the bundled `wiring.npz`, not the large source tables.
An existing checkpoint carries its own wiring, so serving does not read `wiring.npz`
again. Model serving may download GPT-2 encoding data on first use if it is uncached.

The committed `wiring.npz` holds: `mask` (1889×54 bool), `theta` (float32), `counts` (float32),
`kc_class` (1889, 0 = gamma, 1 = alpha/beta, 2 = alpha'/beta'), `kc_ids` (1889, MaleCNS body IDs),
`glom_names` (54 strings). Counts: 1889 KCs, 54 glomeruli, 9592 connections, classes 663/874/352.

## Setup levels

**Level 0: replay only.** Nothing from `data/`. Start with the root or harness docs.

**Level 1: initialize the model (required, offline).** Uses the tracked `wiring.npz`.
Needs `numpy`, `pandas`, and `torch` in `.venv`. `data/build_wiring.py` imports `pandas` at
module level, so `load_wiring()` needs it too.

**Level 2: rebuild the wiring (optional, needs the raw MaleCNS tables).**
1. If raw tables are missing, use `bash data/download_connectome.sh` (network, see below).
2. `.venv/bin/python -m data.build_wiring`. Reads annotations; reads the 1 GB weights file only
   if `pn_kc_edges.csv` is missing. Rewrites `wiring.npz`.

**Level 3: token data (optional, network, future training).** `.venv/bin/python -m data.prepare_data`.
Needs the [root model/data environment](../README.md#run-the-real-model-or-tests)
(including `torch`, `numpy` and `tiktoken`), plus `datasets` and network access to Hugging Face.

## Scripts

### `download_connectome.sh` (network, writes files)

```
bash data/download_connectome.sh
```

Downloads two MaleCNS v1.0 tables from `storage.googleapis.com/flyem-male-cns/...` into
`data/connectome/` with `curl -fL -C - --retry 3`. It fetches **both** feathers, including the
~1.05 GB weights file, even when `pn_kc_edges.csv` already exists. It creates the directory and
writes into it, overwriting (or resuming) the two `.feather` files.

### `build_wiring.py` (writes `wiring.npz`)

```
.venv/bin/python -m data.build_wiring          # DESTRUCTIVE: overwrites data/connectome/wiring.npz
```

- Reads `body-annotations…feather` (always) and `connectome-weights…feather` (only if the cache is
  missing).
- Writes `data/connectome/pn_kc_edges.csv` only if it is missing (cache of every PN-like → KC pair).
- Always overwrites `data/connectome/wiring.npz` with `mask`, `theta`, `counts`, `kc_class`,
  `kc_ids`, `glom_names`.
- Rules are the `RULES = Rules(pn_set="alpn_any")` line (all other fields default; see the
  `Rules` dataclass). Its summary prints a target line whose `G` is 55, but the committed wiring and
  the model docs use 54, so expect a mismatch in that summary line.

Safe way to rebuild without losing the tracked file:

```
cp data/connectome/wiring.npz /tmp/wiring.before.npz   # keep a copy; restore with cp if needed
```

Python API (read-only use): `from data.build_wiring import load_wiring; w = load_wiring()`
returns a `model.wiring.Wiring` (torch tensors). It reads `data/connectome/wiring.npz` relative to the
current directory.

### `search_wiring_rules.py` (search; may create the edge cache)

```
.venv/bin/python -m data.search_wiring_rules
```

Tries 384 rule combinations (`GRID`) with `build()` and prints results against
`TARGET`. It does not write `wiring.npz`. It reads annotations and the edge cache;
if the cache is missing, it reads the large weights file and creates the cache.
The historical target uses 55 glomeruli; the bundled wiring has 54. Compare the
printed statistics rather than treating that historical figure as the bundled layout.

### `prepare_data.py` (network, writes `data/train.bin` and `data/val.bin`)

```
.venv/bin/python -m data.prepare_data          # NETWORK + DESTRUCTIVE to existing *.bin
```

Loads `roneneldan/TinyStories` via Hugging Face `datasets` (download, cached by that library),
GPT-2 BPE-encodes each story with `encode_ordinary`, appends the EOT token (50256), and writes
flat `uint16` arrays to `data/train.bin` and `data/val.bin` (overwrites).
The script has no `__main__` guard, so **importing `data.prepare_data` also runs the download and
write**.

### `data.py` (library, no CLI)

- `encode_stories(list[str]) -> np.ndarray[uint16]`: GPT-2 encode plus EOT per story.
- `write_bin(path, batches) -> int`: streams batches to a file; returns the token count.
- `load_bin(path)`: `np.memmap` of uint16.
- `sample_batch(data, B, T, gen=None, device="cpu") -> (x, y)`: random windows, `int64`, `y` shifted by one.

No training entry point exists in this repo. `sample_batch` is a library function; no code under
`model/` or `harness/` calls it. `test/test_data.py` tests these helpers with synthetic data.

## Dependencies

Use the [root environment setup](../README.md#run-the-real-model-or-tests).
Wiring utilities import `numpy` and `pandas`; Feather reads also need `pyarrow`.
`load_wiring()` returns PyTorch tensors and therefore needs `torch`.

TinyStories preparation additionally needs Hugging Face `datasets`:

```bash
.venv/bin/python -m pip install datasets
```

The dataset command downloads data and overwrites existing token files; it is
not required to run the replay, initialize the model, or serve a checkpoint.
Do not import `data.prepare_data` merely to inspect it: importing it executes the
same download/write workflow as running it.

## Inspect the bundled wiring without rebuilding

```bash
.venv/bin/python -c "from data.build_wiring import load_wiring; w = load_wiring(); print(tuple(w.mask.shape), int(w.mask.sum()))"
```

For the bundled file this prints `(1889, 54) 9592`. It reads `wiring.npz`, not the
large Feather tables, and does not regenerate wiring or token files.

Rebuilding wiring changes a **tracked** file; back up any custom wiring first.
Existing checkpoints retain their old embedded wiring until you create or migrate
a checkpoint. There is currently no training entry point that consumes the generated
`train.bin` and `val.bin`.
