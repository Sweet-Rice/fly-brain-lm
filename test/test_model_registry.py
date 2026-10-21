"""Model registry: build selection, checkpoint dispatch on "impl", the serving/visualization contract."""
import json
from importlib import import_module

import pytest
import torch

from harness.viz_stream import stream_model
from model import model as registry
from model.model import ENV_VAR, build_model, load_checkpoint, save_checkpoint, selected_impl
from model.wiring import Wiring
from test.fake_impl import FakeLM

vibe = import_module(f"{registry.IMPLEMENTATIONS['vibe']}.model")
Config, FlyLM = vibe.Config, vibe.FlyLM

TINY = Config(d_model=64, n_layer=2)
WIRING = Wiring.random()


def tiny_vibe():
    torch.manual_seed(0)
    return FlyLM(TINY, WIRING).eval()


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setitem(registry.IMPLEMENTATIONS, "fake", "test.fake_impl")
    return "fake"


def test_selection_precedence(monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)
    assert selected_impl() == "vibe"
    monkeypatch.setenv(ENV_VAR, "personal")
    assert selected_impl() == "personal"
    assert selected_impl("vibe") == "vibe"
    monkeypatch.setenv(ENV_VAR, "")
    assert selected_impl() == "vibe"
    monkeypatch.setenv(ENV_VAR, "nope")
    with pytest.raises(ValueError, match="unknown model implementation 'nope'"):
        selected_impl()


def test_legacy_checkpoint_without_impl_loads_as_vibe(tmp_path, monkeypatch):
    monkeypatch.delenv(ENV_VAR, raising=False)
    model = tiny_vibe()
    p = tmp_path / "legacy.pt"
    save_checkpoint(p, model, WIRING, "vibe")
    ck = torch.load(p, weights_only=True)
    del ck["impl"]
    torch.save(ck, p)
    loaded, _, _ = load_checkpoint(p)
    assert type(loaded) is FlyLM
    idx = torch.randint(0, 50257, (1, 8))
    with torch.no_grad():
        assert torch.equal(model(idx)[0], loaded(idx)[0])


def test_checkpoint_selects_its_own_implementation(fake, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(ENV_VAR, "vibe")                       # build-time env must not change loading
    model = build_model(WIRING, fake)
    p = tmp_path / "fake.pt"
    save_checkpoint(p, model, WIRING, fake)
    loaded, _, ck = load_checkpoint(p)
    assert type(loaded).__name__ == "FakeLM"
    assert ck["impl"] == "fake"
    assert loaded.state_dict().keys() == model.state_dict().keys()
    for k, v in model.state_dict().items():
        assert torch.equal(v, loaded.state_dict()[k])
    err = capsys.readouterr().err
    assert "was built by 'fake'" in err and "loading 'fake'" in err


def test_unknown_checkpoint_impl_is_rejected(tmp_path):
    p = tmp_path / "gone.pt"
    save_checkpoint(p, tiny_vibe(), WIRING, "vibe")
    ck = torch.load(p, weights_only=True)
    ck["impl"] = "gone"
    torch.save(ck, p)
    with pytest.raises(ValueError, match="'gone'"):
        load_checkpoint(p)


def test_model_without_kc_code_is_rejected(fake, monkeypatch):
    monkeypatch.setattr(FakeLM, "kc_code_module", None)
    with pytest.raises(TypeError, match="kc_code_module"):
        build_model(WIRING, fake)


def test_model_without_kc_topology_is_rejected(fake, monkeypatch):
    monkeypatch.setattr(FakeLM, "kc_topology", None)
    with pytest.raises(TypeError, match="kc_topology"):
        build_model(WIRING, fake)


def test_stream_model_accepts_any_conforming_implementation(fake, tmp_path):
    torch.manual_seed(0)
    model = build_model(WIRING, fake)
    rec = tmp_path / "r.ndjson"
    vs, _ = stream_model(model, WIRING, port=0, record=rec)
    try:
        tokens = list(model.stream([1, 2], 3, stop_ids=()))
    finally:
        vs.close()
    assert len(tokens) == 3
    msgs = [json.loads(line) for line in rec.read_text().splitlines()]
    mapping, fires = msgs[0], msgs[1:]
    K, G = WIRING.mask.shape
    assert mapping["type"] == "mapping"
    assert len(mapping["nodes"]) == G + K + 3 * model.heads_per_lobe
    assert [m["t"] for m in fires] == [0, 1, 2]
    edges = {tuple(e) for e in mapping["edges"]}
    for m in fires:
        assert m["type"] == "fire"
        assert all(tuple(p) in edges for p in m["pairs"])
