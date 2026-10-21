"""Model-side firing semantics, independently checked against actual address outputs."""
import gc
import json
from pathlib import Path
import weakref

from jsonschema import Draft202012Validator
import pytest
import torch

from harness.viz_stream import FlyGraph, VizStream, attach
from model.vibe.model import Config, FlyLM
from model.wiring import Wiring


@pytest.fixture
def model():
    torch.manual_seed(3)
    mask = torch.tensor([[1, 0, 0, 0], [0, 1, 1, 0], [1, 1, 1, 1],
                         [0, 0, 1, 0], [1, 0, 0, 1], [0, 1, 1, 1]], dtype=torch.bool)
    wiring = Wiring(mask, mask.float(), torch.tensor([0, 1, 2, 0, 1, 2]))
    cfg = Config.from_wiring(wiring, vocab_size=32, d_model=8, n_layer=2,
                             heads_per_lobe=2, d_head=4, top_k=6)
    return FlyLM(cfg, wiring).eval()


def expected_pairs(block, code):
    """Derive routing from mask and lobe membership, without FlyGraph's cached pair table."""
    K, G = block.addr.mask.shape
    expected = []
    for k, value in enumerate(code):
        if value <= 0:
            continue
        expected.extend([g, G + k] for g, wired in enumerate(block.addr.mask[k].tolist()) if wired)
        for lobe in range(3):
            if k in getattr(block.mem, f"lobe{lobe}").tolist():
                expected.extend([G + k, G + K + head] for head in
                                range(lobe * block.mem.hpl, (lobe + 1) * block.mem.hpl))
    return expected


def recording(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


@pytest.mark.parametrize("block", [0, 1])
@pytest.mark.parametrize("mode", ["forward", "step"])
def test_real_address_codes_emit_exact_batch_zero_routes_per_token(model, tmp_path, block, mode):
    graph = FlyGraph(model, block)
    path = tmp_path / "activity.ndjson"
    stream = VizStream(record=str(path))
    stream.set_mapping(graph.mapping)
    codes, other_batch = [], []

    def observe(module, inputs, output):
        first, second = output.detach().tolist()
        codes.extend(first)
        other_batch.extend(second)

    observer = model.blocks[block].addr.register_forward_hook(observe)
    hook = attach(model, stream, graph, block)
    tokens = torch.tensor([[1, 2, 3, 4], [10, 11, 12, 13]])
    try:
        with torch.no_grad():
            for _ in range(2):
                if mode == "forward":
                    model(tokens)
                else:
                    state = model.init_state(B=2)
                    for token in tokens.unbind(dim=1):
                        _, state = model.step(token, state)
    finally:
        observer.remove()
        hook.remove()
        stream.close()

    messages = recording(path)
    assert messages[0] == graph.mapping
    fires = messages[1:]
    assert [fire["t"] for fire in fires] == list(range(8))
    assert codes[:4] == codes[4:]  # Reinitializing the recurrent state reproduces the same activity.
    assert any(value == 0 for code in codes for value in code)  # Zero-valued top-k slots must stay dark.
    assert any([value > 0 for value in first] != [value > 0 for value in second]
               for first, second in zip(codes, other_batch, strict=True))
    schema = Path(__file__).parents[1] / "harness/protocol/v1/fire.schema.json"
    validator = Draft202012Validator(json.loads(schema.read_text(encoding="utf-8")))
    declared = {tuple(pair) for pair in graph.mapping["edges"]}
    for fire, code in zip(fires, codes, strict=True):
        validator.validate(fire)
        assert fire["pairs"] == expected_pairs(model.blocks[block], code)
        pairs = {tuple(pair) for pair in fire["pairs"]}
        assert pairs <= declared and len(pairs) == len(fire["pairs"])
    assert [fire["pairs"] for fire in fires[:4]] == [fire["pairs"] for fire in fires[4:]]
    assert stream.recording_dropped == 0 and stream.recording_error is None


def test_zero_real_address_code_omits_fire_but_preserves_step_boundary(model, tmp_path):
    graph = FlyGraph(model)
    path = tmp_path / "empty.ndjson"
    stream = VizStream(record=str(path))
    stream.set_mapping(graph.mapping)
    hook = attach(model, stream, graph)
    theta = model.blocks[0].addr.theta
    saved = theta.detach().clone()
    try:
        with torch.no_grad():
            theta.zero_()
            model(torch.tensor([[1, 2, 3]]))
            assert stream.t == 3
            theta.copy_(saved)
            model(torch.tensor([[4]]))
    finally:
        hook.remove()
        stream.close()
    messages = recording(path)
    assert messages[0] == graph.mapping
    assert len(messages) == 2 and messages[1]["t"] == 3 and messages[1]["pairs"]


def test_enabled_hook_preserves_logits_loss_gradients_and_releases_codes(model, tmp_path):
    tokens = torch.tensor([[1, 2, 3, 4], [10, 11, 12, 13]])
    targets = tokens.roll(-1, dims=1)
    plain_logits, plain_loss = model(tokens, targets)
    plain_loss.backward()
    gradients = {name: parameter.grad.clone() for name, parameter in model.named_parameters()}
    model.zero_grad(set_to_none=True)

    graph = FlyGraph(model)
    stream = VizStream(record=str(tmp_path / "training.ndjson"))
    stream.set_mapping(graph.mapping)
    refs = []
    observer = model.blocks[0].addr.register_forward_hook(
        lambda module, inputs, output: refs.append(weakref.ref(output)))
    hook = attach(model, stream, graph)
    try:
        logits, loss = model(tokens, targets)
        loss.backward()
        assert torch.equal(logits, plain_logits) and torch.equal(loss, plain_loss)
        for name, parameter in model.named_parameters():
            assert torch.equal(parameter.grad, gradients[name]), name
        del logits, loss
        gc.collect()
        assert refs and all(reference() is None for reference in refs)
    finally:
        observer.remove()
        hook.remove()
        stream.close()


def test_no_listener_skips_extraction_and_detached_hook_does_no_stream_work(model, monkeypatch):
    graph = FlyGraph(model)
    stream = VizStream()
    stream.set_mapping(graph.mapping)
    tokens = torch.tensor([[1, 2, 3]])
    plain_logits = model(tokens)[0]

    def unexpected(*args, **kwargs):
        pytest.fail("disabled instrumentation extracted activations or published activity")

    monkeypatch.setattr(graph, "fire_pairs", unexpected)
    monkeypatch.setattr(stream, "fire", unexpected)
    # The actual model does not need these extraction operations to compute logits.
    monkeypatch.setattr(torch.Tensor, "detach", unexpected)
    monkeypatch.setattr(torch.Tensor, "nonzero", unexpected)
    monkeypatch.setattr(torch.Tensor, "tolist", unexpected)
    monkeypatch.setattr(torch.Tensor, "cpu", unexpected)
    hook = attach(model, stream, graph)
    try:
        assert torch.equal(model(tokens)[0], plain_logits)
        assert stream.t == 3 and not stream.listening
    finally:
        hook.remove()
    monkeypatch.setattr(stream, "skip", unexpected)
    assert not model.blocks[0].addr._forward_hooks
    assert torch.equal(model(tokens)[0], plain_logits)
    assert stream.t == 3


def test_listening_extracts_one_batch_zero_host_copy_per_address_output(model, tmp_path, monkeypatch):
    graph = FlyGraph(model)
    stream = VizStream(record=str(tmp_path / "host-copies.ndjson"))
    stream.set_mapping(graph.mapping)
    copies = []
    original = torch.Tensor.cpu

    def cpu(tensor, *args, **kwargs):
        copies.append(tuple(tensor.shape))
        return original(tensor, *args, **kwargs)

    monkeypatch.setattr(torch.Tensor, "cpu", cpu)
    hook = attach(model, stream, graph)
    tokens = torch.tensor([[1, 2, 3, 4], [10, 11, 12, 13]])
    try:
        with torch.no_grad():
            model(tokens)
            assert copies == [(4, 6)]
            state = model.init_state(B=2)
            for token in tokens.unbind(dim=1):
                _, state = model.step(token, state)
            assert copies == [(4, 6)] + [(1, 6)] * 4
    finally:
        hook.remove()
        stream.close()
