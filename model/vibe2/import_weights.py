"""Import a trained plain fly-dopamine checkpoint from the private fly-brain-lm `vibes` repo as a vibe2 checkpoint.

    .venv/bin/python -m model.vibe2.import_weights [--src out/fly_dopamine/best.pt] [--out model/checkpoints/...]

The private model stores its Kenyon cells (KCs) in mb_wiring order, which is not class-sorted. This
repo's wiring order (data/connectome/wiring.npz) sorts KCs by (kc_class, kc_id). The importer rebuilds
the private wiring in that order and permutes the KC rows of every `addr.theta` / `addr.mask` tensor to
match. All other weights are independent of KC order. Every lobe reads its KCs through index buffers
rebuilt from the permuted kc_class, so the permuted model computes the same function. All 55 glomeruli
are kept, including VP2, which has no wires: its receptor channel still enters the glomerular
normalization.
"""
import argparse
import json
import re
from pathlib import Path

import tiktoken
import torch
import torch.nn.functional as F

from model.model import save_checkpoint
from model.wiring import Wiring

from . import build

DEFAULT_SRC = "/home/tai/Projects/fly-brain-lm/vibes/out/fly_dopamine/best.pt"
DEFAULT_OUT = "model/checkpoints/vibe2_tinystories.pt"   # not vibe2.pt: init_model --impl vibe2 writes untrained weights there
KC_ROW_KEYS = re.compile(r"\.addr\.(theta|mask)$")
PRIVATE_DERIVED = re.compile(r"\.addr\.(head_class|comp_mask|class_idx[012])$")   # rebuilt non-persistently by vibe2


def load_private_wiring(wiring_dir):
    """(Wiring in class-sorted KC order, perm) from a private mb_wiring dir. New KC row i = private row perm[i]."""
    wiring_dir = Path(wiring_dir)
    mask = torch.load(wiring_dir / "mask.pt", weights_only=True).bool()                 # (K, G)
    theta_init = torch.load(wiring_dir / "theta_init.pt", weights_only=True).float()    # softplus^-1(row share), 0 off-mask
    kc_class = torch.load(wiring_dir / "kc_class.pt", weights_only=True).long()         # (K,)
    meta = json.loads((wiring_dir / "meta.json").read_text())
    kc_ids, cls = meta["kc_ids"], kc_class.tolist()
    perm = torch.tensor(sorted(range(len(kc_ids)), key=lambda j: (cls[j], kc_ids[j])))
    wiring = Wiring(mask=mask[perm], theta=(F.softplus(theta_init) * mask)[perm], kc_class=kc_class[perm],
                    kc_ids=[kc_ids[j] for j in perm], glom_names=meta["glom_names"])
    return wiring, perm


def permute_kcs(state_dict, perm):
    """Copy of `state_dict` with the KC rows of every `*.addr.theta` / `*.addr.mask` reordered: new row i = old row perm[i]."""
    return {k: v[perm] if KC_ROW_KEYS.search(k) else v for k, v in state_dict.items()}


def convert(ck, wiring, perm):
    """vibe2 model holding the private checkpoint `ck`'s weights, in `wiring`'s KC order."""
    mc = ck["model_config"]
    for field, ok in [("memory", mc.get("memory") == "dopamine"), ("addressing", mc.get("addressing") == "fly"),
                      ("attention_layers", not mc.get("attention_layers")), ("n_head", mc.get("n_head") == 15),
                      ("wiring", mc.get("wiring") == "real")]:
        if not ok:
            raise SystemExit(f"not a plain fly-dopamine checkpoint: model_config[{field!r}] = {mc.get(field)!r}")
    sd = {k: v for k, v in ck["model"].items() if not PRIVATE_DERIVED.search(k)}
    private_mask = wiring.mask[perm.argsort()]                 # undo the permutation: mask.pt as stored
    for b in range(mc["n_layer"]):
        if not torch.equal(sd[f"blocks.{b}.mixer.addr.mask"], private_mask):
            raise SystemExit(f"blocks.{b}.mixer.addr.mask differs from the wiring dir's mask.pt; "
                             f"pass the --wiring-dir this checkpoint was trained with")
    sd = permute_kcs(sd, perm)
    K, G = wiring.mask.shape
    config = dict(vocab_size=mc["vocab_size"], d_model=mc["d_model"], n_layer=mc["n_layer"], n_kc=K, n_glom=G,
                  top_k=round(mc["k_frac"] * K), heads_per_lobe=mc["n_head"] // 3, d_head=mc["head_dim"],
                  conv_k=mc["conv_kernel"], ab_dopamine_max=mc["ab_dopamine_max"])
    model = build(wiring, config)
    model.load_state_dict(sd)                                  # strict: a key mismatch is a porting bug
    return model


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--src", default=DEFAULT_SRC, help="private checkpoint (.pt)")
    p.add_argument("--wiring-dir", default=None,
                   help="private mb_wiring dir (default: <private repo>/<model_config['wiring_dir']>)")
    p.add_argument("--out", default=DEFAULT_OUT)
    a = p.parse_args()

    src = Path(a.src).resolve()
    ck = torch.load(src, map_location="cpu", weights_only=True)
    wiring_dir = a.wiring_dir or src.parents[2] / ck["model_config"]["wiring_dir"]   # <repo>/out/<run>/best.pt
    wiring, perm = load_private_wiring(wiring_dir)
    model = convert(ck, wiring, perm).eval()
    save_checkpoint(a.out, model, wiring, "vibe2", source=str(src), source_step=int(ck["step"]),
                    source_best_val_loss=float(ck["best_val_loss"]),
                    source_data_dir=str(ck["train_config"]["data_dir"]))

    enc = tiktoken.get_encoding("gpt2")
    prompt = "Once upon a time"
    out = model.generate(enc.encode(prompt), 30, temperature=0)
    print(f"source: {src} (step {int(ck['step'])}, best val loss {float(ck['best_val_loss']):.4f})")
    print(f"wrote {a.out}: {sum(p.numel() for p in model.parameters()):,} parameters")
    print(f"greedy: {prompt}{enc.decode(out)}")


if __name__ == "__main__":
    main()
