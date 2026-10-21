"""Wiring: the fixed fly connectome as tensors. Implementation-independent data shared by every
model implementation, the visualization (harness/viz_stream.py) and data/build_wiring.load_wiring."""
from dataclasses import dataclass

import torch


@dataclass
class Wiring:
    mask: torch.Tensor        # (K, G) bool   which KC listens to which glomerulus (fixed)
    theta: torch.Tensor       # (K, G) float  initial strengths (learned)
    kc_class: torch.Tensor    # (K,) long     0 = gamma, 1 = alpha/beta, 2 = alpha'/beta'
    kc_ids: list | None = None       # KC body IDs (visualization)
    glom_names: list | None = None   # glomerulus names (visualization)

    @staticmethod
    def random(n_kc=1889, n_glom=54, per_kc=5, class_counts=(663, 874, 352), seed=0):
        """Fake wiring with the real shapes, for tests. Real wiring: build_wiring.load_wiring()."""
        assert sum(class_counts) == n_kc
        g = torch.Generator().manual_seed(seed)
        mask = torch.zeros(n_kc, n_glom, dtype=torch.bool)
        for k in range(n_kc):
            mask[k, torch.randperm(n_glom, generator=g)[:per_kc]] = True
        counts = torch.randint(3, 9, (n_kc, n_glom), generator=g).float()
        theta = counts * mask
        theta = theta / theta[mask].mean()
        kc_class = torch.cat([torch.full((c,), i, dtype=torch.long) for i, c in enumerate(class_counts)])
        return Wiring(mask, theta, kc_class)
