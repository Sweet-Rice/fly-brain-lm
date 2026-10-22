"""KC-MBON recurrent memory and dopamine telemetry: the additive Protocol v1 `memory_summary` and `memory_slice`
messages (harness/protocol/v1/SPEC.md, "Extension messages (additive)"; schemas memory_*.schema.json).

MemoryTelemetry is installed with model.set_memory_observer() on implementations that declare the "kc_mbon_memory"
capability (model.model.supports_capability). The model calls it once per memory write of the observed block with
detached tensors (FlyMemory.step in model/vibe, DopamineMixer._memory in model/vibe2). Writes outside a request, or
outside a model step, are ignored. Every message goes through the run/token telemetry adapter's emit(), which adds
the shared `seq`; `run_id`, `request_id`, `epoch` and `t` come from the same adapter as its token events.

Values are integers (round(value * scale)) or the strings "nan", "inf", "-inf". Host transfers per write: one for
the summary vectors, one for the KC code row, one for all selected slice rows; never one per element.
"""
import math
from dataclasses import dataclass

import torch

from model.model import supports_capability

CAPABILITY = "kc_mbon_memory"


@dataclass(frozen=True)
class MemoryTelemetryConfig:
    scale: int = 10000          # wire integer = round(value * scale)
    summary_stride: int = 1     # memory_summary on writes rev 1, 1 + stride, 1 + 2 * stride, ...
    slice_stride: int = 1       # memory_slice messages on writes rev 1, 1 + stride, ...
    max_kc_slices: int = 4      # most active KCs (k > 0) sliced per write; one message per head of the KC's lobe
    block: int = 0              # model block whose memory is observed

    def __post_init__(self):
        if min(self.scale, self.summary_stride, self.slice_stride) < 1 or min(self.max_kc_slices, self.block) < 0:
            raise ValueError("scale and strides must be >= 1; max_kc_slices and block must be >= 0")

    def quantize(self, value: float) -> int | str:
        """Wire form of one real value: round(value * scale) (half to even), or "nan" / "inf" / "-inf"."""
        scaled = value * self.scale
        if math.isnan(scaled):
            return "nan"
        if math.isinf(scaled):
            return "inf" if scaled > 0 else "-inf"
        return round(scaled)


class MemoryTelemetry:
    """Memory observer that turns each observed write into memory_summary / memory_slice messages."""

    def __init__(self):
        self.adapter = self.model = None
        self.config = MemoryTelemetryConfig()
        self._kc_lobe, self._kc_row = [], []   # global KC id -> lobe, and row in that lobe's state S
        self._request_id, self._rev = None, 0

    def attach(self, adapter, model, impl_name: str, config: MemoryTelemetryConfig = MemoryTelemetryConfig()) -> bool:
        """Observe `config.block` of `model` and emit through `adapter`. Returns False, installing and emitting
        nothing, when implementation `impl_name` does not support KC-MBON memory telemetry."""
        if not supports_capability(impl_name, CAPABILITY):
            return False
        lobes = [ids.tolist() for ids in model.kc_topology(config.block)[1]]
        n_kc = sum(len(ids) for ids in lobes)
        self._kc_lobe, self._kc_row = [0] * n_kc, [0] * n_kc
        for lobe, ids in enumerate(lobes):
            for row, kc in enumerate(ids):
                self._kc_lobe[kc], self._kc_row[kc] = lobe, row
        self.adapter, self.model, self.config = adapter, model, config
        self._request_id, self._rev = None, 0
        model.set_memory_observer(self, block=config.block)
        return True

    def detach(self) -> None:
        if self.model is not None:
            self.model.set_memory_observer(None, block=self.config.block)
        self.adapter = self.model = None

    def __call__(self, *, S_before, y_read, delta_raw, delta_net, S_after, d_t, cap, half_life, recovery, k_code):
        adapter = self.adapter
        if adapter is None:
            return
        request_id, t = adapter.request_id, adapter.current_t
        if request_id is None or t < 0:
            return
        if request_id != self._request_id:     # a request starts from the zero state, revision 0
            self._request_id, self._rev = request_id, 0
        self._rev += 1
        cfg, rev = self.config, self._rev
        header = {"run_id": adapter.run_id, "request_id": request_id, "epoch": adapter.epoch, "t": t,
                  "scale": cfg.scale, "block": cfg.block, "prev_rev": rev - 1, "rev": rev}
        if (rev - 1) % cfg.summary_stride == 0:
            self._summary(header, S_before, S_after, delta_net, y_read, d_t, cap, half_life, recovery)
        if cfg.max_kc_slices and (rev - 1) % cfg.slice_stride == 0:
            self._slices(header, S_before, S_after, delta_raw, delta_net, y_read, k_code)

    def _summary(self, header, S_before, S_after, delta_net, y_read, d_t, cap, half_life, recovery):
        def norms(S):                          # (H,) per-head Frobenius norm over (K_l, P), heads in global order
            return torch.cat([torch.linalg.vector_norm(s[0], dim=(-2, -1)) for s in S])

        rows = torch.stack([v.to(torch.float64) for v in (
            d_t[0], cap, half_life, recovery, norms(S_before), norms(S_after), norms(delta_net))])
        q = self.config.quantize
        gate, ceiling, half, keep, before, after, delta = ([q(v) for v in row] for row in rows.cpu().tolist())
        self.adapter.emit({"type": "memory_summary", **header, "heads": y_read.shape[1], "head_dim": y_read.shape[2],
                           "dtype": str(S_before[0].dtype).removeprefix("torch."),
                           "dopamine_gate": gate, "dopamine_cap": ceiling, "recovery_half_life": half,
                           "recovery_factor": keep, "s_norm_before": before, "s_norm_after": after,
                           "s_delta_norm": delta})

    def _slices(self, header, S_before, S_after, delta_raw, delta_net, y_read, k_code):
        code = k_code[0].cpu()
        active = (code > 0).nonzero().flatten()                       # ascending KC id
        if active.numel() == 0:
            return
        values, order = torch.sort(code[active], descending=True, stable=True)   # ties keep the lower KC id first
        n = self.config.max_kc_slices
        kcs, activations = active[order[:n]].tolist(), values[:n].tolist()
        hpl = S_before[0].shape[1]
        lobes = [self._kc_lobe[kc] for kc in kcs]
        rows = [self._kc_row[kc] for kc in kcs]
        # (5, n, hpl, P): S_before, S_after, delta_raw, delta_net rows of each KC, and its lobe's head readouts
        parts = torch.stack([
            torch.stack([S[lobe][0, :, row] for lobe, row in zip(lobes, rows)])
            for S in (S_before, S_after, delta_raw, delta_net)
        ] + [torch.stack([y_read[0, lobe * hpl:(lobe + 1) * hpl] for lobe in lobes])])
        before, after, raw, net, read = parts.to(torch.float64).cpu().tolist()
        q = self.config.quantize
        for j, (kc, lobe, activation) in enumerate(zip(kcs, lobes, activations)):
            k_activation = q(activation)
            for h in range(hpl):
                self.adapter.emit({"type": "memory_slice", **header, "lobe": lobe, "kc_id": kc, "head": lobe * hpl + h,
                                   "k_activation": k_activation,
                                   "s_before": [q(v) for v in before[j][h]], "s_after": [q(v) for v in after[j][h]],
                                   "read_vector": [q(v) for v in read[j][h]],
                                   "delta_raw": [q(v) for v in raw[j][h]], "delta_net": [q(v) for v in net[j][h]]})
