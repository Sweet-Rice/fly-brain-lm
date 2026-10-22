# Visualization stress measurements

Measured on **2026-10-21**, comparing `a6fedaa` with the issue #21 changes.
[Raw stage measurements](stress-results.json) accompany these results. Timings
are observations on this machine, not CI thresholds or guaranteed capacity.

For the current firing rule and a full-model comparison of disabled, idle,
recording and live instrumentation, see [model activity](ACTIVITY.md#full-inference-measurement).
The stage-only timings below predate the issue #3 host-mask extraction change.
The fly-brain dashboard layout (2026-10-21) later raised static geometry to
16,516,164 bytes in five steady buffers; its software-adapter measurements are in
the [app README](app/README.md#fly-brain-schematic). The tables below are unchanged.

## Target and environment

- Actual checked-in connectome: **1,958 nodes, 19,037 directed edges**, five groups.
  The full default untrained model (12 layers, width 384, 94 active KCs) loaded
  from `data/connectome/wiring.npz` produces exactly the captured mapping,
  including node and edge order. No model dimensions or wiring were reduced.
- Windows, Ryzen 7 5800HS (8 cores / 16 threads), 16.5 GB physical RAM;
  AMD Radeon Graphics, driver 31.0.21925.1001. Python 3.12, CPU PyTorch
  2.14.1, Node 22.17.0. Model stage measurements use one CPU thread.
- Actual browser: Chromium 155, WebGPU adapter `amd / gcn-5`, fallback **false**.
  The benchmark canvas is 1,100 by 430 backing pixels. Fence times include
  driver and browser scheduling; they are not GPU timestamp queries.
- Fixture activity rotates batches of 94 KCs through the actual topology.
  The Node parsing profiles use the captured prompt fires. Rates are
  synthetic, not measured training or inference throughput.

## Bounds before and after

| Workload | Before | After |
|---|---:|---:|
| 2,000 fires with the server loop stalled: scheduled callbacks | 2,000 | 1 |
| Same workload: retained fire JSON in the handoff | 19,675,813 B | 630,413 B |
| Same workload: pending messages | Unbounded callbacks | At most 64 |
| Real topology, 1,000 fires before one draw: buffer writes | 1,001 | 2 |
| 50 immediate mapping replacements: peak live buffer handles | 154 | 7 |
| Same replacement probe: peak explicit live buffer bytes | 349,203,968 B | 13,694,304 B |
| Steady scene: live GPU buffers / explicit bytes | 4 / 6,847,168 B | 4 / 6,847,168 B |
| After renderer disposal: live buffers / bytes | 0 / 0 | 0 / 0 |

The two burst writes are one 76,148-byte timestamp array and one 32-byte uniform.
The producer profile models two clients; dropped counts represent missed client
deliveries, so 1,936 dropped producer fires account for 3,872 deliveries.
The static geometry stays at 6,770,988 bytes, with **zero static buffer creations
during activity**. The replacement probe calls the renderer directly; the main
application additionally coalesces pending mappings and permits only one GPU
submission awaiting completion. Its withheld-fence regression sends 1,000
mappings and 10,000 fires without allocating another scene or submitting work.

Live buffer bytes count handles the application owns, excluding canvas surfaces,
driver caches and physically pending GPU allocations. Destroying a replaced
handle permits reclamation after its prior submitted uses complete, as specified
by [WebGPU buffer destruction](https://gpuweb.github.io/gpuweb/#dom-gpubuffer-destroy).
The application submission gate bounds queued work; the direct replacement
probe alone does not measure driver peak memory.

## Separate stages

CPU rows below are p50 / p95 milliseconds. Parsing plus validation includes
JSON parsing; it is not an additional cost to add to the parsing-only row.

| Stage | Before | After |
|---|---:|---:|
| Mapping JSON serialization, Python | 4.3223 / 4.4624 | 4.3331 / 4.6890 |
| Gather pairs for 94 KCs, Python fixture | 0.0227 / 0.0408 | 0.0229 / 0.0398 |
| Fire serialization + handoff, stalled server | 0.2044 / 0.2443 | 0.1958 / 0.2264 |
| Mapping JSON parsing, Node | 2.1823 / 8.3913 | 2.2637 / 7.5835 |
| Mapping parse + validation, Node | 5.9737 / 10.3598 | 5.5914 / 10.8540 |
| Mapping layout, Node | 65.9917 / 92.4844 | 59.1175 / 77.1072 |
| Fire JSON parsing, Node | 0.1036 / 0.1498 | 0.1008 / 0.1261 |
| Fire parse + validation, Node | 0.2923 / 0.3754 | 0.2802 / 0.3754 |
| CPU activity updates, Node | 0.0438 / 0.0645 | 0.0328 / 0.0518 |
| Browser fire + draw submission | 0.4000 / 0.6000 | 0.4000 / 0.7000 |
| Browser submitted-work fence | 5.5000 / 7.9000 | 5.8000 / 7.7000 |

The actual model's mapping refresh measured 21.9334 / 90.8110 ms. Extracting
positive KC indices from its CPU address output measured 0.0268 / 0.0542 ms;
gathering the resulting 1,140 pairs measured 0.0260 / 0.0560 ms. These repeated
hook measurements exclude full token inference, training, and GPU-to-CPU transfer.

The browser's initial upload CPU / upload-with-fence times were 10.3 / 73.9 ms
before, and 3.2 / 18.4 ms after. First-use compilation and warm caches affect
these single samples. Layout and parsing implementations did not change; their
timing differences are noise, not claimed optimizations. The demonstrated
bottlenecks fixed here are callback retention, per-fire uploads and resource
retirement, rather than the layout math.

## Sustained and failure checks

- The real main harness connected to a feed that produced **14,400 fires at
  120/s for 120 seconds**, with zero server drops. The UI was observed through
  step 9,309 during navigation; final receipt counters were cleared on disconnect.
  Fit, zoom and keyboard pan worked during traffic;
  protocol counters showed no malformed or undeclared pairs and the browser
  reported no GPU errors. This rate is an observed operating point, not a maximum.
- The real WebGPU benchmark ran 6,000 fires over 600 frames, with 20 periodic
  replacements plus a 50-replacement burst. CPU fire/submission p50/p95 was
  0.8/1.2 ms; fence time 5.7/7.6 ms. Steady handles stayed at four, peak at
  seven, and all were released. Frame spacing p50/p95 was 6.9/13.9 ms.
- Real loopback tests stall one send while a second client continues, exercise
  30 mapping epochs and 60 reconnects, and verify mapping-first delivery and no
  retained client handlers. Failed writers and never-completing sends clean up.
- A deliberately blocked event loop receives 20,000 producer calls with one
  scheduled drain and a bounded queue. A blocked recorder receives 10,000 fires
  while its write remains held; the producer finishes, the queue stays at eight,
  and 9,992 fire messages are dropped. No producer waits for socket/file I/O.
- Hidden-document and withheld-RAF/fence tests retain only the latest mapping,
  fixed timestamp arrays and bounded GPU work. Repeated resets and disposal
  release buffers, observers and listeners. Timestamp tests advance through
  1, 30 and 365 days, including rebases and expiration.

The in-app test browser keeps its automation tabs `visibilityState=visible`;
opening another automation tab did not generate a hidden transition. Hidden-tab
behavior is verified with deterministic visibility events and withheld frames,
not claimed as an observed OS background/sleep test. This run is **not a
multi-day wall-clock soak**. Total browser/driver heap behavior over days,
GPU device sleep/resume and CUDA extraction costs remain unmeasured.

## Chosen degradation and operating limits

- Default server handoff: 64 messages and one scheduled drain; per-client queue:
  64 messages plus a send in progress; recorder: 256 messages plus a write in
  progress. Queue size is a positive integer. Memory scales with message size
  and connected-client count. A full queue drops whole fires, preserving gaps
  in `t`; a replacement mapping discards obsolete pending activity.
- JSON serialization and KC extraction remain synchronous CPU work on the
  model thread. File and socket writes run elsewhere. Mapping refresh and
  serialization are occasional topology work, not per-token work.
- The application keeps one current graph, one latest pending mapping and a
  dense timestamp array per retained mapping. It uploads activity once per
  rendered frame and waits for the previous submission before more GPU work.
  Hidden tabs stop drawing and close the live socket. Returning reconnects to
  a fresh mapping; missed activity is discarded. Manual Disconnect cancels
  resumption. Recording delivery remains bounded without retaining history.
- Shader clocks rebase after 60 seconds, retaining only recent timestamps, so
  float32 millisecond precision does not decay over multi-day operation.
- The v1 protocol has no acknowledgements. Browser-native WebSocket buffers
  during an actively blocked JavaScript thread are outside application control;
  the hidden-tab disconnect policy reduces exposure but is not an end-to-end
  native-buffer memory guarantee. Long main-thread stalls can still hurt UX.
- Only the current largest intended topology is measured. Layout remains a
  roughly 60 ms main-thread task per installed mapping; rapidly changing
  topologies can interrupt interaction. Larger future graphs need new measured
  limits rather than extrapolation from these results. Model wiring and v1
  message formats are unchanged.

## Reproduce

From the repository root, with project dependencies installed:

```console
python -m harness.stress --events 2000 --model
node harness/app/stress-profile.mjs
python -m pytest -q test/test_viz_stream.py test/test_viz_stress.py test/test_stress_fixture.py
npm --prefix harness/app test
python -m http.server 8772 --bind 127.0.0.1 --directory .
```

Open `http://127.0.0.1:8772/harness/app/stress.html` and run both benchmark
buttons. For the main harness, run this finite feed, then enter its printed URL
in `http://127.0.0.1:8772/harness/app/`:

```console
python -m harness.stress --serve --rate 120 --seconds 120
```

For a before/after comparison, copy `harness/viz_stream.py` and all `harness/app/`
JS files plus `package.json` from baseline commit `a6fedaa` into a scratch directory
without changing the working checkout. Pass the saved Python file to
`harness.stress --baseline PATH`; pass the saved app directory as the Node
profiler's positional argument or the browser benchmark's modules directory.
Timing loops have finite sample counts; they are profiling tools, not services
that accumulate a history indefinitely. Stop the static server with Ctrl-C.

## Telemetry adapter overhead

Measured on **2026-10-21** for issue #41 (`harness/telemetry/adapter.py`) with:

```console
python -m harness.telemetry.benchmark --requests 5
```

- Windows 11 (10.0.26200), Intel64 Family 6 Model 186 Stepping 2, Python 3.14.7,
  CPU PyTorch 2.14.1, one PyTorch thread. Other heavy processes shared the
  machine during the run, so differences of a few percent are within run-to-run
  noise: the run just before this one measured −2.0%, −8.5% and −6.6% for the
  three telemetry modes (recording p95 47.90 ms in that run).
- Full default untrained vibe2 model (12 blocks, width 384) built from
  `data/connectome/wiring.npz` with seed 0; a fresh model, stream and engine per
  mode. Greedy decoding of `Once upon a time, a fly`: one untimed warm-up request,
  then 5 timed requests of 48 completion tokens each.
- tokens/s is completion tokens divided by the wall time of the timed requests
  (prefill included). Per-token latency is the time between consecutive
  generated tokens (prefill excluded).

| Mode | tokens/s | p50 ms/token | p95 ms/token | tokens/s vs disabled |
|---|---:|---:|---:|---:|
| disabled | 27.17 | 32.52 | 37.19 | baseline |
| adapter idle | 26.63 | 33.40 | 37.73 | -2.0% |
| recording | 26.29 | 34.11 | 38.04 | -3.2% |
| live client | 25.90 | 34.25 | 38.61 | -4.7% |

- **disabled**: `stream_model` attached as in `model.serve.serve`, no adapter,
  nobody listening.
- **adapter idle**: adapter hooks and engine wrapper installed, nobody listening.
  Lifecycle events are built but not sent; no `token_step` is built.
- **recording**: adapter plus an NDJSON recording. Every step serializes its
  `fire` and `token_step`.
- **live client**: adapter plus one WebSocket harness reading every message
  (678 messages over the 6 requests).

Recording and live client are full telemetry load: they include the cost of the
v1 `fire` stream as well as the extension messages. No mode dropped a message
(stream and recording drop counters were 0). Per step the adapter decodes one
token; while someone listens it also reduces over the KC code once and serializes
one `token_step`. Its hooks only read tensors, so logits and model state are
unchanged (`test_logits_identical_with_and_without_telemetry`).
