# Real-model workflow reference

[`reference.ndjson`](reference.ndjson) is a complete v1 stream captured from a
freshly initialized, **untrained** FlyLM using the checked-in real connectome
wiring. Its fire pairs come from the normal model activity hook; they are not a
synthetic traffic fixture. It includes two mapping epochs and real inference on
both sides of the replacement, with token-step ordering restarting at `t=0`.

[`reference.ndjson.metadata.json`](reference.ndjson.metadata.json) records the
generation settings, source and environment provenance, graph/message counts,
and the recording's SHA-256 digest. Source-file hashes normalize CRLF to LF;
the recording and wiring hashes cover their exact bytes. Reproduction fixes the seed, CPU device,
prompt, greedy decoding, and selected block. Floating-point results can still
change with PyTorch versions or platforms. The digest identifies this exact
checked-in capture; it is not a promise that every environment regenerates
identical bytes. Stream lines do not contain inference timings.

## Review without a model

From a clean checkout, serve the harness with any static HTTP server. Python's
standard library is sufficient:

```bash
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

Open <http://127.0.0.1:8772/app/>, choose **Or open a recording**, and select
`harness/recordings/reference.ndjson`. Playback runs locally in the browser;
no model dependencies, checkpoint, CUDA, or running model are needed. The
browser needs WebGPU for the graph; stream validation and playback diagnostics
remain available when WebGPU is unavailable. Playback speed sets a synthetic
delay between fire messages, not the speed of the original inference.

For a WebSocket replay instead, install `websockets` and run:

```bash
python -m harness.replay_prompt harness/recordings/reference.ndjson --port 8768
```

Connect the harness to `ws://127.0.0.1:8768/stream`. This replays the unchanged
recording from the start for each connection and repeats it, including both
mapping epochs.

## Regenerate and validate

Install the real-model dependencies in the [setup guide](../WORKFLOW.md#2-install-the-real-model-dependencies),
then run from the repository root:

```bash
python -m harness.workflow --record new-reference.ndjson
```

The finite capture command writes a new recording and its metadata sidecar; it
refuses to overwrite existing files. Review the new capture, then replace the
checked-in pair together and run `python -m pytest -q test/test_workflow_reference.py`.
This reference contains 46 messages: two mappings, 33 fire steps (`t=0..32`) in
the first epoch and 11 (`t=0..10`) in the second. Each mapping has five groups,
1,958 nodes, and 19,037 edges. The fixture test validates the
digest, message schemas, declared IDs and edges, and increasing token steps
within every mapping epoch. It needs only `pytest` and `jsonschema`, and does not
load the model or tokenizer. CI also creates a fresh real-model workflow
recording and uploads it with metadata in `smoke-outputs`.

See the [end-to-end guide](../WORKFLOW.md) for live inference, reconnect and
mapping-replacement checks, configuration, and known limits. The older
`harness/example/once_upon_a_time.ndjson` capture is preserved separately.
