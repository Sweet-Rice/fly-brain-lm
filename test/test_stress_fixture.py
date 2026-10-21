from harness.stress import fire_fixture, fixture, model_profile


def test_real_topology_stress_fixture_is_deterministic_and_declared():
    mapping, pairs = fixture()
    assert len(mapping["nodes"]) == 1958
    assert len(mapping["edges"]) == 19037
    assert len(pairs) == 1889
    declared = {tuple(edge) for edge in mapping["edges"]}
    assert {tuple(edge) for batch in pairs for edge in batch} == declared
    first = fire_fixture(pairs, 0)
    assert first == fire_fixture(pairs, 0)
    assert first != fire_fixture(pairs, 1)
    assert len(first) == len({tuple(edge) for edge in first})
    assert all(tuple(edge) in declared for edge in first)
    kcs = {node["id"] for node in mapping["nodes"] if node["group"] in (1, 2, 3)}
    assert len({node for edge in first for node in edge if node in kcs}) == 94


def test_stress_capture_matches_full_default_model_mapping(monkeypatch):
    monkeypatch.setenv("FLYBRAIN_IMPL", "vibe2")
    import pytest
    torch = pytest.importorskip("torch")
    threads = torch.get_num_threads()
    try:
        with torch.random.fork_rng():
            result = model_profile(events=1)
    finally:
        torch.set_num_threads(threads)
    assert result["mapping_exactly_matches_capture"] is True
    assert result["positive_kcs"] == result["config"]["top_k"] == 94
    assert result["config"]["d_model"] == 384
    assert result["config"]["n_layer"] == 12
    assert result["cpu_hook_extraction"]["p50_ms"] >= 0
