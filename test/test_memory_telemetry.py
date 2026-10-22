"""KC-MBON memory and dopamine telemetry (issue #42): model observer seam parity, revisions, invariance, safety,
wire format and capability fallback. StubTelemetryAdapter stands in for #41's TelemetryAdapter."""
import contextlib
import importlib
import itertools
import json
import math
from pathlib import Path
import threading
import tracemalloc
import uuid

import torch
from jsonschema import Draft202012Validator

from data.build_wiring import load_wiring
from harness.telemetry.memory import MemoryTelemetry, MemoryTelemetryConfig
from model.model import IMPLEMENTATIONS, supports_capability

WIRING = load_wiring(Path(__file__).resolve().parents[1] / "data" / "connectome" / "wiring.npz")

vibe_module = importlib.import_module(f"{IMPLEMENTATIONS['vibe']}.model")
VibeConfig, FlyLM = vibe_module.Config, vibe_module.FlyLM

vibe2_module = importlib.import_module(f"{IMPLEMENTATIONS['vibe2']}.model")
Vibe2Config, FlyDopamineLM = vibe2_module.Config, vibe2_module.FlyDopamineLM


class StubStream:
    """Test double for VizStream event sink."""

    def __init__(self, keep: bool = True):
        self.t = 0
        self.epoch = 0
        self.keep = keep
        self.events = [] if keep else None
        self.count = 0

    def send_event(self, event: dict) -> bool:
        self.count += 1
        if self.keep:
            self.events.append(event)
        return True


class StubTelemetryAdapter:
    """Test double for #41's TelemetryAdapter; switch to the real adapter once #41 merges."""

    def __init__(self, model, stream, *, block: int = 0, impl: str, model_id: str, ckpt_digest: str, run_id: str | None = None):
        self.model = model
        self.stream = stream
        self.block = block
        self.impl = impl
        self.model_id = model_id
        self.ckpt_digest = ckpt_digest
        self.run_id = run_id if run_id is not None else f"run-{uuid.uuid4().hex[:12]}"
        self.request_id = None
        self.current_t = -1
        self._seq_counter = itertools.count()
        self._seq_lock = threading.Lock()

        mod = model.kc_code_module(block)

        def _pre_hook(module, args):
            self.current_t = self.stream.t

        def _post_hook(module, args, output):
            self.stream.t += output.shape[1]

        self._pre_handle = mod.register_forward_pre_hook(_pre_hook)
        self._post_handle = mod.register_forward_hook(_post_hook)
        self._wrapped_engine = None
        self._orig_run = None

    @property
    def epoch(self) -> int:
        return self.stream.epoch

    def emit(self, event: dict) -> bool:
        with self._seq_lock:
            event["seq"] = next(self._seq_counter)
        return self.stream.send_event(event)

    def wrap_engine(self, engine):
        orig_run = engine.run
        self._wrapped_engine = engine
        self._orig_run = orig_run

        def instrumented_run(*args, **kwargs):
            self.request_id = f"req-{uuid.uuid4().hex[:12]}"
            try:
                yield from orig_run(*args, **kwargs)
            finally:
                self.request_id = None
                self.current_t = -1

        engine.run = instrumented_run
        return engine

    def remove(self):
        if self._pre_handle is not None:
            self._pre_handle.remove()
            self._pre_handle = None
        if self._post_handle is not None:
            self._post_handle.remove()
            self._post_handle = None
        if self._wrapped_engine is not None and self._orig_run is not None:
            self._wrapped_engine.run = self._orig_run
            self._wrapped_engine = None
            self._orig_run = None


@contextlib.contextmanager
def request(adapter):
    """Context manager setting adapter.request_id for the duration of a request."""
    adapter.request_id = f"req-{uuid.uuid4().hex[:12]}"
    try:
        yield adapter.request_id
    finally:
        adapter.request_id = None
        adapter.current_t = -1


def test_vibe_memory_parity_float64():
    torch.manual_seed(0)
    cfg = VibeConfig.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyLM(cfg, WIRING).double().eval()

    orig_step = model.blocks[0].mem.step
    step_inputs = []

    def recorded_step(code_t, v_t, d_t, S):
        step_inputs.append((code_t.clone(), v_t.clone(), d_t.clone(), [s.clone() for s in S]))
        return orig_step(code_t, v_t, d_t, S)

    model.blocks[0].mem.step = recorded_step

    recorded_kwargs = []

    def recorder(**kwargs):
        recorded_kwargs.append(kwargs)

    model.set_memory_observer(recorder, block=0)

    prompt_ids = [101, 204, 305, 402, 501]
    with torch.no_grad():
        list(model.stream(prompt_ids, 6, temperature=0))

    hpl = cfg.heads_per_lobe
    H = 3 * hpl
    lobes = model.kc_topology(0)[1]
    psi = model.blocks[0].mem.psi.detach().to(torch.float64)
    h_life = 1.0 + torch.exp(psi)
    r_ref = 0.5 ** (1.0 / h_life)
    cap_ref = torch.full((H,), 0.99, dtype=torch.float64)

    assert len(step_inputs) == len(recorded_kwargs)
    assert len(step_inputs) > 0

    for (code_t, v_t, d_t, S_in), kw in zip(step_inputs, recorded_kwargs):
        assert (kw["cap"].cpu() - cap_ref.cpu()).abs().max() < 1e-10
        assert (kw["recovery"].cpu() - r_ref.cpu()).abs().max() < 1e-10
        assert (kw["half_life"].cpu() - h_life.cpu()).abs().max() < 1e-10
        assert (kw["d_t"] - d_t).abs().max() < 1e-10
        assert (kw["k_code"] - code_t).abs().max() < 1e-10
        for l in range(3):
            assert (kw["S_before"][l] - S_in[l]).abs().max() < 1e-10

        ys_ref = []
        delta_raw_ref = []
        S_after_ref = []
        delta_net_ref = []
        for l in range(3):
            idx = lobes[l]
            k_l = code_t[:, idx]
            vl = v_t[:, l * hpl:(l + 1) * hpl]
            dl = d_t[:, l * hpl:(l + 1) * hpl]
            rl = r_ref[l * hpl:(l + 1) * hpl]

            num = torch.einsum("bk,bhkd->bhd", k_l, S_in[l])
            den = k_l.sum(-1).clamp_min(1e-6)
            ys_ref.append(num / den[:, None, None])

            dk = dl[:, :, None] * k_l[:, None, :]
            draw = dk[..., None] * (vl[:, :, None, :] - S_in[l])
            delta_raw_ref.append(draw)
            safter = rl[None, :, None, None] * (S_in[l] + draw)
            S_after_ref.append(safter)
            delta_net_ref.append(safter - S_in[l])

        y_ref = torch.cat(ys_ref, dim=1)

        assert (kw["y_read"] - y_ref).abs().max() < 1e-10
        for l in range(3):
            assert (kw["delta_raw"][l] - delta_raw_ref[l]).abs().max() < 1e-10
            assert (kw["S_after"][l] - S_after_ref[l]).abs().max() < 1e-10
            assert (kw["delta_net"][l] - delta_net_ref[l]).abs().max() < 1e-10

    stream = StubStream(keep=True)
    adapter = StubTelemetryAdapter(model, stream, block=0, impl="vibe", model_id="test-vibe", ckpt_digest="test-digest")
    mem_tel = MemoryTelemetry()
    tel_cfg = MemoryTelemetryConfig(scale=10000)
    assert mem_tel.attach(adapter, model, "vibe", tel_cfg) is True

    step_inputs.clear()
    with request(adapter):
        with torch.no_grad():
            list(model.stream([10, 20, 30], 2, temperature=0))

    assert len(step_inputs) > 0
    code_0, v_0, d_0, S_0 = step_inputs[0]
    S_after_0 = []
    for l in range(3):
        idx = lobes[l]
        k_l = code_0[:, idx]
        vl = v_0[:, l * hpl:(l + 1) * hpl]
        dl = d_0[:, l * hpl:(l + 1) * hpl]
        rl = r_ref[l * hpl:(l + 1) * hpl]
        dk = dl[:, :, None] * k_l[:, None, :]
        S_after_0.append(rl[None, :, None, None] * (S_0[l] + dk[..., None] * (vl[:, :, None, :] - S_0[l])))

    ref_norms = torch.cat([torch.linalg.vector_norm(s[0], dim=(-2, -1)) for s in S_after_0])
    expected_summary_s_norm_after = [tel_cfg.quantize(float(v)) for v in ref_norms]

    first_summary = next(e for e in stream.events if e["type"] == "memory_summary" and e["t"] == 0)
    assert first_summary["s_norm_after"] == expected_summary_s_norm_after

    first_slice = next(e for e in stream.events if e["type"] == "memory_slice" and e["t"] == 0)
    slice_lobe = first_slice["lobe"]
    slice_kc = first_slice["kc_id"]
    slice_head = first_slice["head"]
    local_row = (lobes[slice_lobe] == slice_kc).nonzero().squeeze().item()
    local_head = slice_head % hpl
    expected_slice_s_after = [tel_cfg.quantize(float(v)) for v in S_after_0[slice_lobe][0, local_head, local_row]]
    assert first_slice["s_after"] == expected_slice_s_after

    mem_tel.detach()
    adapter.remove()
    model.blocks[0].mem.step = orig_step


def test_vibe2_memory_parity_float64():
    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8, ab_dopamine_max=0.2)
    model = FlyDopamineLM(cfg, WIRING).double().eval()
    model.blocks[0].mixer.dopamine.linear.bias.data.fill_(20.0)

    orig_memory = model.blocks[0].mixer._memory
    memory_inputs = []

    def recorded_memory(k, d, x, S):
        memory_inputs.append((k.clone(), d.clone(), x.clone(), [s.clone() for s in S]))
        return orig_memory(k, d, x, S)

    model.blocks[0].mixer._memory = recorded_memory

    recorded_kwargs = []

    def recorder(**kwargs):
        recorded_kwargs.append(kwargs)

    model.set_memory_observer(recorder, block=0)

    prompt_ids = [101, 204, 305, 402, 501]
    with torch.no_grad():
        list(model.stream(prompt_ids, 6, temperature=0))

    hpl = cfg.heads_per_lobe
    H = 3 * hpl
    lobes = model.kc_topology(0)[1]
    psi = model.blocks[0].mixer.psi.detach().to(torch.float64)
    h_life = 1.0 + torch.exp(psi)
    r_ref = torch.exp(-math.log(2.0) / h_life)
    # the cap buffer is built in the default dtype (float32), then promoted by .double()
    expected_cap = torch.tensor([0.99] * hpl + [0.2] * hpl + [0.99] * hpl).to(torch.float64)

    assert len(memory_inputs) == len(recorded_kwargs)
    assert len(memory_inputs) > 0

    for (k_in, d_in, x_in, S_in), kw in zip(memory_inputs, recorded_kwargs):
        assert (kw["cap"].cpu() - expected_cap).abs().max() < 1e-10
        assert (kw["d_t"][:, hpl:2 * hpl] <= 0.2000001).all()
        assert (kw["d_t"][:, :hpl] > 0.9).all()
        assert (kw["d_t"][:, 2 * hpl:] > 0.9).all()
        assert (kw["recovery"].cpu() - r_ref.cpu()).abs().max() < 1e-10
        assert (kw["half_life"].cpu() - h_life.cpu()).abs().max() < 1e-10
        assert (kw["d_t"] - d_in).abs().max() < 1e-10
        assert (kw["k_code"] - k_in).abs().max() < 1e-10
        for lobe in range(3):
            assert (kw["S_before"][lobe] - S_in[lobe]).abs().max() < 1e-10

        ys_ref = []
        delta_raw_ref = []
        S_after_ref = []
        delta_net_ref = []
        for lobe in range(3):
            sl = slice(lobe * hpl, (lobe + 1) * hpl)
            idx = lobes[lobe]
            k_l = k_in[:, idx]
            q = k_l / (k_l.sum(-1, keepdim=True) + 1e-6)
            S_l = S_in[lobe]
            ys_ref.append(torch.einsum("bk,bhkp->bhp", q, S_l))
            dk = d_in[:, sl, None] * k_l[:, None, :]
            draw = dk[..., None] * (x_in[:, sl, None, :] - S_l)
            delta_raw_ref.append(draw)
            safter = r_ref[sl][None, :, None, None] * (S_l + draw)
            S_after_ref.append(safter)
            delta_net_ref.append(safter - S_l)

        y_read_ref = torch.cat(ys_ref, dim=1)

        assert (kw["y_read"] - y_read_ref).abs().max() < 1e-10
        for lobe in range(3):
            assert (kw["delta_raw"][lobe] - delta_raw_ref[lobe]).abs().max() < 1e-10
            assert (kw["S_after"][lobe] - S_after_ref[lobe]).abs().max() < 1e-10
            assert (kw["delta_net"][lobe] - delta_net_ref[lobe]).abs().max() < 1e-10

        D = model.blocks[0].mixer.D.detach()
        y_with_skip = y_read_ref + D.view(1, H, 1) * x_in
        assert (kw["y_read"] - y_read_ref).abs().max() < 1e-10
        assert not torch.allclose(kw["y_read"], y_with_skip, atol=1e-5)

    model.set_memory_observer(None, block=0)
    model.blocks[0].mixer._memory = orig_memory


def test_state_resets_and_zero_code_decays_exactly():
    from model.serve.serve import Engine

    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()
    stream = StubStream(keep=True)
    adapter = StubTelemetryAdapter(model, stream, block=0, impl="vibe2", model_id="test-vibe2", ckpt_digest="test-digest")
    mem_tel = MemoryTelemetry()
    assert mem_tel.attach(adapter, model, "vibe2", MemoryTelemetryConfig(scale=10000)) is True

    observed_calls = []

    def forwarding_observer(**kwargs):
        observed_calls.append({
            "S_before": [s.clone() for s in kwargs["S_before"]],
            "d_t": kwargs["d_t"].clone(),
        })
        mem_tel(**kwargs)

    model.set_memory_observer(forwarding_observer, block=0)

    engine = Engine(model, model_id="test", ctx=256, max_tokens_cap=128, seed=0)
    adapter.wrap_engine(engine)

    _ = list(engine.run("Hello fly", 4, 0.0, None, [], {}))
    num_calls_req1 = len(observed_calls)
    assert num_calls_req1 > 0

    _ = list(engine.run("Hello fly", 4, 0.0, None, [], {}))
    num_calls_req2 = len(observed_calls) - num_calls_req1
    assert num_calls_req2 > 0

    for s in observed_calls[0]["S_before"]:
        assert torch.equal(s, torch.zeros_like(s))
    for s in observed_calls[num_calls_req1]["S_before"]:
        assert torch.equal(s, torch.zeros_like(s))

    summaries = [e for e in stream.events if e["type"] == "memory_summary"]
    req_ids = list(dict.fromkeys(e["request_id"] for e in summaries))
    assert len(req_ids) == 2
    assert req_ids[0] != req_ids[1]

    first_summary_req1 = next(e for e in summaries if e["request_id"] == req_ids[0])
    first_summary_req2 = next(e for e in summaries if e["request_id"] == req_ids[1])
    assert first_summary_req1["prev_rev"] == 0 and first_summary_req1["rev"] == 1
    assert all(val == 0 for val in first_summary_req1["s_norm_before"])
    assert first_summary_req2["prev_rev"] == 0 and first_summary_req2["rev"] == 1
    assert all(val == 0 for val in first_summary_req2["s_norm_before"])

    mem_tel.detach()
    adapter.remove()

    vibe_cfg = VibeConfig.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    vibe_model = FlyLM(vibe_cfg, WIRING).eval()
    mem = vibe_model.blocks[0].mem

    S_init = mem.init_state(1, "cpu")
    v_dummy = torch.randn(1, vibe_cfg.n_head, vibe_cfg.d_head)
    d_dummy = torch.rand(1, vibe_cfg.n_head)
    code_dummy = torch.zeros(1, vibe_cfg.n_kc)
    code_dummy[0, :5] = 1.0
    _, S_nonzero = mem.step(code_dummy, v_dummy, d_dummy, S_init)

    obs_kwargs_vibe = {}

    def recorder_vibe(**kwargs):
        obs_kwargs_vibe.update(kwargs)

    mem.memory_observer = recorder_vibe
    zeros_code = torch.zeros(1, vibe_cfg.n_kc)
    v = torch.randn(1, vibe_cfg.n_head, vibe_cfg.d_head)
    d = torch.rand(1, vibe_cfg.n_head)
    mem.step(zeros_code, v, d, S_nonzero)

    for dr in obs_kwargs_vibe["delta_raw"]:
        assert torch.count_nonzero(dr) == 0

    r = mem.recovery()
    hpl = vibe_cfg.heads_per_lobe
    for l in range(3):
        rl = r[l * hpl:(l + 1) * hpl]
        assert torch.equal(obs_kwargs_vibe["S_after"][l], rl[None, :, None, None] * obs_kwargs_vibe["S_before"][l])

    vibe2_cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    vibe2_model = FlyDopamineLM(vibe2_cfg, WIRING).eval()
    mixer = vibe2_model.blocks[0].mixer

    S_init2 = mixer.init_state(1, "cpu")["S"]
    x_dummy = torch.randn(1, mixer.H, mixer.P)
    d_dummy = torch.rand(1, mixer.H)
    k_dummy = torch.zeros(1, vibe2_cfg.n_kc)
    k_dummy[0, :5] = 1.0
    _, S_nonzero2 = mixer._memory(k_dummy, d_dummy, x_dummy, S_init2)

    obs_kwargs_vibe2 = {}

    def recorder_vibe2(**kwargs):
        obs_kwargs_vibe2.update(kwargs)

    mixer.memory_observer = recorder_vibe2
    zeros_k = torch.zeros(1, vibe2_cfg.n_kc)
    x = torch.randn(1, mixer.H, mixer.P)
    d = torch.rand(1, mixer.H)
    mixer._memory(zeros_k, d, x, S_nonzero2)

    for dr in obs_kwargs_vibe2["delta_raw"]:
        assert torch.count_nonzero(dr) == 0

    r2 = mixer.recovery()
    hpl2 = vibe2_cfg.heads_per_lobe
    for l in range(3):
        rl = r2[l * hpl2:(l + 1) * hpl2]
        assert torch.equal(obs_kwargs_vibe2["S_after"][l], rl[None, :, None, None] * obs_kwargs_vibe2["S_before"][l])


def test_logits_identical_observer_on_off():
    tokens = [15, 27, 84, 102, 5]
    for impl_name, ConfigClass, ModelClass in (
        ("vibe", VibeConfig, FlyLM),
        ("vibe2", Vibe2Config, FlyDopamineLM),
    ):
        torch.manual_seed(0)
        cfg = ConfigClass.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
        model = ModelClass(cfg, WIRING).eval()

        state = model.init_state(1, "cpu")
        logits_no_obs = []
        for tok in tokens:
            log, state = model.step(torch.tensor([tok]), state)
            logits_no_obs.append(log)

        tokens_stream_no_obs = list(model.stream(tokens[:3], 8, temperature=0))

        stream = StubStream(keep=True)
        adapter = StubTelemetryAdapter(model, stream, block=0, impl=impl_name, model_id="test", ckpt_digest="test")
        mem_tel = MemoryTelemetry()
        assert mem_tel.attach(adapter, model, impl_name) is True

        state = model.init_state(1, "cpu")
        logits_with_obs = []
        with request(adapter):
            for tok in tokens:
                log, state = model.step(torch.tensor([tok]), state)
                logits_with_obs.append(log)

        with request(adapter):
            tokens_stream_with_obs = list(model.stream(tokens[:3], 8, temperature=0))

        for l1, l2 in zip(logits_no_obs, logits_with_obs):
            assert torch.equal(l1, l2)
        assert tokens_stream_no_obs == tokens_stream_with_obs

        mem_tel.detach()
        adapter.remove()


def test_1000_steps_no_graph_and_bounded_memory():
    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()

    stream = StubStream(keep=True)
    adapter = StubTelemetryAdapter(model, stream, block=0, impl="vibe2", model_id="test", ckpt_digest="test")
    mem_tel = MemoryTelemetry()
    assert mem_tel.attach(adapter, model, "vibe2", MemoryTelemetryConfig(max_kc_slices=1)) is True

    def assert_detached(obj):
        if isinstance(obj, torch.Tensor):
            assert obj.requires_grad is False
            assert obj.grad_fn is None
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                assert_detached(item)

    def grad_checking_observer(**kwargs):
        for v in kwargs.values():
            assert_detached(v)
        mem_tel(**kwargs)

    model.set_memory_observer(grad_checking_observer, block=0)

    state = model.init_state(1, "cpu")
    tok = torch.tensor([42])
    with torch.enable_grad():
        with request(adapter):
            for _ in range(3):
                logits, state = model.step(tok, state)
                tok = logits.argmax(dim=-1)

    mem_tel.detach()
    adapter.remove()

    stream_unkept = StubStream(keep=False)
    adapter2 = StubTelemetryAdapter(model, stream_unkept, block=0, impl="vibe2", model_id="test2", ckpt_digest="test2")
    mem_tel2 = MemoryTelemetry()
    assert mem_tel2.attach(adapter2, model, "vibe2", MemoryTelemetryConfig(max_kc_slices=1)) is True

    state = model.init_state(1, "cpu")
    tok = torch.tensor([42])

    with torch.no_grad():
        with request(adapter2):
            tracemalloc.start()
            try:
                for _ in range(500):
                    logits, state = model.step(tok, state)
                    tok = logits.argmax(dim=-1)
                peak1 = tracemalloc.get_traced_memory()[1]
                tracemalloc.reset_peak()
                for _ in range(500):
                    logits, state = model.step(tok, state)
                    tok = logits.argmax(dim=-1)
                peak2 = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()

    assert peak2 - peak1 < 0.05 * peak1
    assert stream_unkept.count > 0

    mem_tel2.detach()
    adapter2.remove()


def test_events_validate_and_contain_only_ints_and_strings():
    root = Path(__file__).resolve().parents[1] / "harness" / "protocol" / "v1"
    summary_schema = json.loads((root / "memory_summary.schema.json").read_text(encoding="utf-8"))
    slice_schema = json.loads((root / "memory_slice.schema.json").read_text(encoding="utf-8"))

    Draft202012Validator.check_schema(summary_schema)
    Draft202012Validator.check_schema(slice_schema)
    summary_validator = Draft202012Validator(summary_schema)
    slice_validator = Draft202012Validator(slice_schema)

    def assert_only_int_or_str_scalars(obj):
        if isinstance(obj, dict):
            for v in obj.values():
                assert_only_int_or_str_scalars(v)
        elif isinstance(obj, list):
            for v in obj:
                assert_only_int_or_str_scalars(v)
        else:
            assert type(obj) in (int, str), f"expected scalar type int or str, got {type(obj)}: {obj!r}"

    max_kc_slices = 3

    for impl_name, ConfigClass, ModelClass in (
        ("vibe", VibeConfig, FlyLM),
        ("vibe2", Vibe2Config, FlyDopamineLM),
    ):
        torch.manual_seed(0)
        cfg = ConfigClass.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
        model = ModelClass(cfg, WIRING).eval()
        stream = StubStream(keep=True)
        adapter = StubTelemetryAdapter(model, stream, block=0, impl=impl_name, model_id="test", ckpt_digest="test")
        mem_tel = MemoryTelemetry()
        tel_cfg = MemoryTelemetryConfig(max_kc_slices=max_kc_slices)
        assert mem_tel.attach(adapter, model, impl_name, tel_cfg) is True

        with request(adapter):
            with torch.no_grad():
                list(model.stream([10, 20], 3, temperature=0))

        assert len(stream.events) > 0
        types = {e["type"] for e in stream.events}
        assert "memory_summary" in types and "memory_slice" in types

        seqs = [e["seq"] for e in stream.events]
        assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))

        lobes = model.kc_topology(0)[1]
        step_slices = {}

        for e in stream.events:
            assert e["t"] >= 0
            assert_only_int_or_str_scalars(e)

            if e["type"] == "memory_summary":
                summary_validator.validate(e)
                for key in (
                    "dopamine_gate",
                    "dopamine_cap",
                    "recovery_half_life",
                    "recovery_factor",
                    "s_norm_before",
                    "s_norm_after",
                    "s_delta_norm",
                ):
                    assert len(e[key]) == e["heads"]
                assert e["heads"] == 3 * cfg.heads_per_lobe
                assert e["head_dim"] == cfg.d_head
            elif e["type"] == "memory_slice":
                slice_validator.validate(e)
                for key in ("s_before", "s_after", "read_vector", "delta_raw", "delta_net"):
                    assert len(e[key]) == cfg.d_head

                step_key = (e["request_id"], e["t"])
                step_slices.setdefault(step_key, []).append(e)

                kc_id = e["kc_id"]
                actual_lobe = next(l for l in range(3) if (lobes[l] == kc_id).any().item())
                assert e["lobe"] == actual_lobe
                assert e["head"] // cfg.heads_per_lobe == e["lobe"]

        for slices in step_slices.values():
            assert len(slices) <= max_kc_slices * cfg.heads_per_lobe

        mem_tel.detach()
        adapter.remove()

    cfg_default = MemoryTelemetryConfig()
    assert cfg_default.quantize(float("nan")) == "nan"
    assert cfg_default.quantize(float("inf")) == "inf"
    assert cfg_default.quantize(float("-inf")) == "-inf"
    val = cfg_default.quantize(0.12345)
    expected_val = round(0.12345 * cfg_default.scale)
    assert val == expected_val
    assert type(val) is int
    assert val == 1234


def test_personal_model_reports_unsupported_and_emits_nothing():
    assert supports_capability("personal", "kc_mbon_memory") is False
    assert supports_capability("vibe", "kc_mbon_memory") is True
    assert supports_capability("vibe2", "kc_mbon_memory") is True
    assert supports_capability("vibe", "unknown_capability_xyz") is False

    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()
    stream = StubStream(keep=True)
    adapter = StubTelemetryAdapter(model, stream, block=0, impl="personal", model_id="test", ckpt_digest="test")
    mem_tel = MemoryTelemetry()
    res = mem_tel.attach(adapter, model, "personal", MemoryTelemetryConfig())
    assert res is False

    for blk in model.blocks:
        assert blk.mixer.memory_observer is None

    with request(adapter):
        with torch.no_grad():
            list(model.stream([10, 20, 30], 4, temperature=0))

    assert len(stream.events) == 0
    assert stream.count == 0

    adapter.remove()
