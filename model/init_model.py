"""TEMPORARY: build a model implementation from the real wiring, sanity-check it, save an UNTRAINED checkpoint.

Proves the model can be created and initialized. The implementation is chosen by --impl, else env
FLYBRAIN_IMPL, else vibe (see model/model.py).

Usage (from the repo root):
        python -m model.init_model                          # -> model/checkpoints/vibe.pt
        python -m model.init_model --impl personal          # -> model/checkpoints/personal.pt
        FLYBRAIN_IMPL=personal python -m model.init_model   # same as --impl personal
        python -m model.init_model --impl vibe --seed 1 --out model/checkpoints/vibe_s1.pt
"""
import argparse
import os

import torch

from data.build_wiring import load_wiring
from model.model import IMPLEMENTATIONS, build_model, implementation, save_checkpoint, selected_impl


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--impl", choices=list(IMPLEMENTATIONS), default=None)
    p.add_argument("--out", default=None)                   # default: model/checkpoints/<impl>.pt
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args()

    try:
        impl = selected_impl(a.impl)
    except ValueError as e:
        raise SystemExit(str(e))
    out = a.out or f"model/checkpoints/{impl}.pt"
    print(f"implementation: {impl} ({IMPLEMENTATIONS[impl]})")

    torch.manual_seed(a.seed)
    w = load_wiring()                                       # data/connectome/wiring.npz
    K, G = w.mask.shape
    print(f"wiring: {K} KCs x {G} glomeruli, {int(w.mask.sum())} connections, "
          f"classes {torch.bincount(w.kc_class).tolist()}")
    try:
        model = build_model(w, impl).eval()
        checks = implementation(impl).sanity_checks(model, w)
    except NotImplementedError as e:
        raise SystemExit(f"{impl} model is not implemented yet: {e}")
    n = sum(p.numel() for p in model.parameters())
    print(f"model:  {type(model).__name__}, {n:,} parameters")
    for name, ok in checks.items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not all(checks.values()):
        raise SystemExit("init checks failed; checkpoint NOT written")

    try:
        save_checkpoint(out, model, w, impl, seed=a.seed)
    except NotImplementedError as e:
        raise SystemExit(f"{impl} model is not implemented yet: {e}")
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.0f} MB): {impl} model, untrained.")


if __name__ == "__main__":
    main()
