import math
import torch
import torch.nn.functional as F
from model.model import Config, Wiring, FlyAddress, FlyMemory, FlyLM

torch.manual_seed(0)
WIRING = Wiring.random()
TINY = Config(d_model=64, n_layer=2)


def test_address_exactly_94_active():
    addr = FlyAddress(TINY, WIRING)
    code = addr(torch.randn(2, 5, 64))
    assert code.shape == (2, 5, 1889)
    assert ((code > 0).sum(-1) == 94).all()


def test_address_zero_grad_where_mask_is_0():
    addr = FlyAddress(TINY, WIRING)
    code = addr(torch.randn(2, 5, 64))
    (code * torch.randn_like(code)).sum().backward()
    assert addr.theta.grad[~addr.mask].abs().max() == 0
    assert addr.theta.grad[addr.mask].abs().sum() > 0


def _manual_code(T=2):
    code = torch.zeros(1, T, 1889)
    for l in range(3):
        code[:, :, (WIRING.kc_class == l).nonzero()[:10, 0]] = 1.0
    return code


def test_memory_first_read_is_zero_and_repeat_is_recalled():
    mem = FlyMemory(TINY, WIRING.kc_class)
    code = _manual_code()
    v = torch.randn(1, 2, 15, 48)
    d = torch.full((1, 2, 15), 0.9)
    y = mem(code, v, d)
    assert (y[:, 0] == 0).all()                               # nothing stored yet
    cos = F.cosine_similarity(y[0, 1], v[0, 0], dim=-1)       # (15,)
    assert (cos > 0.999).all()                                # same code -> same direction back


def test_memory_empty_code_stays_finite():
    mem = FlyMemory(TINY, WIRING.kc_class)
    code = torch.zeros(1, 3, 1889)
    y = mem(code, torch.randn(1, 3, 15, 48), torch.full((1, 3, 15), 0.9))
    assert torch.isfinite(y).all() and (y == 0).all()


def test_causality():
    model = FlyLM(TINY, WIRING).eval()
    a = torch.randint(0, 50257, (1, 16))
    b = a.clone()
    b[0, 10] = (a[0, 10] + 1) % 50257
    with torch.no_grad():
        la, _ = model(a)
        lb, _ = model(b)
    assert torch.allclose(la[:, :10], lb[:, :10], atol=1e-6)
    assert not torch.allclose(la[:, 10], lb[:, 10], atol=1e-6)


def test_param_count_full_size():
    n = sum(p.numel() for p in FlyLM(Config(), WIRING).parameters())
    print("params:", n)
    assert 30.8e6 < n < 31.0e6


def test_untrained_loss_near_ln_vocab():
    model = FlyLM(TINY, WIRING)
    x = torch.randint(0, 50257, (2, 16))
    y = torch.randint(0, 50257, (2, 16))
    with torch.no_grad():
        _, loss = model(x, y)
    print("loss:", loss.item(), "ln V:", math.log(50257))
    assert 10.4 < loss.item() < 11.3


def test_step_matches_forward_float64():
    """Token-by-token generation path == whole-sequence path, to ~1e-10 in float64."""
    model = FlyLM(TINY, WIRING).double().eval()
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


def test_greedy_generation_is_deterministic():
    model = FlyLM(TINY, WIRING).eval()
    a = model.generate([1, 2, 3], 5, temperature=0)
    b = model.generate([1, 2, 3], 5, temperature=0)
    assert a == b and len(a) == 5


def test_checkpoint_roundtrip(tmp_path):
    from model.model import save_checkpoint, load_checkpoint
    model = FlyLM(TINY, WIRING).eval()
    p = tmp_path / "ck.pt"
    save_checkpoint(p, model, WIRING)
    loaded, w, ck = load_checkpoint(p)
    idx = torch.randint(0, 50257, (1, 8))
    with torch.no_grad():
        assert torch.equal(model(idx)[0], loaded(idx)[0])
    assert torch.equal(w.mask, WIRING.mask) and "TEMPORARY" in ck["note"]


def test_can_overfit_one_batch():
    model = FlyLM(TINY, WIRING)
    x = torch.randint(0, 50257, (2, 16))
    y = torch.randint(0, 50257, (2, 16))
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    first = None
    for _ in range(60):
        _, loss = model(x, y)
        first = first if first is not None else loss.item()
        opt.zero_grad()
        loss.backward()
        opt.step()
    print("overfit:", first, "->", loss.item())
    assert loss.item() < 0.5 * first
