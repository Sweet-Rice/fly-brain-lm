"""Opt-in run and token telemetry for a served FlyBrainLM, outside the frozen model/serve/ package.

adapter.py    TelemetryAdapter: request_lifecycle, token_step and stream_status extension messages
serve.py      python -m harness.telemetry.serve: model.serve.serve plus the adapter
benchmark.py  python -m harness.telemetry.benchmark: inference overhead of the adapter

Wire format: harness/protocol/v1/SPEC.md, "Extension messages (additive)".
"""
