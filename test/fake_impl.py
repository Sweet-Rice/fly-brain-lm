"""Minimal second model implementation, used only by test/test_model_registry.py.

It proves that checkpoint dispatch, serving and visualization depend on the implementation contract
(model/README.md#personal-model), not on the vibe model. It is greedy and ignores temperature/top_k/gen.
"""
import torch
from torch import nn

NOTE = "fake test implementation"
VOCAB = 50257


class FakeLM(nn.Module):
    def __init__(self, wiring, width=4):
        super().__init__()
        self.width = width
        self.heads_per_lobe = 1
        K = wiring.mask.shape[0]
        self.mask, self.kc_class = wiring.mask.clone(), wiring.kc_class.clone()
        self.emb = nn.Embedding(VOCAB, width)
        self.code = nn.Linear(width, K)                      # the KC code: forward output (B, T, K)
        self.head = nn.Linear(width, VOCAB)

    def kc_code_module(self, block):
        return self.code

    def kc_topology(self, block):
        if block != 0:                                       # one block only; others do not exist
            raise IndexError(f"block {block} does not exist")
        return self.mask, tuple((self.kc_class == lobe).nonzero().squeeze(1) for lobe in range(3))

    @torch.no_grad()
    def stream(self, prompt_ids, max_new_tokens, temperature=1.0, top_k=None, stop_ids=(), gen=None):
        last = prompt_ids[-1]
        for _ in range(max_new_tokens):
            x = self.emb(torch.tensor([[last]]))             # (1, 1, width)
            self.code(x)                                     # fires the visualization hook once per step
            tok = int(self.head(x)[0, -1].argmax())
            yield tok
            if tok in stop_ids:
                return
            last = tok


def build(wiring, config=None):
    return FakeLM(wiring, **(config or {"width": 4}))


def export_config(model) -> dict:
    return {"width": model.width}


def sanity_checks(model, wiring) -> dict[str, bool]:
    return {"fake builds": True}
