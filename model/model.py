"""Public model loader used by the frozen model/serve/ package. Implementations are registered here.

Build selection: --impl, else env FLYBRAIN_IMPL, else DEFAULT_IMPL. Every checkpoint records its
implementation under "impl" (checkpoints written before that key existed are LEGACY_IMPL). Loading always
follows the checkpoint's "impl". See model/README.md.
"""
import importlib
import os
import sys
from pathlib import Path

import torch

from model.wiring import Wiring

IMPLEMENTATIONS = {"vibe": "model.vibe", "personal": "model.personal", "vibe2": "model.vibe2"}   # name -> importable package; move a package = edit its string
ENV_VAR = "FLYBRAIN_IMPL"
DEFAULT_IMPL = "vibe"
LEGACY_IMPL = "vibe"        # checkpoints written before the "impl" key existed
_REQUIRED = ("NOTE", "build", "export_config", "sanity_checks")
_RESERVED = {"impl", "note", "config", "wiring", "state_dict"}


def _unknown(name: str) -> ValueError:
    return ValueError(f"unknown model implementation {name!r}; choose one of: {', '.join(IMPLEMENTATIONS)}")


def selected_impl(name: str | None = None) -> str:
    """Build-time choice: explicit name, else env FLYBRAIN_IMPL (empty = unset), else DEFAULT_IMPL."""
    choice = name or os.environ.get(ENV_VAR) or DEFAULT_IMPL
    if choice not in IMPLEMENTATIONS:
        raise _unknown(choice)
    return choice


def implementation(name: str):
    """The implementation package for `name`, imported lazily and checked for the interface."""
    if name not in IMPLEMENTATIONS:
        raise _unknown(name)
    module = importlib.import_module(IMPLEMENTATIONS[name])
    missing = [m for m in _REQUIRED if not hasattr(module, m)]
    if missing:
        raise TypeError(f"{IMPLEMENTATIONS[name]} is missing {', '.join(missing)}; see model/README.md#personal-model")
    return module


def check_model(model, name: str) -> None:
    """Fail at build/load if the model lacks what serving and visualization use."""
    missing = []
    if not callable(getattr(model, "stream", None)):
        missing.append("stream")
    if not callable(getattr(model, "kc_code_module", None)):
        missing.append("kc_code_module")
    if not callable(getattr(model, "kc_topology", None)):
        missing.append("kc_topology")
    hpl = getattr(model, "heads_per_lobe", None)
    if not (isinstance(hpl, int) and hpl > 0):
        missing.append("heads_per_lobe")
    if missing:
        raise TypeError(f"{name} model is missing the serving contract: {', '.join(missing)}; "
                        f"see model/README.md#personal-model")


def build_model(wiring, impl: str, config: dict | None = None):
    model = implementation(impl).build(wiring, config)
    check_model(model, impl)
    return model


def save_checkpoint(path, model, wiring, impl: str, **extra):
    clash = _RESERVED & extra.keys()
    if clash:
        raise ValueError(f"reserved checkpoint keys: {sorted(clash)}")
    impl_module = implementation(impl)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    torch.save(dict(impl=impl, note=impl_module.NOTE, config=impl_module.export_config(model),
                    wiring=dict(mask=wiring.mask.cpu(), theta=wiring.theta.cpu(), kc_class=wiring.kc_class.cpu(),
                                kc_ids=wiring.kc_ids, glom_names=wiring.glom_names),
                    state_dict=model.state_dict(), **extra), path)


def load_checkpoint(path, device="cpu"):
    ck = torch.load(path, map_location="cpu", weights_only=True)   # weights_only: never runs code from the file
    name = ck.get("impl", LEGACY_IMPL)
    env = os.environ.get(ENV_VAR)
    if env and env != name:
        print(f"note: {ENV_VAR}={env} selects builds only; {path} was built by {name!r}, loading {name!r}",
              file=sys.stderr)
    wiring = Wiring(**ck["wiring"])
    model = build_model(wiring, name, ck["config"])
    model.load_state_dict(ck["state_dict"])
    return model.to(device).eval(), wiring, ck
