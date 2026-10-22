"""FlyBrainLM -- TEMPORARY SCAFFOLD.

Purpose: prove the model can be built from the real MaleCNS wiring, initialized, run, saved and
served. It is UNTRAINED and NOT the final architecture: several details are placeholder guesses
(pre-norm residual, KC code centering and [0,1] scaling, recovery applied to every column, sigma/m
init, bias placement) to be checked against the design before training.

Two ways to run the same math:
  forward(idx)          whole sequence at once (training)          python loop over tokens inside
  step(tok, state)      one token, carrying state (generation)     O(1) per token
test_vibe_model.py checks they give identical logits in float64.

Shapes: B batch, T tokens, d d_model (384), G glomeruli (54 from build_wiring), K KCs (1889),
H = 15 heads (5 per lobe), dh = 48 numbers per head, V vocab (50257).
"""
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from model.wiring import Wiring

TEMPORARY_NOTE = "TEMPORARY scaffold: untrained, placeholder architecture details"
CAPABILITIES = ("kc_mbon_memory",)               # optional features; see model.model.supports_capability


@dataclass
class Config:
    vocab_size: int = 50257
    d_model: int = 384
    n_layer: int = 12
    n_glom: int = 54
    n_kc: int = 1889
    top_k: int = 94
    heads_per_lobe: int = 5                      # 3 lobes -> 15 heads
    d_head: int = 48
    conv_k: int = 4
    half_life_init: tuple = (3.0, 69.0, 14.0)    # gamma, alpha/beta, alpha'/beta'

    @property
    def n_head(self) -> int:
        return 3 * self.heads_per_lobe

    @classmethod
    def from_wiring(cls, wiring, **kw):
        K, G = wiring.mask.shape
        return cls(n_kc=K, n_glom=G, **kw)


class RMSNorm(nn.Module):
    def __init__(self, d: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(d))

    def forward(self, x):                        # (..., d)
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps) * self.weight


class FlyAddress(nn.Module):
    """receptors -> glomerular normalization -> masked KC drive -> center -> ReLU -> top-k."""

    def __init__(self, cfg: Config, wiring: Wiring):
        super().__init__()
        self.top_k = cfg.top_k
        self.receptors = nn.Linear(cfg.d_model, cfg.n_glom)
        self.sigma_raw = nn.Parameter(torch.zeros(()))       # sigma = softplus(raw) > 0
        self.m_raw = nn.Parameter(torch.zeros(()))           # m     = softplus(raw) > 0
        self.register_buffer("mask", wiring.mask.clone())    # buffer: saved, never trained
        self.theta = nn.Parameter(wiring.theta.clone().float())

    def forward(self, x):                                    # x: (B, T, d)
        r = F.softplus(self.receptors(x))                    # (B, T, G)
        sigma, m = F.softplus(self.sigma_raw), F.softplus(self.m_raw)
        glom = r / (sigma + m * r.mean(-1, keepdim=True))    # (B, T, G)
        w = self.theta * self.mask                           # (K, G); 0 where no wire -> 0 grad
        drive = glom @ w.t()                                 # (B, T, K)
        drive = F.relu(drive - drive.mean(-1, keepdim=True)) # centered, then ReLU
        vals, idx = drive.topk(self.top_k, dim=-1)           # (B, T, 94) each
        vals = vals / (vals.max(-1, keepdim=True).values + 1e-6)   # scale into [0, 1]
        return torch.zeros_like(drive).scatter(-1, idx, vals)      # (B, T, K), 94 nonzero


class FlyMemory(nn.Module):
    """Per token: READ the memory, then WRITE it. Each lobe has its own KC columns and its own
    5 heads. State per lobe: S (B, 5, K_lobe, 48). Math runs in at least fp32.
    memory_observer: None (default, no extra work) or a callable that step() calls once per token
    with detached tensors (see step); set through FlyLM.set_memory_observer."""

    def __init__(self, cfg: Config, kc_class: torch.Tensor):
        super().__init__()
        self.hpl, self.dh = cfg.heads_per_lobe, cfg.d_head
        for l in range(3):
            self.register_buffer(f"lobe{l}", (kc_class == l).nonzero().squeeze(1), persistent=False)
        hl = torch.tensor(cfg.half_life_init).repeat_interleave(self.hpl)   # (15,)
        self.psi = nn.Parameter(torch.log(hl - 1.0))         # half-life h = 1 + exp(psi)
        self.memory_observer = None

    def recovery(self):                                      # (15,) per-token keep-factor r
        h = 1.0 + torch.exp(self.psi)
        return 0.5 ** (1.0 / h)                              # after h tokens, memory is halved

    def init_state(self, B, device, dtype=torch.float32):
        return [torch.zeros(B, self.hpl, len(getattr(self, f"lobe{l}")), self.dh, device=device, dtype=dtype)
                for l in range(3)]

    def step(self, code_t, v_t, d_t, S):
        """code_t (B, K), v_t (B, 15, 48), d_t (B, 15), S: 3 x (B, 5, K_l, 48) -> y_t (B, 15, 48), new S
        With memory_observer set, it is called before returning, under no_grad, with keyword tensors:
        S_before, S_after, delta_raw (gated write before recovery), delta_net (S_after - S_before): 3 x (B, 5, K_l, 48);
        y_read (B, 15, 48) readout; d_t (B, 15) gate used; cap, half_life, recovery: (15,); k_code (B, K) code used."""
        dt, H = S[0].dtype, self.hpl
        observer = self.memory_observer
        with torch.autocast(device_type=code_t.device.type, enabled=False):
            code_t, v_t, d_t = code_t.to(dt), v_t.to(dt), d_t.to(dt)
            r = self.recovery().to(dt)
            ys, S_new = [], []
            deltas = [] if observer is not None else None
            for l in range(3):
                k = code_t[:, getattr(self, f"lobe{l}")]          # (B, K_l)
                vl = v_t[:, l * H:(l + 1) * H]                    # (B, 5, 48)
                dl = d_t[:, l * H:(l + 1) * H]                    # (B, 5)
                rl = r[l * H:(l + 1) * H]                         # (5,)
                # READ first: weighted average of stored values over active columns
                num = torch.einsum("bk,bhkd->bhd", k, S[l])       # (B, 5, 48)
                den = k.sum(-1).clamp_min(1e-6)                   # (B,)  empty code -> y = 0
                ys.append(num / den[:, None, None])
                # WRITE: move active columns toward the new value, then recover
                dk = dl[:, :, None] * k[:, None, :]               # (B, 5, K_l)
                if deltas is not None:                            # telemetry only: the raw gated write
                    deltas.append(dk[..., None] * (vl[:, :, None, :] - S[l]))
                S_new.append(rl[None, :, None, None] * (S[l] + dk[..., None] * (vl[:, :, None, :] - S[l])))
            y = torch.cat(ys, dim=1)                              # (B, 15, 48)
            if observer is not None:
                with torch.no_grad():
                    observer(S_before=[s.detach() for s in S], y_read=y.detach(),
                             delta_raw=[x.detach() for x in deltas],
                             delta_net=[a.detach() - b.detach() for a, b in zip(S_new, S)],
                             S_after=[s.detach() for s in S_new], d_t=d_t.detach(),
                             cap=torch.full((3 * H,), 0.99, dtype=dt, device=d_t.device),
                             half_life=(1.0 + torch.exp(self.psi.detach())).to(dt), recovery=r.detach(),
                             k_code=code_t.detach())
        return y, S_new

    def forward(self, code, v, d):
        """Slow loop. code (B, T, K), v (B, T, 15, 48), d (B, T, 15) -> y (B, T, 15, 48)"""
        B, T, _ = code.shape
        S = self.init_state(B, code.device, torch.promote_types(v.dtype, torch.float32))
        ys = []
        for t in range(T):
            y, S = self.step(code[:, t], v[:, t], d[:, t], S)
            ys.append(y)
        return torch.stack(ys, dim=1)


class Block(nn.Module):
    def __init__(self, cfg: Config, wiring: Wiring):
        super().__init__()
        self.cfg = cfg
        H, dh, d = cfg.n_head, cfg.d_head, cfg.d_model
        self.norm = RMSNorm(d)
        self.addr = FlyAddress(cfg, wiring)
        self.v_proj = nn.Linear(d, H * dh, bias=False)
        self.conv = nn.Conv1d(H * dh, H * dh, cfg.conv_k, groups=H * dh)   # depthwise: one filter per channel
        self.gate = nn.Linear(d, H * dh)
        self.dopa = nn.Linear(d, H)
        self.mem = FlyMemory(cfg, wiring.kc_class)
        self.out = nn.Linear(H * dh, d, bias=False)

    def forward(self, x):                                     # x: (B, T, d)
        B, T, _ = x.shape
        H, dh = self.cfg.n_head, self.cfg.d_head
        u = self.norm(x)                                      # pre-norm
        code = self.addr(u)                                   # (B, T, K)
        v = self.v_proj(u).transpose(1, 2)                    # (B, 720, T)
        v = self.conv(F.pad(v, (self.cfg.conv_k - 1, 0)))     # pad LEFT only -> causal
        v = v.transpose(1, 2).reshape(B, T, H, dh)            # (B, T, 15, 48)
        d = 0.99 * torch.sigmoid(self.dopa(u))                # (B, T, 15)
        y = self.mem(code, v, d)                              # (B, T, 15, 48)
        y = y.reshape(B, T, H * dh).to(x.dtype) * torch.sigmoid(self.gate(u))
        return x + self.out(y)                                # residual

    def init_state(self, B, device):
        C, w = self.cfg.n_head * self.cfg.d_head, self.conv.weight
        return dict(conv=torch.zeros(B, C, self.cfg.conv_k - 1, device=device, dtype=w.dtype),   # last 3 inputs
                    S=self.mem.init_state(B, device, torch.promote_types(w.dtype, torch.float32)))

    def step(self, x, state):                                 # x: (B, d) one token
        B = x.shape[0]
        H, dh = self.cfg.n_head, self.cfg.d_head
        u = self.norm(x)
        code = self.addr(u[:, None])[:, 0]                    # (B, K)
        win = torch.cat([state["conv"], self.v_proj(u)[:, :, None]], dim=-1)   # (B, 720, 4) oldest..newest
        v = (win * self.conv.weight[:, 0]).sum(-1) + self.conv.bias            # (B, 720), same as the conv
        d = 0.99 * torch.sigmoid(self.dopa(u))                # (B, 15)
        y, S = self.mem.step(code, v.view(B, H, dh), d, state["S"])
        y = y.reshape(B, H * dh).to(x.dtype) * torch.sigmoid(self.gate(u))
        return x + self.out(y), dict(conv=win[:, :, 1:], S=S)


def sample(logits, temperature=1.0, top_k=None, gen=None):
    """logits (V,) -> one token id. temperature <= 0 means greedy."""
    if temperature <= 0:
        return int(logits.argmax())
    logits = logits.float() / temperature
    if top_k:
        kth = logits.topk(min(top_k, logits.numel())).values[-1]
        logits = logits.masked_fill(logits < kth, float("-inf"))
    return int(torch.multinomial(torch.softmax(logits, -1).cpu(), 1, generator=gen))


class FlyLM(nn.Module):
    def __init__(self, cfg: Config, wiring: Wiring):
        super().__init__()
        self.cfg = cfg
        self.emb = nn.Embedding(cfg.vocab_size, cfg.d_model)
        nn.init.normal_(self.emb.weight, std=0.02)            # default N(0,1) would blow up the loss
        self.blocks = nn.ModuleList([Block(cfg, wiring) for _ in range(cfg.n_layer)])
        self.norm_f = RMSNorm(cfg.d_model)

    @property
    def heads_per_lobe(self) -> int:
        return self.cfg.heads_per_lobe

    def kc_code_module(self, block: int) -> nn.Module:
        """Module whose forward output is the (B, T, K) KC address code of `block`; > 0 = active KC."""
        return self.blocks[block].addr

    def kc_topology(self, block: int):
        """(mask, lobes) of `block`, read live from the model: mask (K, G) bool; lobes is a tuple of three
        one-dimensional KC index tensors partitioning range(K). Raises IndexError for a missing block."""
        blk = self.blocks[block]
        addr, mem = blk.addr, blk.mem
        if addr.theta.shape != addr.mask.shape or addr.receptors.out_features != addr.mask.shape[1]:
            raise ValueError("address mask must match KC weights and the glomerulus projection")
        return addr.mask, (mem.lobe0, mem.lobe1, mem.lobe2)

    def set_memory_observer(self, observer, block: int = 0) -> None:
        """Install (or with None remove) the memory observer of `block`'s FlyMemory; see FlyMemory.step."""
        self.blocks[block].mem.memory_observer = observer

    def forward(self, idx, targets=None):                     # idx: (B, T) int64
        x = self.emb(idx)                                     # (B, T, d)
        for blk in self.blocks:
            x = blk(x)
        logits = self.norm_f(x) @ self.emb.weight.t()         # tied head: (B, T, V)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.reshape(-1, logits.size(-1)), targets.reshape(-1))
        return logits, loss

    def init_state(self, B=1, device="cpu"):
        return [blk.init_state(B, device) for blk in self.blocks]

    def step(self, tok, state):                               # tok: (B,) int64 -> logits (B, V)
        x = self.emb(tok)
        new = []
        for blk, s in zip(self.blocks, state):
            x, s = blk.step(x, s)
            new.append(s)
        return self.norm_f(x) @ self.emb.weight.t(), new

    @torch.no_grad()
    def stream(self, prompt_ids, max_new_tokens, temperature=1.0, top_k=None, stop_ids=(), gen=None):
        """Yield new token ids one at a time. prompt_ids: non-empty list of ints."""
        dev = self.emb.weight.device
        state, logits = self.init_state(1, dev), None
        for t in prompt_ids:                                  # read the prompt into memory
            logits, state = self.step(torch.tensor([t], device=dev), state)
        for i in range(max_new_tokens):
            nxt = sample(logits[0], temperature, top_k, gen)
            yield nxt
            if nxt in stop_ids or i == max_new_tokens - 1:   # don't run the model on a token nobody will use
                return
            logits, state = self.step(torch.tensor([nxt], device=dev), state)

    def generate(self, prompt_ids, max_new_tokens, **kw):
        return list(self.stream(prompt_ids, max_new_tokens, **kw))
