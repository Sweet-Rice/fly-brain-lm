#!/usr/bin/env bash
# CI smoke: initialize a real-wiring model, export/validate its mapping, then serve and record a prompt.
# Run from the repo root. PYTHON overrides the interpreter; RUNNER_TEMP (set by GitHub) picks the scratch dir.
set -euo pipefail
PY="${PYTHON:-python}"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/flybrain-smoke"
mkdir -p "$WORK"

"$PY" -m model.init_model --out "$WORK/ci.pt"
test -s "$WORK/ci.pt"

"$PY" -m harness.export_mapping --ckpt "$WORK/ci.pt" --out "$WORK/mapping.ndjson"

"$PY" -m model.serve.ask "Once upon a time" --ckpt "$WORK/ci.pt" --port 0 --max-tokens 8 \
    --temperature 0 --record "$WORK/ci.ndjson" </dev/null | tee "$WORK/ask.txt"
grep -Eq '^\[4 prompt \+ [0-9]+ generated tokens; steps t=0\.\.[0-9]+\]$' "$WORK/ask.txt"

"$PY" - "$WORK/mapping.ndjson" "$WORK/ci.ndjson" <<'PY'
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

schema = json.loads(Path("harness/protocol/v1/mapping.schema.json").read_text(encoding="utf-8"))
mapping = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
Draft202012Validator(schema).validate(mapping)
with open(sys.argv[2], encoding="utf-8") as recording:
    assert json.loads(recording.readline()) == mapping
print("standalone mapping validates against v1 and matches the model recording")
PY

"$PY" -m harness.watch_stream "$WORK/ci.ndjson" --brief | tee "$WORK/watch.txt"
grep -q '1958 nodes, 19037 connections' "$WORK/watch.txt"
fires=$(grep -c '^FIRE ' "$WORK/watch.txt")
test "$fires" -ge 4
echo "smoke OK: $fires fire steps recorded"
