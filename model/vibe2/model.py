"""fly-dopamine: a faithful port of the private fly-brain-lm "plain fly-dopamine" model.

Reference (private repo, read-only; this file is a direct transcription of it):
  vibes/model.py::FlyMamba              embed, pre-norm blocks, norm_f, tied head
  vibes/fly_dopamine.py::DopamineMixer  the memory block: value_memory_step, _dopamine, forward, step
  vibes/familiarity.py::FamiliarityAddressing.sparse, _code, LearnedDopamine   KC address code, dopamine

Equations for one block. u_t = RMSNorm(h_t) in R^d (d = 384). G = 55 glomeruli, K = 1889 KCs,
H = 3 * heads_per_lobe = 15 heads, P = 48 numbers per head, C = H * P = 720.

  KC address code (FlyAddressing)
    r_t    = softplus(W_r u_t + b_r)                                   receptor activity, (G,)
    g_t    = r_t / (softplus(sigma) + softplus(m) * mean_G(r_t))       glomerular normalization
    g_t    = g_t - mean_G(g_t)                                         centering over glomeruli
    W      = mask * softplus(theta);  W_k <- W_k / ||W_k||_2           per-KC unit-norm wiring, (K, G)
    c_t    = relu(W g_t)                                               KC drive, (K,)
    code_t = c_t with every entry except its top_k = 94 set to 0       sparse code, >= 0
    k_t    = code_t / (max_K(code_t) + 1e-6)                           scaled into [0, 1]

  Dopamine (Dopamine + cap; the cap is applied in the mixer so the key stays dopamine.linear.*)
    d_t    = cap * sigmoid(W_d u_t + b_d),  (H,)
             cap = 0.99 for heads 0-4 (gamma) and 10-14 (alpha'/beta'), ab_dopamine_max for heads 5-9 (alpha/beta)

  Values (DopamineMixer)
    v_t    = W_v u_t, (C,)
    c'_t   = causal depthwise conv over time of v (C channels, width conv_k = 4): c'_t = sum_j w_j v_{t-3+j}
    x_t    = silu(c'_t), viewed as (H, P)
    z_t    = W_z u_t, (C,)

  Memory: per head h and lobe l, S_h has one row per KC of lobe l (K_l = KCs with kc_class == l) and P columns.
    q_t,l  = k_t,l / (sum_{K_l} k_t,l + 1e-6)
    READ   y_t,h     = sum_{k in K_l} q_t,l[k] * S_h[k, :]                      (before the write)
    WRITE  S_h[k, :] <- r_h * (S_h[k, :] + d_t,h * k_t,l[k] * (x_t,h - S_h[k, :]))
    r_h    = exp(-ln 2 / hl_h),    hl_h = 1 + exp(psi_h)                      per-head recovery, half-life hl_h
    skip   y_t,h    <- y_t,h + D_h * x_t,h                                     D init 1

  Output (DopamineMixer._out)
    o_t    = W_o RMSNorm(flatten(y_t) * silu(z_t))                            (flatten: (H, P) -> (C,))
    h_t+1  = h_t + o_t                                                         residual

Whole model: h_0 = embed(tokens); blocks 0..n_layer-1 as above; logits = norm_f(h) @ embed^T (tied head).

Two ways to run the same math (test_vibe2_model.py checks they agree in float64):
  forward(idx)          whole sequence at once; the memory loops over T
  step(tok, state)      one token, carrying the conv window and memory states

Shapes: B batch, T tokens, K = n_kc, G = n_glom. Parameter and buffer names mirror the private state_dict keys
(blocks.N.norm, blocks.N.mixer.{W_v,W_z,conv,addr.*,dopamine.linear,psi,D,out_norm,out_proj}, embed, norm_f), so a
trained private checkpoint loads key-for-key after the KC permutation done in import_weights.py.
"""
import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

NOTE = "fly-dopamine port of fly-brain-lm vibes (DopamineMixer)"
CAPABILITIES = ("kc_mbon_memory",)               # optional features; see model.model.supports_capability


@dataclass
class Config:
    vocab_size: int = 50257
    d_model: int = 384
    n_layer: int = 12
    n_glom: int = 55
    n_kc: int = 1889
    top_k: int = 94                              # private: round(0.05 * 1889)
    heads_per_lobe: int = 5                      # 3 lobes -> 15 heads
    d_head: int = 48
    conv_k: int = 4
    ab_dopamine_max: float = 0.99                # 0.2 in the private "cap" checkpoints
    half_life_init: tuple = (3.0, 69.0, 14.0)    # gamma, alpha/beta, alpha'/beta' (private HALF_LIFE_INIT)

    @property
    def n_head(self) -> int:
        return 3 * self.heads_per_lobe

    @classmethod
    def from_wiring(cls, wiring, **kw):
        K, G = wiring.mask.shape
        return cls(n_kc=K, n_glom=G, **kw)


def sample(logits, temperature=1.0, top_k=None, gen=None):
    """logits (V,) -> one token id. temperature <= 0 means greedy."""
    if temperature <= 0:
        return int(logits.argmax())
    logits = logits.float() / temperature
    if top_k:
        kth = logits.topk(min(top_k, logits.numel())).values[-1]
        logits = logits.masked_fill(logits < kth, float("-inf"))
    return int(torch.multinomial(torch.softmax(logits, -1).cpu(), 1, generator=gen))


class FlyAddressing(nn.Module):
    """Hidden state -> sparse KC address code. Port of FamiliarityAddressing (receptors, sparse, _code)."""

    def __init__(self, cfg: Config, wiring):
        super().__init__()
        self.top_k = cfg.top_k
        self.receptors = nn.Linear(cfg.d_model, cfg.n_glom)          # private: receptors (= receptors_key)
        nn.init.normal_(self.receptors.weight, std=0.02)
        nn.init.zeros_(self.receptors.bias)
        self.sigma_raw = nn.Parameter(torch.tensor(math.log(math.e - 1)))   # softplus(raw) = 1
        self.m_raw = nn.Parameter(torch.tensor(math.log(math.e - 1)))
        self.register_buffer("mask", wiring.mask.clone().bool())     # (K, G) fixed wiring, persistent
        # theta = softplus^-1 of each KC's per-glomerulus synapse share; 0 where there is no wire
        share = wiring.theta.float() * self.mask
        share = share / share.sum(-1, keepdim=True)
        theta0 = torch.where(self.mask, torch.log(torch.expm1(share.clamp_min(1e-6))), torch.zeros(()))
        self.theta = nn.Parameter(theta0)

    def forward(self, u):                                            # u (B, T, d) -> code (B, T, K)
        r = F.softplus(self.receptors(u))                            # (B, T, G) receptor activity
        glom = r / (F.softplus(self.sigma_raw) + F.softplus(self.m_raw) * r.mean(-1, keepdim=True))
        glom = glom - glom.mean(-1, keepdim=True)                    # centered over glomeruli
        w = self.mask * F.softplus(self.theta)                       # (K, G) non-negative wiring weights
        w = w / w.norm(dim=-1, keepdim=True)                         # each KC's row has unit norm
        kc = F.relu(glom @ w.mT)                                     # (B, T, K) KC drive
        vals, idx = kc.topk(self.top_k, dim=-1)                      # keep the top_k KCs
        return torch.zeros_like(kc).scatter(-1, idx, vals)           # (B, T, K) sparse, >= 0


class Dopamine(nn.Module):
    """Per-head dopamine logits: sigmoid(W_d u + b_d). Port of LearnedDopamine (cap applied by the mixer)."""

    def __init__(self, d_model: int, n_head: int = 15):
        super().__init__()
        self.linear = nn.Linear(d_model, n_head)
        nn.init.normal_(self.linear.weight, std=0.02)
        nn.init.constant_(self.linear.bias, -1.0)

    def forward(self, u):                                            # (..., d) -> (..., H)
        return torch.sigmoid(self.linear(u))


class DopamineMixer(nn.Module):
    """The memory block. Port of fly_dopamine.py::DopamineMixer.
    memory_observer: None (default, no extra work) or a callable that _memory() calls once per token
    with detached tensors (see _memory); set through FlyDopamineLM.set_memory_observer."""

    def __init__(self, cfg: Config, wiring):
        super().__init__()
        self.hpl, self.P = cfg.heads_per_lobe, cfg.d_head
        self.H = 3 * self.hpl
        self.C = self.H * self.P
        d = cfg.d_model
        self.W_v = nn.Linear(d, self.C, bias=False)
        self.W_z = nn.Linear(d, self.C, bias=False)
        self.conv = nn.Conv1d(self.C, self.C, cfg.conv_k, groups=self.C, padding=cfg.conv_k - 1)
        for layer in (self.W_v, self.W_z, self.conv):
            nn.init.normal_(layer.weight, std=0.02)
        nn.init.zeros_(self.conv.bias)
        self.addr = FlyAddressing(cfg, wiring)
        self.dopamine = Dopamine(d, self.H)
        # per-head dopamine ceiling: 0.99, except alpha/beta heads (5-9) which take ab_dopamine_max
        self.register_buffer("cap", torch.tensor([0.99] * self.hpl + [cfg.ab_dopamine_max] * self.hpl
                                                 + [0.99] * self.hpl), persistent=False)
        for lobe in range(3):                                        # KC columns of each lobe, non-persistent
            self.register_buffer(f"lobe{lobe}", (wiring.kc_class == lobe).nonzero().squeeze(1), persistent=False)
        # recovery half-life h = 1 + exp(psi); psi initialised so h = 3 / 69 / 14 per lobe
        self.psi = nn.Parameter(torch.log(torch.tensor(cfg.half_life_init).repeat_interleave(self.hpl) - 1.0))
        self.D = nn.Parameter(torch.ones(self.H))
        self.out_norm = nn.RMSNorm(self.C, eps=1e-5)
        self.out_proj = nn.Linear(self.C, d, bias=False)
        nn.init.normal_(self.out_proj.weight, std=0.02 / math.sqrt(2 * cfg.n_layer))
        self.memory_observer = None

    def recovery(self):                                              # (H,) keep-factor r = exp(-ln2 / h)
        h = 1.0 + torch.exp(self.psi)
        return torch.exp(-math.log(2.0) / h)

    def init_state(self, B, device):
        dtype = self.conv.weight.dtype
        mem_dtype = torch.promote_types(dtype, torch.float32)
        return dict(
            conv=torch.zeros(B, self.C, self.conv.kernel_size[0] - 1, device=device, dtype=dtype),  # last 3 inputs
            S=[torch.zeros(B, self.hpl, len(getattr(self, f"lobe{lobe}")), self.P, device=device, dtype=mem_dtype)
               for lobe in range(3)])

    def _memory(self, k, d, x, S):
        """One token of READ-then-WRITE for all heads.
        k (B, K) normalized code; d (B, H) dopamine; x (B, H, P) values; S: 3 x (B, hpl, K_l, P) states.
        Returns y (B, H, P) and the new states.
        With memory_observer set, it is called before returning, under no_grad, with keyword tensors:
        S_before, S_after, delta_raw (gated write before recovery), delta_net (S_after - S_before): 3 x (B, hpl, K_l, P);
        y_read (B, H, P) readout before the D * x skip; d_t (B, H) capped gate; cap, half_life, recovery: (H,);
        k_code (B, K) the normalized code k."""
        dtype = S[0].dtype
        observer = self.memory_observer
        with torch.autocast(device_type=k.device.type, enabled=False):
            k, d, x = k.to(dtype), d.to(dtype), x.to(dtype)
            r = self.recovery().to(dtype)
            ys, new = [], []
            deltas = [] if observer is not None else None
            for lobe in range(3):
                sl = slice(lobe * self.hpl, (lobe + 1) * self.hpl)
                idx = getattr(self, f"lobe{lobe}")
                k_l = k[:, idx]                                                  # (B, K_l)
                q = k_l / (k_l.sum(-1, keepdim=True) + 1e-6)                     # (B, K_l) read weights
                S_l = S[lobe]
                ys.append(torch.einsum("bk,bhkp->bhp", q, S_l))                  # READ first
                dk = d[:, sl, None] * k_l[:, None, :]                            # (B, hpl, K_l)
                if deltas is not None:                                           # telemetry only: the raw gated write
                    deltas.append(dk[..., None] * (x[:, sl, None, :] - S_l))
                S_l = r[sl][None, :, None, None] * (
                    S_l + dk[..., None] * (x[:, sl, None, :] - S_l))             # WRITE, then recovery
                new.append(S_l)
            y = torch.cat(ys, 1)
            if observer is not None:
                with torch.no_grad():
                    observer(S_before=[s.detach() for s in S], y_read=y.detach(),
                             delta_raw=[t.detach() for t in deltas],
                             delta_net=[a.detach() - b.detach() for a, b in zip(new, S)],
                             S_after=[s.detach() for s in new], d_t=d.detach(), cap=self.cap,
                             half_life=(1.0 + torch.exp(self.psi.detach())).to(dtype), recovery=r.detach(),
                             k_code=k.detach())
            return y, new

    def forward(self, u):                                            # u (B, T, d) -> (B, T, d)
        B, T, _ = u.shape
        H, P = self.H, self.P
        c = self.conv(self.W_v(u).transpose(1, 2))[..., :T].transpose(1, 2)   # (B, T, C) causal crop
        z = self.W_z(u)
        x = F.silu(c).view(B, T, H, P)
        code = self.addr(u)                                          # (B, T, K) sparse, unnormalized
        k = code / (code.amax(-1, keepdim=True) + 1e-6)              # (B, T, K) in [0, 1]
        d = self.cap * self.dopamine(u)                              # (B, T, H)
        S = self.init_state(B, u.device)["S"]
        ys = []
        for t in range(T):
            y, S = self._memory(k[:, t], d[:, t], x[:, t], S)
            ys.append(y)
        y = torch.stack(ys, 1)                                       # (B, T, H, P)
        y = y + self.D.view(1, 1, H, 1) * x
        return self.out_proj(self.out_norm(y.reshape(B, T, self.C).to(u.dtype) * F.silu(z)))

    def step(self, u_t, state):                                      # u_t (B, d) -> (B, d), new state
        B = u_t.shape[0]
        H, P = self.H, self.P
        win = torch.cat([state["conv"], self.W_v(u_t)[..., None]], -1)           # (B, C, conv_k), oldest..newest
        c = (win * self.conv.weight[:, 0]).sum(-1) + self.conv.bias               # (B, C)
        x = F.silu(c).view(B, H, P)
        z = self.W_z(u_t)
        code = self.addr(u_t[:, None])[:, 0]                         # (B, K); via forward so the hook fires
        k = code / (code.amax(-1, keepdim=True) + 1e-6)
        d = self.cap * self.dopamine(u_t)                            # (B, H)
        y, S = self._memory(k, d, x, state["S"])
        y = y + self.D.view(1, H, 1) * x
        out = self.out_proj(self.out_norm(y.reshape(B, self.C).to(u_t.dtype) * F.silu(z)))
        return out, dict(conv=win[..., 1:], S=S)


class Block(nn.Module):
    def __init__(self, cfg: Config, wiring):
        super().__init__()
        self.norm = nn.RMSNorm(cfg.d_model, eps=1e-5)
        self.mixer = DopamineMixer(cfg, wiring)

    def forward(self, h):                                            # h (B, T, d)
        return h + self.mixer(self.norm(h))

    def init_state(self, B, device):
        return self.mixer.init_state(B, device)

    def step(self, h, state):                                        # h (B, d)
        out, state = self.mixer.step(self.norm(h), state)
        return h + out, state


class FlyDopamineLM(nn.Module):
    def __init__(self, cfg: Config, wiring):
        super().__init__()
        self.cfg = cfg
        self.embed = nn.Embedding(cfg.vocab_size, cfg.d_model)
        nn.init.normal_(self.embed.weight, std=0.02)                 # default N(0,1) would blow up the loss
        self.blocks = nn.ModuleList([Block(cfg, wiring) for _ in range(cfg.n_layer)])
        self.norm_f = nn.RMSNorm(cfg.d_model, eps=1e-5)

    @property
    def heads_per_lobe(self) -> int:
        return self.cfg.heads_per_lobe

    def kc_code_module(self, block: int) -> nn.Module:
        """Module whose forward output is the (B, T, K) KC address code of `block`; > 0 = active KC."""
        return self.blocks[block].mixer.addr

    def kc_topology(self, block: int):
        """(mask (K, G) bool, lobes: 3 x 1-D long tensors partitioning range(K)) of `block`, read live."""
        mixer = self.blocks[block].mixer
        return mixer.addr.mask, (mixer.lobe0, mixer.lobe1, mixer.lobe2)

    def set_memory_observer(self, observer, block: int = 0) -> None:
        """Install (or with None remove) the memory observer of `block`'s DopamineMixer; see DopamineMixer._memory."""
        self.blocks[block].mixer.memory_observer = observer

    def forward(self, idx, targets=None):                            # idx (B, T) int64
        h = self.embed(idx)
        for blk in self.blocks:
            h = blk(h)
        logits = F.linear(self.norm_f(h), self.embed.weight)         # tied head: (B, T, V)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.reshape(-1, logits.size(-1)), targets.reshape(-1))
        return logits, loss

    def init_state(self, B=1, device="cpu"):
        return [blk.init_state(B, device) for blk in self.blocks]

    def step(self, tok, state):                                      # tok (B,) int64 -> logits (B, V)
        h = self.embed(tok)
        new = []
        for blk, s in zip(self.blocks, state):
            h, s = blk.step(h, s)
            new.append(s)
        return F.linear(self.norm_f(h), self.embed.weight), new

    @torch.no_grad()
    def stream(self, prompt_ids, max_new_tokens, temperature=1.0, top_k=None, stop_ids=(), gen=None):
        """Yield new token ids one at a time. prompt_ids: non-empty list of ints."""
        dev = self.embed.weight.device
        state, logits = self.init_state(1, dev), None
        for t in prompt_ids:                                         # read the prompt into memory
            logits, state = self.step(torch.tensor([t], device=dev), state)
        for i in range(max_new_tokens):
            nxt = sample(logits[0], temperature, top_k, gen)
            yield nxt
            if nxt in stop_ids or i == max_new_tokens - 1:           # don't run the model on a token nobody will use
                return
            logits, state = self.step(torch.tensor([nxt], device=dev), state)

    def generate(self, prompt_ids, max_new_tokens, **kw):
        return list(self.stream(prompt_ids, max_new_tokens, **kw))
