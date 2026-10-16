"""TEMPORARY: build FlyLM from the real wiring, sanity-check it, save an UNTRAINED checkpoint.

Proves the model can be created and initialized. Not the final architecture (see model.py).

Usage (from the repo root):
        python -m model.init_model                 # -> model/checkpoints/init.pt
        python -m model.init_model --seed 1 --out model/checkpoints/init_s1.pt
"""
import argparse
import math
import os

import torch

from data.build_wiring import load_wiring
from model.model import Config, FlyLM, save_checkpoint


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="model/checkpoints/init.pt")
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args()

    torch.manual_seed(a.seed)
    w = load_wiring()                                       # data/connectome/wiring.npz
    cfg = Config.from_wiring(w)
    model = FlyLM(cfg, w).eval()
    K, G = w.mask.shape
    n = sum(p.numel() for p in model.parameters())
    print(f"wiring: {K} KCs x {G} glomeruli, {int(w.mask.sum())} connections, "
          f"classes {torch.bincount(w.kc_class).tolist()}")
    print(f"model:  {cfg.n_layer} blocks, d_model {cfg.d_model}, {n:,} parameters")

    x = torch.randint(0, cfg.vocab_size, (2, 16))           # (B=2, T=16)
    y = torch.randint(0, cfg.vocab_size, (2, 16))
    with torch.no_grad():
        logits, loss = model(x, y)
        blk = model.blocks[0]
        code = blk.addr(blk.norm(model.emb(x)))             # (2, 16, K)
    checks = {
        f"logits shape (2, 16, {cfg.vocab_size})": tuple(logits.shape) == (2, 16, cfg.vocab_size),
        "logits finite": bool(torch.isfinite(logits).all()),
        f"exactly {cfg.top_k} KCs active per token": bool(((code > 0).sum(-1) == cfg.top_k).all()),
        "theta zero where there is no wire": bool((blk.addr.theta[~blk.addr.mask] == 0).all()),
        f"untrained loss {loss.item():.2f} within 0.5 of ln(V) = {math.log(cfg.vocab_size):.2f}":
            abs(loss.item() - math.log(cfg.vocab_size)) < 0.5,
    }
    for name, ok in checks.items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not all(checks.values()):
        raise SystemExit("init checks failed; checkpoint NOT written")

    save_checkpoint(a.out, model, w, seed=a.seed)
    print(f"wrote {a.out} ({os.path.getsize(a.out) / 1e6:.0f} MB). TEMPORARY, untrained.")


if __name__ == "__main__":
    main()
