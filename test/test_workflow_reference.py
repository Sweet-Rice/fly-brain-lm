"""Check the real-model review artifact without importing model dependencies."""
import hashlib
import json
from pathlib import Path
import re

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
RECORDING = ROOT / "harness/recordings/reference.ndjson"


def test_reference_provenance_identifies_the_capture_and_real_model_settings():
    metadata = json.loads(Path(str(RECORDING) + ".metadata.json").read_text(encoding="utf-8"))
    assert hashlib.sha256(RECORDING.read_bytes()).hexdigest() == metadata["recording_sha256"]
    assert metadata["wiring_sha256"] == hashlib.sha256(
        (ROOT / "data/connectome/wiring.npz").read_bytes()).hexdigest()
    assert metadata["generator"] == "python -m harness.workflow"
    assert metadata["mode"] == "smoke"
    assert "untrained" in metadata["model_note"].lower()
    assert metadata["seed"] == 0
    assert metadata["device"] == "cpu"
    assert metadata["torch_threads"] == 1
    assert metadata["torch_version"] and metadata["python_version"]
    assert metadata["config"]["n_layer"] == 12
    assert metadata["config"]["d_model"] == 384
    assert metadata["prompt"] == "Once upon a time"
    assert metadata["tokenizer"] == "gpt2"
    assert len(metadata["prompt_ids"]) == 4
    assert metadata["temperature"] == 0
    assert metadata["max_new_tokens"] == len(metadata["generated_ids"]) == 8
    assert metadata["stop_ids"] == [50256]
    assert metadata["rounds"] == 4
    assert metadata["epochs"] == 2
    assert metadata["steps"] == 44
    assert metadata["last_epoch_steps"] == 11
    assert metadata["network_dropped"] == metadata["recording_dropped"] == 0
    assert metadata["visualization_disabled_identical"] is True
    assert metadata["topology"] == {"groups": 5, "nodes": 1958, "edges": 19037}
    assert metadata["source_hash_newlines"] == "lf"
    # Source digests describe the capture's code, which may precede later repo changes.
    assert set(metadata["source_sha256"]) == {
        "harness/workflow.py", "harness/viz_stream.py", "model/model.py", "data/build_wiring.py",
    }
    assert all(re.fullmatch(r"[0-9a-f]{64}", digest)
               for digest in metadata["source_sha256"].values())


def test_reference_schemas_declared_edges_and_ordering_across_mapping_replacement():
    schema_root = ROOT / "harness/protocol/v1"
    validators = {
        kind: Draft202012Validator(json.loads(
            (schema_root / f"{kind}.schema.json").read_text(encoding="utf-8")))
        for kind in ("mapping", "fire")
    }
    metadata = json.loads(Path(str(RECORDING) + ".metadata.json").read_text(encoding="utf-8"))
    epochs = []
    edges = None
    for line in RECORDING.read_text(encoding="utf-8").splitlines():
        message = json.loads(line)
        validators[message["type"]].validate(message)
        if message["type"] == "mapping":
            groups = {group["id"] for group in message["groups"]}
            nodes = {node["id"] for node in message["nodes"]}
            assert len(groups) == len(message["groups"])
            assert len(nodes) == len(message["nodes"])
            assert all(node["group"] in groups for node in message["nodes"])
            edges = {tuple(pair) for pair in message["edges"]}
            assert len(edges) == len(message["edges"])
            assert all(src in nodes and dst in nodes for src, dst in edges)
            assert {key: len(message[key]) for key in ("groups", "nodes", "edges")} == metadata["topology"]
            epochs.append([])
        else:
            assert edges is not None, "mapping must precede every fire epoch"
            assert message["pairs"], "reference activity must come from nonempty real model steps"
            assert all(tuple(pair) in edges for pair in message["pairs"])
            if epochs[-1]:
                assert message["t"] > epochs[-1][-1]
            else:
                assert message["t"] == 0
            epochs[-1].append(message["t"])
    assert epochs == [list(range(33)), list(range(11))]
    assert len(epochs) == metadata["epochs"]
    assert sum(map(len, epochs)) == metadata["steps"]
