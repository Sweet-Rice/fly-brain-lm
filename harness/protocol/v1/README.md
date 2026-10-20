# Visualization stream v1 contract artifacts

[`SPEC.md`](SPEC.md) is the normative protocol. The other files are portable conformance artifacts for model-side Python and browser-side TypeScript/JavaScript implementations.

| Artifact | Purpose |
|---|---|
| `mapping.schema.json` | JSON Schema Draft 2020-12 shape and scalar constraints for known v1 mapping messages. |
| `fire.schema.json` | JSON Schema Draft 2020-12 shape and scalar constraints for known v1 fire messages. |
| `fixtures/reference.ndjson` | Valid stream with an omitted step and a replacement mapping. |
| `fixtures/reference.expected.json` | Expected accepted events for the reference stream. |
| `fixtures/invalid-cases.json` | Independent raw-frame sequences and required receiver actions for invalid and forward-compatible input. |

JSON Schema cannot express references between arrays or stream history. The schemas therefore carry `x-flybrain-semantic-rules` annotations, while the normative rules and stateful expected outcomes live in `SPEC.md` and the fixtures. In particular, implementations must independently enforce unique ids, declared group/node/edge references, mapping epochs, and increasing `t`.

Unknown message types intentionally match neither known-message schema. Receivers ignore those messages as specified rather than treating schema mismatch as a connection error. Unknown fields are permitted, but their scalar leaves remain restricted to integers and strings for v1 producer conformance.

## Consuming the artifacts

No project runtime module is required:

- Python can parse the schemas and manifests with `json`, iterate NDJSON lines, and validate known messages with any Draft 2020-12 JSON Schema implementation.
- TypeScript or JavaScript can use `JSON.parse` and a Draft 2020-12 validator such as Ajv 2020.
- Both implementations should run the raw strings in `invalid-cases.json` through their normal frame parser and compare emitted actions with the corresponding `expected` array.

Each case starts with fresh connection state. If `reconnect_before` lists a frame index, discard the receiver and create fresh connection state immediately before that frame. Expected actions are:

- `replace_mapping`: accept an atomic mapping and begin a new epoch;
- `accept_fire`: accept `t` and the listed declared pairs, dropping any listed undeclared pairs;
- `drop_message`: keep processing later frames without changing protocol state;
- `ignore_message`: ignore an unknown type;
- `close`: stop processing, using the supplied WebSocket close code for a live source.

Run the repository contract checks with:

```bash
python -m pytest -q test/test_protocol_contract.py
```
