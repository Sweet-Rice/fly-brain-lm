"""Exercise the full real-wiring model and real sockets, then independently inspect its recording."""
import hashlib
import json
from pathlib import Path

from jsonschema import Draft202012Validator
import pytest
import torch

from harness.workflow import ROOT, run_workflow


@pytest.fixture(scope="module")
def capture(tmp_path_factory):
    path = tmp_path_factory.mktemp("real-workflow") / "capture.ndjson"
    old_threads = torch.get_num_threads()
    try:
        metadata = run_workflow(path, path="/actual-model")
    finally:
        torch.set_num_threads(old_threads)
    return path, metadata


def test_full_model_workflow_records_reconnect_and_mapping_reset(capture):
    path, metadata = capture
    messages = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    validators = {
        kind: Draft202012Validator(json.loads(
            (ROOT / f"harness/protocol/v1/{kind}.schema.json").read_text(encoding="utf-8")))
        for kind in ("mapping", "fire")
    }
    epochs = []
    for message in messages:
        validators[message["type"]].validate(message)
        if message["type"] == "mapping":
            edges = {tuple(pair) for pair in message["edges"]}
            epochs.append([])
            assert len(message["nodes"]) == 1958 and len(edges) == 19037
        else:
            assert {tuple(pair) for pair in message["pairs"]} <= edges
            assert len(message["pairs"]) == len({tuple(pair) for pair in message["pairs"]})
            epochs[-1].append(message["t"])
    # The disconnected middle request is still captured; reconnection doesn't reset t.
    assert epochs == [list(range(33)), list(range(11))]
    assert metadata["config"]["n_layer"] == 12
    assert metadata["config"]["d_model"] == 384
    assert metadata["config"]["n_kc"] == 1889
    assert metadata["config"]["n_glom"] == 54
    assert metadata["prompt_ids"] == [7454, 2402, 257, 640]
    assert len(metadata["generated_ids"]) == 8
    assert metadata["rounds"] == 4 and metadata["steps"] == 44 and metadata["epochs"] == 2
    assert metadata["network_dropped"] == metadata["recording_dropped"] == 0
    assert metadata["visualization_disabled_identical"] is True


def test_recording_provenance_matches_files(capture):
    path, metadata = capture
    assert json.loads(Path(str(path) + ".metadata.json").read_text(encoding="utf-8")) == metadata
    assert metadata["recording_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert metadata["wiring_sha256"] == hashlib.sha256(
        (ROOT / "data/connectome/wiring.npz").read_bytes()).hexdigest()
    assert metadata["source_hash_newlines"] == "lf"
    for name, digest in metadata["source_sha256"].items():
        assert digest == hashlib.sha256((ROOT / name).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    assert metadata["seed"] == 0 and metadata["device"] == "cpu" and metadata["torch_threads"] == 1
    assert "untrained" in metadata["model_note"]


@pytest.mark.parametrize("suffix", ["", ".metadata.json"])
def test_workflow_refuses_to_overwrite_recording_or_provenance(tmp_path, suffix):
    recording = tmp_path / "existing.ndjson"
    existing = Path(str(recording) + suffix)
    existing.write_text("keep this", encoding="utf-8")
    with pytest.raises(FileExistsError):
        run_workflow(recording)
    assert existing.read_text(encoding="utf-8") == "keep this"
    if suffix:
        assert not recording.exists()
