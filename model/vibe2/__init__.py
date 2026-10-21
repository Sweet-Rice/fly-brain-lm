"""The fly-dopamine implementation (model/vibe2/): a port of the private plain fly-dopamine model.

Implementation interface, dispatched by model/model.py: NOTE, build, export_config, sanity_checks.
Intra-package imports are relative so this package can be moved (edit IMPLEMENTATIONS in model/model.py).
"""
import math
from dataclasses import asdict

import torch

from .model import Config, FlyDopamineLM, NOTE


def build(wiring, config=None):
    """FlyDopamineLM from `wiring`. config=None: defaults from the wiring shapes; a dict: export_config() output."""
    cfg = Config.from_wiring(wiring) if config is None else Config(**config)
    return FlyDopamineLM(cfg, wiring)


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
        code = model.kc_code_module(0)(blk.norm(model.embed(x)))   # (2, 16, K)
        active = (code > 0).sum(-1)
        return {
            f"logits shape (2, 16, {cfg.vocab_size})": tuple(logits.shape) == (2, 16, cfg.vocab_size),
            "logits finite": bool(torch.isfinite(logits).all()),
            # centering leaves fewer than top_k positive drives on some tokens, so this is a range, not equality
            f"1..{cfg.top_k} KCs active per token": bool(((active >= 1) & (active <= cfg.top_k)).all()),
            "theta zero where there is no wire": bool((blk.mixer.addr.theta[~blk.mixer.addr.mask] == 0).all()),
            f"untrained loss {loss.item():.2f} within 0.5 of ln(V) = {math.log(cfg.vocab_size):.2f}":
                abs(loss.item() - math.log(cfg.vocab_size)) < 0.5,
        }
