#!/usr/bin/env bash
# CI smoke: build an untrained checkpoint, serve one prompt with a recording, check the recording.
# Run from the repo root. PYTHON overrides the interpreter; RUNNER_TEMP (set by GitHub) picks the scratch dir.
set -euo pipefail
PY="${PYTHON:-python}"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/flybrain-smoke"
mkdir -p "$WORK"

"$PY" -m model.init_model --out "$WORK/ci.pt"
test -s "$WORK/ci.pt"

"$PY" -m model.serve.ask "Once upon a time" --ckpt "$WORK/ci.pt" --port 0 --max-tokens 8 \
    --temperature 0 --record "$WORK/ci.ndjson" </dev/null | tee "$WORK/ask.txt"
grep -Eq '^\[4 prompt \+ [0-9]+ generated tokens; steps t=0\.\.[0-9]+\]$' "$WORK/ask.txt"

"$PY" -m harness.watch_stream "$WORK/ci.ndjson" --brief | tee "$WORK/watch.txt"
grep -q '1958 nodes, 19037 connections' "$WORK/watch.txt"
fires=$(grep -c '^FIRE ' "$WORK/watch.txt")
test "$fires" -ge 4
echo "smoke OK: $fires fire steps recorded"
