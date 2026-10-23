# Visualization epic acceptance

Review guide for [issue #23](https://github.com/Sweet-Rice/fly-brain-lm/issues/23).
This branch contains the integrated implementation and its acceptance checks.
**Delivery to `main` remains pending:** several child PRs are open, so the epic's
"all child issues are complete" criterion is not yet satisfied. The tables below
are a GitHub status snapshot from **2026-10-21**, not a replacement for live issue
or PR status. This work does not merge PRs or close the epic.

## Criteria and evidence

| Epic criterion | Evidence in this checkout | Remaining qualification |
|---|---|---|
| All child issues complete | Delivery table below | Open child issues and dependency PRs still require review/merge and issue resolution. |
| Real model mapping followed by visible per-step activity | [`workflow.py`](workflow.py), [real-inference tests](../test/test_workflow.py), and [target browser verification](WORKFLOW.md#target-machine-verification) | Full untrained CPU model; no generated-text quality claim. Node tests cannot prove WebGPU rendering. |
| Bounded, non-blocking network and recording I/O | [`viz_stream.py`](viz_stream.py), [held-consumer stress tests](../test/test_viz_stress.py), and [measured operating limits](PERFORMANCE.md) | Socket/file writes run off the model thread; JSON serialization and KC extraction remain synchronous. Native browser buffers during blocked JavaScript are outside application control. |
| Reconnect and replacement mapping follow v1 | [Normative lifecycle](protocol/v1/SPEC.md), [real socket tests](../test/test_viz_stream.py), [workflow tests](../test/test_workflow.py), and [browser scenarios](WORKFLOW.md#4-exercise-the-live-browser-workflow) | Reconnect starts with the current mapping and only new activity; missed fires are not replayed. Replacement restarts step ordering. |
| Shipped recording works without the model | [Recorded-review instructions](WORKFLOW.md#1-offline-review-from-a-clean-checkout), [recording provenance](recordings/README.md), [fixture tests](../test/test_workflow_reference.py), and [JavaScript playback test](app/test/workflow.test.js) | Current browser review uses Python, `websockets`, and the separate Canvas viewer; no model/checkpoint needed. Replay cadence is synthetic. The live app has no playback controls. |
| Clean-checkout documentation and measured limits | [Root setup](../README.md), [complete workflow](WORKFLOW.md), [test guide](../test/README.md), and [performance report/raw results](PERFORMANCE.md) | Measured topology: 1,958 nodes / 19,037 edges. CUDA overhead, hardware sleep/resume and multi-day wall-clock soak remain unmeasured. |

The [workflow guide](WORKFLOW.md#target-machine-verification) records actual
target-machine live, reconnect, replacement, offline playback and `--no-viz`
HTTP checks. [Performance measurements](PERFORMANCE.md#sustained-and-failure-checks)
separate synthetic load from real inference and deterministic lifecycle tests
from unperformed hardware/background tests.

The browser recheck below records the earlier UI. Current live-only connection
and control behavior, including automatic owned-model binding, is documented in
the [workspace guide](app/README.md).

Epic browser recheck on **2026-10-21**, Windows/Radeon: the full CPU model's
`/epic` stream drew all 1,958 nodes and 19,037 edges with visible activity.
Reconnect resumed at step 11 in a fresh receiver epoch 0. A subsequent mapping
replacement reset epoch 1 / step 21 / 22 accepted fires to epoch 2 / step 4 /
5 accepted fires; no filtered pairs or GPU warnings/errors were observed.
After stopping that model process, the shipped file completed all 46 lines at
epoch 1 / step 10 / 11 accepted fires. Restart returned to epoch 0, Pause held
the counters fixed, and Play resumed. The page server used a stdlib-only venv.

## Child issue delivery

| Child | Implemented boundary and checks | Delivery status on 2026-10-21 |
|---|---|---|
| [#14](https://github.com/Sweet-Rice/fly-brain-lm/issues/14) Protocol | [Specification, schemas and fixtures](protocol/v1/), [conformance tests](../test/test_protocol_contract.py) | Closed; [PR #29](https://github.com/Sweet-Rice/fly-brain-lm/pull/29) merged. |
| [#15](https://github.com/Sweet-Rice/fly-brain-lm/issues/15) Mapping | [Model adapter/exporter](API.md#61-exporting-and-replacing-model-topology), [topology tests](../test/test_viz_stream.py) | Closed; [PR #32](https://github.com/Sweet-Rice/fly-brain-lm/pull/32) merged. |
| [#3](https://github.com/Sweet-Rice/fly-brain-lm/issues/3) Firing | [Exact firing rule and full inference measurements](ACTIVITY.md), [model-output/gradient tests](../test/test_activity.py), [real-consumer profile tests](../test/test_activity_profile.py) | Open pending review. Initial instrumentation is in [commit c44c0e66](https://github.com/Sweet-Rice/fly-brain-lm/commit/c44c0e66ab58a2b92330a0850e77efa06145320f), already on `main`; this branch adds exact acceptance coverage and one host-mask transfer per address output. CUDA latency is unmeasured on this CPU-only PyTorch installation. |
| [#16](https://github.com/Sweet-Rice/fly-brain-lm/issues/16) WebSocket | [Loopback transport](API.md#2-transport), [socket tests](../test/test_viz_stream.py) | Closed; [PR #27](https://github.com/Sweet-Rice/fly-brain-lm/pull/27) merged. |
| [#17](https://github.com/Sweet-Rice/fly-brain-lm/issues/17) Recording | [Bounded recorder](API.md#9-recording-format), [recording tests](../test/test_viz_stream.py) | Closed; [PR #28](https://github.com/Sweet-Rice/fly-brain-lm/pull/28) merged. |
| [#18](https://github.com/Sweet-Rice/fly-brain-lm/issues/18) Receiver | [`ProtocolReceiver`](app/protocol.js), [shared fixture tests](app/test/protocol.test.js) | Open; [PR #30](https://github.com/Sweet-Rice/fly-brain-lm/pull/30) pending. |
| [#2](https://github.com/Sweet-Rice/fly-brain-lm/issues/2) Graph | [Standalone viewer](app/README.md), [layout](app/test/layout.test.js) and [renderer tests](app/test/renderer.test.js) | Open; [PR #31](https://github.com/Sweet-Rice/fly-brain-lm/pull/31) pending. |
| [#19](https://github.com/Sweet-Rice/fly-brain-lm/issues/19) Animation | [Activity tests](app/test/activity.test.js), [renderer tests](app/test/renderer.test.js) | Open; [PR #33](https://github.com/Sweet-Rice/fly-brain-lm/pull/33) pending. |
| [#20](https://github.com/Sweet-Rice/fly-brain-lm/issues/20) Playback | [Playback tests](app/test/playback.test.js), [source tests](app/test/sources.test.js) | Open; [PR #34](https://github.com/Sweet-Rice/fly-brain-lm/pull/34) pending. |
| [#21](https://github.com/Sweet-Rice/fly-brain-lm/issues/21) Hardening | [Stress evidence and limits](PERFORMANCE.md), [producer stress tests](../test/test_viz_stress.py) | Open; [PR #36](https://github.com/Sweet-Rice/fly-brain-lm/pull/36) pending. |
| [#22](https://github.com/Sweet-Rice/fly-brain-lm/issues/22) Workflow | [Workflow](WORKFLOW.md), [real-model reference](recordings/README.md), [CI smoke](../.github/scripts/smoke.sh) | Open; [PR #37](https://github.com/Sweet-Rice/fly-brain-lm/pull/37) pending. |

Review the pending foundations in order: **#30 → #31 → #33 → #34 → #36 → #37**.
These cumulative branches target `main`; their overlapping changes are not
independent features to count twice. Resolve #3's acceptance separately, then
recheck every child and epic criterion against the final merged revision.
Prompt UI (#13), training/architecture (#4), browser-to-model controls, remote
exposure and new protocol fields remain outside this epic.

## Reproduce the integrated checks

Install the [test/model dependencies](WORKFLOW.md#2-install-the-real-model-dependencies),
then run from the repository root:

```console
python -m pytest -q
npm --prefix harness/app test
python -m harness.workflow --record NEW_RECORDING.ndjson
node --test harness/app/test/workflow.test.js
```

The final Node command defaults to the shipped reference. To check the fresh
capture instead, set `FLYBRAIN_WORKFLOW_RECORDING` to its path before running it:

```powershell
$env:FLYBRAIN_WORKFLOW_RECORDING = "NEW_RECORDING.ndjson"
node --test harness/app/test/workflow.test.js
Remove-Item Env:FLYBRAIN_WORKFLOW_RECORDING
```

```bash
FLYBRAIN_WORKFLOW_RECORDING=NEW_RECORDING.ndjson node --test harness/app/test/workflow.test.js
```

Choose a new recording path; the workflow refuses overwrites. The JavaScript
check exercises the shipped file source and receiver against real-model output;
it is not hardware rendering proof. Follow the [live browser scenarios](WORKFLOW.md#4-exercise-the-live-browser-workflow)
and [offline review](WORKFLOW.md#1-offline-review-from-a-clean-checkout) for that.

The [CI smoke job](../.github/workflows/ci.yml) runs this JavaScript check against
the recording it just generated, rather than substituting the checked-in file.
Its TAP log is included in `smoke-outputs` as `workflow-harness.txt`. The normal
Node test suite uses the checked-in file and needs no model dependencies.

The epic review also covers failed startup: an occupied loopback port must
preserve the actionable bind error, drain and stop the recorder, and allow
repeated cleanup. The regression is in
[`test_occupied_port_cleans_up_recording_and_allows_repeated_close`](../test/test_viz_stream.py).
