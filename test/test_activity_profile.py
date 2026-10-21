"""The overhead measurement uses the full real model and actual stream consumers."""
import pytest
import torch

from harness.profile_activity import PROMPT_IDS, profile_activity


@pytest.mark.parametrize("impl", ["vibe", "vibe2"])
def test_activity_profile_checks_full_model_equivalence_and_real_consumers(impl, monkeypatch):
    monkeypatch.setenv("FLYBRAIN_IMPL", "vibe2" if impl == "vibe" else "vibe")
    threads = torch.get_num_threads()
    rng = torch.get_rng_state()
    result = profile_activity(repeat=2, warmup=1, impl=impl)
    assert torch.get_num_threads() == threads
    assert torch.equal(torch.get_rng_state(), rng)
    assert result["config"]["n_layer"] == 12 and result["config"]["d_model"] == 384
    assert result["impl"] == impl
    assert result["nodes"] == 1958 and result["edges"] == 19037
    assert result["prompt_ids"] == PROMPT_IDS
    assert result["device"] == "cpu" and result["threads"] == 1
    assert set(result["modes"]) == {"disabled", "idle", "recording", "live"}
    for mode, measured in result["modes"].items():
        assert measured["identical_logits"] is True
        assert measured["samples"] == 2
        assert 0 < measured["p50_ms"] <= measured["p95_ms"]
        assert measured["steps"] == (0 if mode == "disabled" else 3 * len(PROMPT_IDS))
        assert measured["network_dropped"] == measured["recording_dropped"] == 0
    assert result["modes"]["recording"]["recording_lines"] == 13
    assert result["modes"]["disabled"]["p50_overhead_percent"] == 0


@pytest.mark.parametrize("choice", ["environment", "default"])
def test_activity_profile_uses_registry_selection(choice, monkeypatch):
    import model.model as registry

    if choice == "environment":
        monkeypatch.setenv("FLYBRAIN_IMPL", "vibe2")
    else:
        monkeypatch.delenv("FLYBRAIN_IMPL", raising=False)
        monkeypatch.setattr(registry, "DEFAULT_IMPL", "vibe2")
    assert profile_activity(repeat=1, warmup=0)["impl"] == "vibe2"


@pytest.mark.parametrize("arguments", [{"repeat": 0}, {"warmup": -1}, {"device": "invalid"}])
def test_activity_profile_rejects_invalid_measurements(arguments):
    with pytest.raises(ValueError):
        profile_activity(**arguments)


def test_activity_profile_refuses_to_claim_unavailable_cuda(monkeypatch):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="CUDA requested but unavailable"):
        profile_activity(device="cuda")
