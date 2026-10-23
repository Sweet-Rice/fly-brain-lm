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

Use the separate Canvas viewer with a recorded WebSocket replay. From the
repository root:

```console
python -m pip install websockets
python -m harness.replay_prompt harness/recordings/reference.ndjson --port 8768
```

In another terminal:

```console
python -m http.server 8770 --bind 127.0.0.1 --directory harness/example
```

Open <http://127.0.0.1:8770/?ws=ws://127.0.0.1:8768/stream>. This needs no
checkpoint, CUDA, PyTorch, tokenizer, or running inference model. Each connection
replays the unchanged recording from its beginning, including both mapping
epochs, then loops. Replay timing is synthetic, not measured inference speed.
The live `/app/` workspace no longer has a recording file picker or playback
controls; see the [Canvas guide](../example/README.md).

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
