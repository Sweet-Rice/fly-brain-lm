"""The vibe implementation: the AI-built FlyBrainLM scaffold (model.py in this package).

Implementation interface, dispatched by model/model.py: NOTE, build, export_config, sanity_checks.
Intra-package imports are relative so this package can be moved (edit IMPLEMENTATIONS in model/model.py).
"""
import math
from dataclasses import asdict

import torch

from .model import Config, FlyLM, TEMPORARY_NOTE

NOTE = TEMPORARY_NOTE


def build(wiring, config=None):
    """FlyLM from `wiring`. config=None: defaults from the wiring shapes; a dict: export_config() output."""
    cfg = Config.from_wiring(wiring) if config is None else Config(**config)
    return FlyLM(cfg, wiring)


def export_config(model) -> dict:
    """Plain, weights_only-safe dict that build() accepts back."""
    cfg = asdict(model.cfg)
    cfg["half_life_init"] = list(cfg["half_life_init"])
    return cfg


def sanity_checks(model, wiring) -> dict[str, bool]:
    """Untrained-model checks: {description: passed}."""
    cfg = model.cfg
    with torch.no_grad():
        x = torch.randint(0, cfg.vocab_size, (2, 16))       # (B=2, T=16)
        y = torch.randint(0, cfg.vocab_size, (2, 16))
        logits, loss = model(x, y)
        blk = model.blocks[0]
        code = blk.addr(blk.norm(model.emb(x)))             # (2, 16, K)
        return {
            f"logits shape (2, 16, {cfg.vocab_size})": tuple(logits.shape) == (2, 16, cfg.vocab_size),
            "logits finite": bool(torch.isfinite(logits).all()),
            f"exactly {cfg.top_k} KCs active per token": bool(((code > 0).sum(-1) == cfg.top_k).all()),
            "theta zero where there is no wire": bool((blk.addr.theta[~blk.addr.mask] == 0).all()),
            f"untrained loss {loss.item():.2f} within 0.5 of ln(V) = {math.log(cfg.vocab_size):.2f}":
                abs(loss.item() - math.log(cfg.vocab_size)) < 0.5,
        }
