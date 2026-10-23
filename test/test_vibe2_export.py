import json

import numpy as np
import pytest
import tiktoken
import torch
import torch.nn.functional as F

from model.vibe2.export_webgpu import export
from model.vibe2.model import Config, FlyDopamineLM
from model.wiring import Wiring


@pytest.fixture(scope="module")
def exported(tmp_path_factory):
    torch.manual_seed(7)
    wiring = Wiring.random()
    perm = torch.argsort(wiring.kc_class, stable=True)
    wiring = Wiring(wiring.mask[perm], wiring.theta[perm], wiring.kc_class[perm],
                    [int(i) for i in perm])
    model = FlyDopamineLM(Config(d_model=64, n_layer=2, n_glom=54), wiring).eval()
    out = tmp_path_factory.mktemp("webgpu")
    ckpt = out / "test.pt"
    torch.save(model.state_dict(), ckpt)
    ck = dict(impl="vibe2", source_step=42, source_best_val_loss=1.23456)
    manifest = export(model, wiring, ck, out, "test", ckpt)
    return model, wiring, out, manifest


def test_exported_tensors_are_bitwise_reference_values(exported):
    model, wiring, out, manifest = exported
    data = (out / "weights.bin").read_bytes()
    assert manifest["weights"]["bytes"] == len(data)
    state = dict(model.state_dict())
    with torch.no_grad():
        for b, block in enumerate(model.blocks):
            m = block.mixer
            prefix = f"blocks.{b}.mixer."
            w = m.addr.mask * F.softplus(m.addr.theta)
            state[prefix + "addr.wiring"] = w / w.norm(dim=-1, keepdim=True)
            state[prefix + "addr.glom_scale"] = torch.stack([
                F.softplus(m.addr.sigma_raw), F.softplus(m.addr.m_raw)])
            state[prefix + "cap"] = m.cap
            state[prefix + "recovery"] = m.recovery()
        for tensor in manifest["tensors"]:
            assert tensor["offset"] % 256 == 0
            count = int(np.prod(tensor["shape"]))
            actual = np.frombuffer(data, dtype="<f4", count=count, offset=tensor["offset"])
            expected = state[tensor["name"]].detach().numpy().reshape(-1)
            assert np.array_equal(actual.view("u4"), expected.view("u4")), tensor["name"]
    assert manifest["mapping_mask"] == [row.nonzero().flatten().tolist() for row in wiring.mask]


def test_golden_generation_and_tokenizer(exported):
    model, _, out, _ = exported
    golden = json.loads((out / "golden.json").read_text(encoding="utf-8"))
    assert golden["greedy_ids"] == model.generate(golden["prompt_ids"], 32, temperature=0)
    assert len(golden["steps"]) == len(golden["prompt_ids"]) + 31
    enc = tiktoken.get_encoding("gpt2")
    for case in golden["tokenizer_cases"]:
        assert case["ids"] == enc.encode_ordinary(case["text"])


def test_unsorted_lobes_rejected(tmp_path):
    wiring = Wiring.random()
    wiring.kc_class[[0, -1]] = wiring.kc_class[[-1, 0]]
    model = FlyDopamineLM(Config(d_model=64, n_layer=2, n_glom=54), wiring)
    with pytest.raises(ValueError, match="lobe0.*contiguous"):
        export(model, wiring, dict(impl="vibe2"), tmp_path, "test", tmp_path / "unused.pt")
