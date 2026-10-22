"""KC-MBON memory and dopamine telemetry (issue #42): model observer seam parity, revisions, invariance, safety,
wire format and capability fallback. Integration tests drive the real TelemetryAdapter over a real VizStream
recording through model.serve.serve.Engine; pure numerical tests observe the model seam with plain callables."""
import gc
import importlib
import inspect
import json
import math
from pathlib import Path
import tracemalloc

import pytest
import torch
from jsonschema import Draft202012Validator

from data.build_wiring import load_wiring
from harness.telemetry.adapter import TelemetryAdapter
from harness.telemetry.memory import MemoryTelemetry, MemoryTelemetryConfig
from harness.viz_stream import stream_model
from model.model import IMPLEMENTATIONS, supports_capability
from model.serve.serve import ENC, Engine

DIGEST = "sha256:" + "0" * 12

WIRING = load_wiring(Path(__file__).resolve().parents[1] / "data" / "connectome" / "wiring.npz")

vibe_module = importlib.import_module(f"{IMPLEMENTATIONS['vibe']}.model")
VibeConfig, FlyLM = vibe_module.Config, vibe_module.FlyLM

vibe2_module = importlib.import_module(f"{IMPLEMENTATIONS['vibe2']}.model")
Vibe2Config, FlyDopamineLM = vibe2_module.Config, vibe2_module.FlyDopamineLM


class Pipeline:
    """The served telemetry path: stream_model recording + Engine + real TelemetryAdapter + MemoryTelemetry."""

    def __init__(
        self,
        model,
        impl: str,
        tmp_path: Path,
        config: MemoryTelemetryConfig = MemoryTelemetryConfig(),
        ctx: int = 256,
        max_tokens_cap: int = 64,
        seed: int = 0,
        name: str | None = None,
    ):
        suffix = name if name is not None else f"{impl}-{id(self)}"
        self.path = tmp_path / f"{suffix}.ndjson"
        self.stream, _ = stream_model(model, WIRING, 0, port=0, record=str(self.path))
        self.engine = Engine(model, model_id="flybrain-test", ctx=ctx, max_tokens_cap=max_tokens_cap, seed=seed)
        self.adapter = TelemetryAdapter(
            model,
            self.stream,
            block=0,
            impl=impl,
            model_id="flybrain-test",
            ckpt_digest=DIGEST,
        )
        self.adapter.wrap_engine(self.engine)
        self.memory = MemoryTelemetry()
        self.attached = self.memory.attach(self.adapter, model, impl, config)
        self._closed = False

    def run(self, prompt: str, max_tokens: int):
        info = {}
        text = "".join(self.engine.run(prompt, max_tokens, 0.0, None, [], info))
        return text, info

    def close(self):
        if not self._closed:
            self._closed = True
            self.memory.detach()
            self.adapter.remove()
            self.stream.close(drain_timeout=5.0)
        p = Path(self.path)
        if not p.exists():
            return []
        lines = [line.strip() for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [json.loads(line) for line in lines]


def test_vibe_memory_parity_float64(tmp_path):
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

    tel_cfg = MemoryTelemetryConfig(scale=10000)
    p = Pipeline(model, "vibe", tmp_path, tel_cfg)
    try:
        step_inputs.clear()
        p.run("Fly memory parity", 2)
        events = p.close()

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

        first_prompt_step = next(
            e for e in events if e.get("type") == "token_step" and e.get("kind") == "prompt" and e.get("token_index") == 0
        )
        first_summary = next(e for e in events if e.get("type") == "memory_summary" and e.get("rev") == 1)
        assert first_summary["t"] == first_prompt_step["t"]
        assert first_summary["s_norm_after"] == expected_summary_s_norm_after

        first_slice = next(e for e in events if e.get("type") == "memory_slice" and e.get("rev") == 1)
        slice_lobe = first_slice["lobe"]
        slice_kc = first_slice["kc_id"]
        slice_head = first_slice["head"]
        local_row = (lobes[slice_lobe] == slice_kc).nonzero().squeeze().item()
        local_head = slice_head % hpl
        expected_slice_s_after = [tel_cfg.quantize(float(v)) for v in S_after_0[slice_lobe][0, local_head, local_row]]
        assert first_slice["s_after"] == expected_slice_s_after
    finally:
        p.close()
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


def test_state_resets_and_zero_code_decays_exactly(tmp_path):
    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()
    p = Pipeline(model, "vibe2", tmp_path, MemoryTelemetryConfig(scale=10000))
    try:
        observed_calls = []

        def forwarding_observer(**kwargs):
            observed_calls.append({
                "S_before": [s.clone() for s in kwargs["S_before"]],
                "d_t": kwargs["d_t"].clone(),
            })
            p.memory(**kwargs)

        model.set_memory_observer(forwarding_observer, block=0)

        p.run("Hello fly", 4)
        num_calls_req1 = len(observed_calls)
        assert num_calls_req1 > 0

        p.run("Hello fly", 4)
        num_calls_req2 = len(observed_calls) - num_calls_req1
        assert num_calls_req2 > 0

        for s in observed_calls[0]["S_before"]:
            assert torch.equal(s, torch.zeros_like(s))
        for s in observed_calls[num_calls_req1]["S_before"]:
            assert torch.equal(s, torch.zeros_like(s))

        events = p.close()
        summaries = [e for e in events if e.get("type") == "memory_summary"]
        req_ids = list(dict.fromkeys(e["request_id"] for e in summaries))
        assert len(req_ids) == 2
        assert req_ids[0] != req_ids[1]

        first_summary_req1 = next(e for e in summaries if e["request_id"] == req_ids[0])
        first_summary_req2 = next(e for e in summaries if e["request_id"] == req_ids[1])
        assert first_summary_req1["prev_rev"] == 0 and first_summary_req1["rev"] == 1
        assert all(val == 0 for val in first_summary_req1["s_norm_before"])
        assert first_summary_req2["prev_rev"] == 0 and first_summary_req2["rev"] == 1
        assert all(val == 0 for val in first_summary_req2["s_norm_before"])
    finally:
        p.close()

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


def test_logits_identical_observer_on_off(tmp_path):
    prompt = "The fly remembers the odor"
    for impl, ConfigClass, ModelClass in (
        ("vibe", VibeConfig, FlyLM),
        ("vibe2", Vibe2Config, FlyDopamineLM),
    ):
        torch.manual_seed(0)
        cfg = ConfigClass.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
        model = ModelClass(cfg, WIRING).eval()

        orig = model.step
        captured = []

        def step(tok, state):
            out, new = orig(tok, state)
            captured.append(out.detach().clone())
            return out, new

        model.step = step

        try:
            engine = Engine(model, model_id="flybrain-test", ctx=256, max_tokens_cap=64, seed=0)
            info_a = {}
            text_a = "".join(engine.run(prompt, 8, 0.0, None, [], info_a))
            logits_a = captured[:]
            captured.clear()

            p = Pipeline(model, impl, tmp_path, seed=0)
            try:
                assert p.attached is True
                text_b, info_b = p.run(prompt, 8)
                events = p.close()
                logits_b = captured[:]
            finally:
                p.close()

            assert len(logits_a) == len(logits_b) > 0
            for la, lb in zip(logits_a, logits_b):
                assert torch.equal(la, lb)
            assert text_a == text_b
            assert info_a == info_b

            stepped_token_steps = [e for e in events if e.get("type") == "token_step" and e.get("t", -1) >= 0]
            summaries = [e for e in events if e.get("type") == "memory_summary"]
            assert len(summaries) == len(stepped_token_steps) > 0
        finally:
            del model.step


def test_1000_steps_no_graph_and_bounded_memory(tmp_path):
    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()

    def assert_detached(obj):
        if isinstance(obj, torch.Tensor):
            assert obj.requires_grad is False
            assert obj.grad_fn is None
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                assert_detached(item)

    # Part 1: pure seam unit check (no adapter)
    observed_tensors = []

    def sink_observer(**kwargs):
        for v in kwargs.values():
            assert_detached(v)
            observed_tensors.append(v)

    model.set_memory_observer(sink_observer, block=0)

    state = model.init_state(1, "cpu")
    tok = torch.tensor([42])
    with torch.enable_grad():
        for _ in range(3):
            logits, state = model.step(tok, state)
            tok = logits.argmax(dim=-1)

    assert any(p.requires_grad for p in model.parameters())
    assert len(observed_tensors) > 0
    for v in observed_tensors:
        assert_detached(v)
    model.set_memory_observer(None, block=0)

    # Part 2: real integration, 1200 model steps. Whole-process totals (fires, the bounded recording queue, free lists,
    # torch tensor-object reuse, collection timing) move by several KB between runs even without memory telemetry, so
    # the bound is on what the telemetry code keeps alive: after a collection, blocks allocated in the adapter and the
    # collector may not grow by 16 bytes per write (less than one Python object) over the 1000 writes 200..1200.
    # Observed growth is a few KB of noise either way; retaining one emitted list per write adds about 300 KB.
    first, last = 200, 1200
    telemetry_code = [tracemalloc.Filter(True, inspect.getfile(obj)) for obj in (TelemetryAdapter, MemoryTelemetry)]
    p = Pipeline(model, "vibe2", tmp_path, MemoryTelemetryConfig(max_kc_slices=1), ctx=1300, max_tokens_cap=16)
    try:
        prompt = " fly" * last
        assert len(ENC.encode_ordinary(prompt)) >= last
        writes, outside_step, retained = 0, 0, {}

        def measuring(**kw):
            nonlocal writes, outside_step
            for v in kw.values():
                assert_detached(v)
            if p.adapter.request_id is None or p.adapter.current_t < 0:
                outside_step += 1
            p.memory(**kw)
            writes += 1
            if writes in (first, last):
                gc.collect()
                snapshot = tracemalloc.take_snapshot().filter_traces(telemetry_code)
                retained[writes] = sum(trace.size for trace in snapshot.traces)

        model.set_memory_observer(measuring, block=0)

        tracemalloc.start()
        try:
            p.run(prompt, 8)
        finally:
            tracemalloc.stop()

        events = p.close()

        assert writes >= last and outside_step == 0
        assert retained[first] > 0                                 # the filter sees the telemetry code's blocks
        assert retained[last] - retained[first] < 16 * (last - first)
        assert any(e.get("type") == "memory_summary" for e in events)
    finally:
        p.close()


def test_events_validate_and_contain_only_ints_and_strings(tmp_path):
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

    for impl, ConfigClass, ModelClass in (
        ("vibe", VibeConfig, FlyLM),
        ("vibe2", Vibe2Config, FlyDopamineLM),
    ):
        torch.manual_seed(0)
        cfg = ConfigClass.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
        model = ModelClass(cfg, WIRING).eval()
        p = Pipeline(model, impl, tmp_path, MemoryTelemetryConfig(max_kc_slices=max_kc_slices))
        try:
            p.run("Fly memory schema", 3)
            events = p.close()
        finally:
            p.close()

        memory_events = [e for e in events if e.get("type") in ("memory_summary", "memory_slice")]
        types = {e["type"] for e in memory_events}
        assert "memory_summary" in types and "memory_slice" in types

        seqs = [e["seq"] for e in events if "seq" in e]
        assert len(seqs) > 0 and all(a < b for a, b in zip(seqs, seqs[1:]))

        lobes = model.kc_topology(0)[1]
        step_slices = {}

        for e in memory_events:
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

    cfg_default = MemoryTelemetryConfig()
    assert cfg_default.quantize(float("nan")) == "nan"
    assert cfg_default.quantize(float("inf")) == "inf"
    assert cfg_default.quantize(float("-inf")) == "-inf"
    val = cfg_default.quantize(0.12345)
    expected_val = round(0.12345 * cfg_default.scale)
    assert val == expected_val
    assert type(val) is int
    assert val == 1234


def test_personal_model_reports_unsupported_and_emits_nothing(tmp_path):
    assert supports_capability("personal", "kc_mbon_memory") is False
    assert supports_capability("vibe", "kc_mbon_memory") is True
    assert supports_capability("vibe2", "kc_mbon_memory") is True
    assert supports_capability("vibe", "unknown_capability_xyz") is False

    torch.manual_seed(0)
    cfg = Vibe2Config.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = FlyDopamineLM(cfg, WIRING).eval()
    p = Pipeline(model, "personal", tmp_path)
    try:
        assert p.attached is False
        for blk in model.blocks:
            assert blk.mixer.memory_observer is None

        p.run("Hello fly", 4)
        events = p.close()

        memory_events = [e for e in events if e.get("type") in ("memory_summary", "memory_slice")]
        assert len(memory_events) == 0

        token_steps = [e for e in events if e.get("type") == "token_step"]
        assert len(token_steps) > 0
    finally:
        p.close()


@pytest.mark.parametrize(
    "impl,ConfigClass,ModelClass",
    [
        ("vibe", VibeConfig, FlyLM),
        ("vibe2", Vibe2Config, FlyDopamineLM),
    ],
)
def test_memory_t_matches_token_step_t(tmp_path, impl, ConfigClass, ModelClass):
    torch.manual_seed(0)
    cfg = ConfigClass.from_wiring(WIRING, d_model=32, n_layer=2, heads_per_lobe=2, d_head=8)
    model = ModelClass(cfg, WIRING).eval()
    p = Pipeline(model, impl, tmp_path)
    try:
        _, info1 = p.run("The fly smells vinegar", 4)
        _, info2 = p.run("Then it smells banana", 3)
        events = p.close()
    finally:
        p.close()

    gap_events = [e for e in events if e.get("type") == "stream_status" and e.get("event") == "gap"]
    assert len(gap_events) == 0

    queued_events = [e for e in events if e.get("type") == "request_lifecycle" and e.get("phase") == "queued"]
    req_ids = [e["request_id"] for e in queued_events]
    assert len(req_ids) == 2
    assert req_ids[0] != req_ids[1]

    memory_events = [e for e in events if e.get("type") in ("memory_summary", "memory_slice")]
    assert len(memory_events) > 0
    for me in memory_events:
        assert me["request_id"] in req_ids
        assert me["run_id"] == p.adapter.run_id
        assert me["epoch"] == 0
        assert me["t"] >= 0

    token_steps = [e for e in events if e.get("type") == "token_step"]

    for rid, info in zip(req_ids, [info1, info2]):
        rid_token_steps = [e for e in token_steps if e["request_id"] == rid]
        rid_token_steps_by_seq = sorted(rid_token_steps, key=lambda e: e["seq"])

        stepped = [e["t"] for e in rid_token_steps_by_seq if e["t"] >= 0]
        assert len(stepped) == info["prompt_tokens"] + info["completion_tokens"] - 1

        for e in rid_token_steps:
            if e.get("step_status") == "unprocessed":
                assert e["t"] == -1

        rid_summaries = [e for e in events if e.get("type") == "memory_summary" and e["request_id"] == rid]
        rid_summaries_by_seq = sorted(rid_summaries, key=lambda e: e["seq"])
        assert [e["t"] for e in rid_summaries_by_seq] == stepped
        expected_revs = list(range(1, len(stepped) + 1))
        assert [e["rev"] for e in rid_summaries_by_seq] == expected_revs
        for s in rid_summaries:
            assert s["prev_rev"] == s["rev"] - 1

        summary_rev_by_t = {s["t"]: s["rev"] for s in rid_summaries}
        summary_seq_by_t = {s["t"]: s["seq"] for s in rid_summaries}

        token_step_seq_by_t = {e["t"]: e["seq"] for e in rid_token_steps if e["t"] >= 0}

        rid_slices = [e for e in events if e.get("type") == "memory_slice" and e["request_id"] == rid]
        assert rid_slices
        for sl in rid_slices:
            assert sl["t"] in stepped
            assert sl["rev"] == summary_rev_by_t[sl["t"]]

        rid_memory_events = [e for e in memory_events if e["request_id"] == rid]
        for me in rid_memory_events:
            assert token_step_seq_by_t[me["t"]] < me["seq"]

        for sl in rid_slices:
            assert summary_seq_by_t[sl["t"]] < sl["seq"]
