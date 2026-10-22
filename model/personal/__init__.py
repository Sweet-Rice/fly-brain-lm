"""Personal model: your own FlyBrainLM implementation. Empty template until you fill it in.

Selected with `--impl personal` or FLYBRAIN_IMPL=personal when building. Full guide: model/README.md#personal-model

Implementation interface (all four names are required by model/model.py):
  NOTE                          str, stored in each checkpoint as "note".
  build(wiring, config=None)    -> torch.nn.Module built from `wiring` (model.wiring.Wiring). config=None:
                                   fresh defaults. A dict: rebuild from a checkpoint's export_config() output.
                                   It must contain only str/int/float/bool/None/list/dict so that
                                   torch.load(weights_only=True) accepts it.
  export_config(model) -> dict  what build() later receives back (same constraint).
  sanity_checks(model, wiring)  -> {description: passed}. Init writes nothing if any value is False.

Model contract (serving and visualization use these; checked at build and load):
  model.stream(prompt_ids, max_new_tokens, temperature=1.0, top_k=None, stop_ids=(), gen=None)
      yields int GPT-2 token ids (EOT is 50256). prompt_ids is a nonempty list[int]; gen is a CPU
      torch.Generator or None. Inputs follow the model's device; sample on CPU if using gen.
      temperature <= 0 is greedy. Stops after yielding a stop id.
  model.heads_per_lobe          int > 0. The visualization draws 3 * heads_per_lobe MBON compartments.
  model.kc_code_module(block)   -> nn.Module whose forward output is (B, T, K), rows aligned with
                                   wiring.mask; > 0 = active KC (Kenyon-cell activity). Its output must
                                   include each processed token exactly once during a stream() call.
                                   Each output position, not each forward call, fires one step.
  model.kc_topology(block)      -> (mask, lobes) read live from the model, so in-place edits are seen on
                                   refresh. mask is (K, G) bool, rows aligned with kc_code_module's last axis,
                                   columns glomeruli. lobes is a tuple of exactly 3 one-dimensional integer
                                   tensors partitioning range(K) (0 gamma, 1 alpha/beta, 2 alpha'/beta').
                                   Raises IndexError for a block that does not exist.

Optional capability declarations (read by model.model.supports_capability; a missing tuple is empty):
  CAPABILITIES                  tuple of optional features this model offers, e.g. "kc_mbon_memory" (KC-MBON
                                   memory telemetry; the model must then also provide set_memory_observer).
  UNSUPPORTED_CAPABILITIES      features explicitly not offered. This template keeps no KC-MBON memory state,
                                   so memory telemetry reports it unsupported and emits nothing.

Intra-package imports must be relative (`from .x import y`) so this package can be moved.
"""

NOTE = "personal model"
CAPABILITIES = ()
UNSUPPORTED_CAPABILITIES = ("kc_mbon_memory",)


def build(wiring, config=None):
    """Return a torch.nn.Module built from `wiring`. config: None = fresh defaults, dict = export_config() output."""
    raise NotImplementedError("model/personal: build() is not written yet; see model/README.md#personal-model")


def export_config(model) -> dict:
    """Return the weights_only-safe config dict that build() accepts back to rebuild `model`."""
    raise NotImplementedError("model/personal: export_config() is not written yet; see model/README.md#personal-model")


def sanity_checks(model, wiring) -> dict[str, bool]:
    """Return {description: passed} for untrained-model checks. Any False blocks the checkpoint write."""
    raise NotImplementedError("model/personal: sanity_checks() is not written yet; see model/README.md#personal-model")
