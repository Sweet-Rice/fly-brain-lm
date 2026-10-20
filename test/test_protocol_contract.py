"""Validate the portable v1 schemas and conformance fixtures."""
import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError


ROOT = Path(__file__).parents[1] / "harness" / "protocol" / "v1"
FIXTURES = ROOT / "fixtures"


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def is_int(value):
    return type(value) is int


def is_pair(value):
    return (isinstance(value, list) and len(value) == 2
            and all(is_int(item) and item >= 0 for item in value))


def valid_mapping(message):
    if (message.get("type") != "mapping" or not is_int(message.get("version"))
            or message["version"] != 1 or not isinstance(message.get("groups"), list)
            or not isinstance(message.get("nodes"), list)
            or not isinstance(message.get("edges"), list)):
        return False

    group_ids = []
    for group in message["groups"]:
        if (not isinstance(group, dict) or not is_int(group.get("id")) or group["id"] < 0
                or not isinstance(group.get("name"), str)):
            return False
        group_ids.append(group["id"])
    if len(group_ids) != len(set(group_ids)):
        return False

    node_ids = []
    for node in message["nodes"]:
        if (not isinstance(node, dict) or not is_int(node.get("id")) or node["id"] < 0
                or not is_int(node.get("group")) or node["group"] not in group_ids):
            return False
        node_ids.append(node["id"])
    if len(node_ids) != len(set(node_ids)):
        return False

    edges = message["edges"]
    if not all(is_pair(edge) and edge[0] in node_ids and edge[1] in node_ids for edge in edges):
        return False
    return len({tuple(edge) for edge in edges}) == len(edges)


def valid_fire_shape(message):
    if (message.get("type") != "fire" or not is_int(message.get("t")) or message["t"] < 0
            or not isinstance(message.get("pairs"), list)
            or not all(is_pair(pair) for pair in message["pairs"])):
        return False
    return len({tuple(pair) for pair in message["pairs"]}) == len(message["pairs"])


class ContractReceiver:
    """Independent executable reading of the receiver rules used to check fixture outcomes."""

    def __init__(self):
        self.epoch = -1
        self.edges = None
        self.last_t = None
        self.closed = False

    def process(self, raw):
        assert not self.closed
        try:
            message = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return {"action": "drop_message"}
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            return {"action": "drop_message"}

        kind = message["type"]
        if kind not in {"mapping", "fire"}:
            return {"action": "ignore_message"}
        if kind == "mapping":
            version = message.get("version")
            if is_int(version) and version != 1:
                self.closed = True
                return {"action": "close", "code": 1003}
            if not valid_mapping(message):
                return {"action": "drop_message"}
            self.epoch += 1
            self.edges = {tuple(edge) for edge in message["edges"]}
            self.last_t = None
            return {
                "action": "replace_mapping",
                "epoch": self.epoch,
                "groups": len(message["groups"]),
                "nodes": len(message["nodes"]),
                "edges": len(message["edges"]),
            }

        if self.edges is None or not valid_fire_shape(message):
            return {"action": "drop_message"}
        if self.last_t is not None and message["t"] <= self.last_t:
            return {"action": "drop_message"}
        self.last_t = message["t"]
        accepted = [pair for pair in message["pairs"] if tuple(pair) in self.edges]
        dropped = [pair for pair in message["pairs"] if tuple(pair) not in self.edges]
        return {
            "action": "accept_fire",
            "epoch": self.epoch,
            "t": message["t"],
            "pairs": accepted,
            "dropped_pairs": dropped,
        }


def assert_integer_or_string_scalars(value):
    if isinstance(value, dict):
        for item in value.values():
            assert_integer_or_string_scalars(item)
    elif isinstance(value, list):
        for item in value:
            assert_integer_or_string_scalars(item)
    else:
        assert type(value) in {int, str}


def test_reference_stream_validates_and_exercises_mapping_epochs():
    schemas = {
        "mapping": Draft202012Validator(load_json(ROOT / "mapping.schema.json")),
        "fire": Draft202012Validator(load_json(ROOT / "fire.schema.json")),
    }
    for validator in schemas.values():
        validator.check_schema(validator.schema)

    raw_messages = (FIXTURES / "reference.ndjson").read_text(encoding="utf-8").splitlines()
    messages = [json.loads(raw) for raw in raw_messages]
    for message in messages:
        assert_integer_or_string_scalars(message)
        schemas[message["type"]].validate(message)

    receiver = ContractReceiver()
    actual = [receiver.process(raw) for raw in raw_messages]
    expected = load_json(FIXTURES / "reference.expected.json")
    assert expected["schema_version"] == 1
    assert actual == expected["events"]

    assert [event["t"] for event in actual if event["action"] == "accept_fire" and event["epoch"] == 0] == [0, 2]
    assert [event["epoch"] for event in actual if event["action"] == "replace_mapping"] == [0, 1]
    assert actual[-1]["t"] == 0


def test_invalid_and_forward_compatible_cases_have_required_outcomes():
    manifest = load_json(FIXTURES / "invalid-cases.json")
    assert manifest["schema_version"] == 1
    ids = [case["id"] for case in manifest["cases"]]
    assert len(ids) == len(set(ids))
    assert {
        "malformed-json", "unknown-type", "unknown-fields", "fire-before-mapping",
        "unsupported-version", "duplicate-group-id", "duplicate-node-id", "unknown-node-group",
        "edge-with-unknown-node", "duplicate-edge", "non-increasing-t", "duplicate-fire-pair",
        "undeclared-fire-pair", "invalid-replacement-keeps-current-mapping", "replacement-resets-t",
        "reconnect-discards-state",
    } <= set(ids)

    actions = set()
    for case in manifest["cases"]:
        assert all(isinstance(frame, str) for frame in case["frames"])
        reconnect_before = set(case.get("reconnect_before", []))
        receiver = ContractReceiver()
        actual = []
        for index, frame in enumerate(case["frames"]):
            if index in reconnect_before:
                receiver = ContractReceiver()
            actual.append(receiver.process(frame))
        assert actual == case["expected"], case["id"]
        actions.update(event["action"] for event in actual)
    assert actions == {"replace_mapping", "accept_fire", "drop_message", "ignore_message", "close"}


def test_schemas_allow_extensions_and_reject_invalid_v1_scalars_and_shapes():
    mapping_schema = load_json(ROOT / "mapping.schema.json")
    fire_schema = load_json(ROOT / "fire.schema.json")
    Draft202012Validator.check_schema(mapping_schema)
    Draft202012Validator.check_schema(fire_schema)
    mapping_validator = Draft202012Validator(mapping_schema)
    fire_validator = Draft202012Validator(fire_schema)

    mapping = json.loads((FIXTURES / "reference.ndjson").read_text(encoding="utf-8").splitlines()[0])
    fire = json.loads((FIXTURES / "reference.ndjson").read_text(encoding="utf-8").splitlines()[1])
    mapping["future"] = {"label": "kept", "ids": [1, 2]}
    mapping["groups"][0]["future"] = "kept"
    fire["future"] = ["kept", 1]
    mapping_validator.validate(mapping)
    fire_validator.validate(fire)

    invalid_messages = []
    missing = deepcopy(mapping)
    del missing["edges"]
    invalid_messages.append((mapping_validator, missing))
    negative = deepcopy(mapping)
    negative["nodes"][0]["id"] = -1
    invalid_messages.append((mapping_validator, negative))
    duplicate_edge = deepcopy(mapping)
    duplicate_edge["edges"].append(deepcopy(duplicate_edge["edges"][0]))
    invalid_messages.append((mapping_validator, duplicate_edge))
    duplicate_pair = deepcopy(fire)
    duplicate_pair["pairs"].append(deepcopy(duplicate_pair["pairs"][0]))
    invalid_messages.append((fire_validator, duplicate_pair))
    floating_extension = deepcopy(fire)
    floating_extension["future"] = 0.5
    invalid_messages.append((fire_validator, floating_extension))
    boolean_extension = deepcopy(mapping)
    boolean_extension["future"] = True
    invalid_messages.append((mapping_validator, boolean_extension))

    for validator, message in invalid_messages:
        with pytest.raises(ValidationError):
            validator.validate(message)


def test_semantic_id_and_reference_rules_are_enforced_beyond_json_schema():
    mapping_validator = Draft202012Validator(load_json(ROOT / "mapping.schema.json"))
    cases = {case["id"]: case for case in load_json(FIXTURES / "invalid-cases.json")["cases"]}
    for case_id in ("duplicate-group-id", "duplicate-node-id", "unknown-node-group", "edge-with-unknown-node"):
        message = json.loads(cases[case_id]["frames"][0])
        mapping_validator.validate(message)
        assert not valid_mapping(message)
