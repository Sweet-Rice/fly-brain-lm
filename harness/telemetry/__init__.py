"""Opt-in run, token and KC-MBON memory telemetry for a served FlyBrainLM, outside the frozen model/serve/ package.

adapter.py    TelemetryAdapter: request_lifecycle, token_step and stream_status extension messages
memory.py     MemoryTelemetry: memory_summary and memory_slice messages, emitted through the adapter
serve.py      python -m harness.telemetry.serve: model.serve.serve plus the adapter (--memory-telemetry: MemoryTelemetry)
benchmark.py  python -m harness.telemetry.benchmark: inference overhead of the adapter

Wire format: harness/protocol/v1/SPEC.md, "Extension messages (additive)".
"""
