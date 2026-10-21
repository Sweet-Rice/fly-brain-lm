import importlib

import torch

from model.model import IMPLEMENTATIONS
from model.wiring import Wiring

vibe2 = importlib.import_module(f"{IMPLEMENTATIONS['vibe2']}.model")
Config, FlyDopamineLM = vibe2.Config, vibe2.FlyDopamineLM
permute_kcs = importlib.import_module(f"{IMPLEMENTATIONS['vibe2']}.import_weights").permute_kcs

torch.manual_seed(0)
WIRING = Wiring.random()
TINY = Config(d_model=64, n_layer=2, n_glom=54)


def test_step_matches_forward_float64():
    """Token-by-token generation path == whole-sequence path, to ~1e-10 in float64."""
    model = FlyDopamineLM(TINY, WIRING).double().eval()
    idx = torch.randint(0, 50257, (2, 12))
    with torch.no_grad():
        full, _ = model(idx)                                  # (2, 12, V)
        state, steps = model.init_state(2), []
        for t in range(idx.shape[1]):
            logits, state = model.step(idx[:, t], state)      # (2, V)
            steps.append(logits)
    err = (torch.stack(steps, 1) - full).abs().max().item()
    print("max |step - forward|:", err)
    assert err < 1e-10


def test_kc_permutation_preserves_logits():
    """Relabelling the KCs (wiring, weights and mask together) leaves the logits unchanged in float64."""
    K = WIRING.mask.shape[0]
    perm = torch.randperm(K)
    wiring_b = Wiring(WIRING.mask[perm], WIRING.theta[perm], WIRING.kc_class[perm])
    a = FlyDopamineLM(TINY, WIRING).double().eval()
    b = FlyDopamineLM(TINY, wiring_b).double().eval()
    b.load_state_dict(permute_kcs(a.state_dict(), perm))
    idx = torch.randint(0, 50257, (2, 10))
    with torch.no_grad():
        la, _ = a(idx)
        lb, _ = b(idx)
    err = (la - lb).abs().max().item()
    print("max |permuted - original|:", err)
    assert err < 1e-10


def test_kc_code_fires_once_per_processed_token():
    """The viz hook on kc_code_module(0) fires once per processed token: prompt + all but the last generated."""
    model = FlyDopamineLM(TINY, WIRING).eval()
    K = WIRING.mask.shape[0]
    shapes, total = [], [0]

    def hook(module, inputs, output):
        shapes.append(tuple(output.shape))
        total[0] += output.shape[1]

    handle = model.kc_code_module(0).register_forward_hook(hook)
    try:
        out = list(model.stream([1, 2, 3, 4], 3, temperature=0))
    finally:
        handle.remove()
    assert len(out) == 3
    assert total[0] == 4 + 2                                  # no model step on the final generated token
    assert all(s == (1, 1, K) for s in shapes)


def test_ab_dopamine_cap():
    """ab_dopamine_max caps only the alpha/beta heads (5-9); the other heads keep the 0.99 ceiling."""
    model = FlyDopamineLM(Config(d_model=64, n_layer=2, n_glom=54, ab_dopamine_max=0.2), WIRING).eval()
    mixer = model.blocks[0].mixer
    with torch.no_grad():
        mixer.dopamine.linear.bias.fill_(20.0)                # sigmoid ~ 1 for every head
        u = torch.randn(1, 3, 64)
        d = mixer.cap * mixer.dopamine(u)                     # (1, 3, 15)
    assert (d[..., 5:10] <= 0.2).all()
    assert (d[..., 5:10] > 0.19).all()
    assert (d[..., :5] > 0.9).all() and (d[..., 10:] > 0.9).all()


def test_checkpoint_roundtrip(tmp_path):
    from model.model import save_checkpoint, load_checkpoint
    model = FlyDopamineLM(TINY, WIRING).eval()
    p = tmp_path / "ck.pt"
    save_checkpoint(p, model, WIRING, "vibe2")
    loaded, w, ck = load_checkpoint(p)
    assert type(loaded) is FlyDopamineLM and ck["impl"] == "vibe2"
    idx = torch.randint(0, 50257, (1, 8))
    with torch.no_grad():
        assert torch.equal(model(idx)[0], loaded(idx)[0])
