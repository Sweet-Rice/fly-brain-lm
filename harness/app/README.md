# Standalone visualization harness

This standalone WebGPU viewer accepts a configurable live WebSocket source or a
local NDJSON recording through one v1 receiver. It draws every declared node and
directed edge in groups derived from the mapping and highlights accepted fire
events, with play, pause, restart and speed controls for recordings. The existing
`harness/example/` Canvas demo is unchanged.

## Run from a fresh checkout

Python 3 serves the static application; there are no frontend dependencies, build
step, npm install or model requirements. From the repository root:

```console
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

Open **http://127.0.0.1:8772/app/** in a WebGPU-capable Chrome or Edge browser.
The page should show `WebGPU ready. Waiting for a mapping.` If an adapter is
unavailable, it shows an actionable message and protocol inspection still works.
Do not open the HTML with `file://`.

Choose **Open a recording** and select
`harness/protocol/v1/fixtures/reference.ndjson` or the real capture at
`harness/example/once_upon_a_time.ndjson`. This needs no network service, PyTorch,
checkpoint or tokenizer. The reference ends with 3 nodes, 2 edges and step 0
after its replacement mapping; the real capture ends with 1,958 nodes, 19,037
edges and step 10 (11 accepted fires). Playback starts automatically when a file
is selected. This is an explicit offline recording mode, not a fallback for an
unavailable production model.

### Play a recording

- **Pause** stops delivery of recording messages; **Play** resumes from that point.
  The remaining playback delay is preserved. An edge already highlighted may
  finish its 600 ms fade while playback is paused.
- **Restart** rereads the selected file from its beginning and starts playing.
  It clears the graph, counters, receiver epoch and activity; the first accepted
  mapping is epoch 0 again.
- **Playback speed** offers 0.25×, 0.5×, 1×, 2× and 4×. At the default 1×,
  accepted fires use a synthetic **500 ms** cadence. Speed changes this cadence,
  including the remaining current delay, not the renderer's 600 ms highlight
  duration.

The first mapping and first accepted fire are delivered immediately. After an
accepted fire, playback waits 500 ms at 1× before delivering the next nonblank
message; it does not add a delay after the final message. Later replacement
mappings stay at their position in the recording and clear obsolete graph
activity. The protocol's `t` only orders accepted fires: omitted steps add no
extra delay and create no synthetic fires. Recorded messages have no wall-clock timestamps, so playback
does not reproduce inference or training timing.

Reading is streamed, and choosing another file, connecting a live source or
clicking Disconnect cancels the current playback. Individual malformed lines
are counted and skipped through the same receiver used for live input; later
valid lines still play. An empty file or a file with no accepted mapping reports
an unusable-recording error. Unsupported protocol versions stop playback, clear
the graph and show an unsupported-data message. File read errors also appear in
the source status.

The graph status should match the accepted node/edge counts. Group labels follow
the mapping's array order; arrowheads point to the destination, including on
self-connections and reverse connections. Group names also appear in the table
below the graph. This is a schematic, not an anatomical reconstruction.

### Inspect the graph

- Drag within the graph to pan; scroll to zoom around the pointer.
- Use **Zoom in (+)**, **Zoom out (−)** and **Fit graph** without a mouse wheel.
- Focus the graph with Tab: arrow keys pan, +/− zoom, and 0 or Home fits the graph.
- Resizing preserves the current view; use Fit graph to show the whole network
  after changing window size. Dense graphs need zoom to inspect individual edges.

Layout is deterministic: each group gets a grid, with members sorted by numeric
node id. Empty groups keep their place, isolated nodes remain visible and sparse
ids do not allocate arrays sized by the largest id. Positions are computed locally;
no coordinates or floating-point fields are added to the protocol.

### Activity highlights

Every accepted source-to-destination pair brightens its entire directed edge,
including the destination arrowhead, then fades linearly to its base color over
**600 ms** of local elapsed time. The highlight mixes 80% white into the edge's
group color and raises its opacity to 95% at the start. A repeat restarts that
edge's 600 ms highlight; it does not add intensity. Other active edges keep their
own start times. With the system's reduced-motion preference enabled, the edge
holds its full highlight for 600 ms and then returns to its base appearance.

The protocol's `t` determines message order only. A jump in `t` highlights the
received pairs immediately, without waiting or inventing intermediate fires.
Filtered undeclared pairs cannot light an edge; valid pairs in the same accepted
fire still do. Mapping replacement, source switch, disconnect and reconnect
discard all prior activity, even when an edge id is reused. Recording playback
delivers the same validated fire events at its selected synthetic cadence.

For live input, install the replay's sole dependency if needed, then start it in
a second terminal from the repository root:

```console
python -m pip install websockets
python -m harness.replay_prompt --port 8768
```

Open **http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8768/stream** to connect
automatically, or enter that WebSocket endpoint and click Connect. The default
endpoint without a query parameter is the protocol default,
`ws://127.0.0.1:8765/stream`; startup does not connect until requested. To use a
live model instead, enter its printed stream URL, usually port 8767 in the
repository guides. Run one source per stream port. Leave other people's services
on 8765 and 8000 alone; choose another page/replay port if needed. Ctrl-C stops
each server you started.

## Receiver and renderer boundary

`protocol.js` has no DOM, WebSocket or model imports. `ProtocolReceiver.process`
accepts a raw JSON text message and returns the same action objects as the
shared [v1 fixtures](../protocol/v1/README.md). `receiver.mapping` is the current
validated mapping; `lastT` is the accepted step. A valid mapping replaces the
previous graph atomically; an invalid mapping preserves it. Node/group ids are
lookup keys, including sparse ids. Malformed or duplicate fire pairs reject
that whole fire without advancing the step. Undeclared pairs are filtered.
Unknown fields and message types remain forward compatible.

`sources.js` passes live message text and recording lines through that same
`process` method. `playback.js` gates the streaming reader before validation to
pause delivery and schedule the next message without caching the recording.
A source switch/disconnect/reconnect clears protocol state;
late callbacks from an old socket or cancelled file cannot install old data.
An unexpected socket close retries after one second with a single retry timer.
Disconnect cancels that timer. File errors are displayed; malformed lines are
counted and skipped so later valid activity continues. Unsupported versions stop
either source until the user chooses a source again.

`main.js` publishes these DOM events on `#viewport`:

- `mapping`: `event.detail` is the fully validated mapping; discard the old scene.
- `fire`: `event.detail` is `{t, pairs}`, containing only accepted declared pairs.
- `reset`: discard all scene and animation state, including on reconnect.

`gpu.js` consumes mapping/fire/reset events, retaining the latest mapping and its
recent activity while the GPU initializes. `layout.js` builds static triangle
geometry; `renderer.js` uploads it to edge/node buffers and draws them through a
native WGSL pipeline. `activity.js` uses a dense edge lookup and reusable typed
arrays for local start times, independent of sparse node ids and protocol steps.
`camera.js` handles fit, pan and anchored zoom in CSS pixels. Navigation and
resize update the camera without rebuilding geometry. Rendering runs only on
mapping, reset, navigation or resize, and while any highlight is active. Fires
update a reusable GPU activity buffer; animation frames update only uniforms.
Neither path rebuilds or uploads static graph geometry, and the renderer creates
no per-edge objects each frame. The animation loop stops when highlights expire.

A replacement mapping rebuilds the complete scene and fits its bounds. Obsolete
buffers are destroyed after submitted GPU work completes. Disconnect/reset clears
the viewport and labels. Device loss stops drawing and releases resources; reload
to retry. Allocation failures show a message and clear the old scene so it cannot
be mistaken for the new topology.

The UI retains only the latest mapping and a short latest-fire text preview;
it does not accumulate a history of fire events.

### Unsupported versions in browsers

The v1 contract and issue #18 request close code `1003`. The receiver emits that
exact logical action, and all contract fixtures are checked unchanged. However,
the [browser WebSocket API](https://websockets.spec.whatwg.org/#dom-websocket-close)
only permits application code to send `1000` or `3000–4999`: attempting
`close(1003)` throws and leaves the connection open. The browser adapter therefore
sends **4001** with reason `Unsupported protocol version`, reports protocol code
1003 in the UI, and stops automatic retries. This is an explicit browser transport
adaptation; the actual wire close code is 4001. Other protocol behavior follows
the checked-in contract.

## Verify

Node.js 22+ runs the protocol/source/renderer tests without installing
anything. From this folder:

```console
npm test
```

Or from the repository root:

```console
npm --prefix harness/app test
```

CI runs this suite independently of the Python jobs. Tests exercise every valid
and invalid #14 fixture against the actual JS receiver, real capture validation,
live/file parity, cancellation, stale sockets, reconnect/reset and unsupported
version shutdown. They also cover deterministic layout, sparse ids, self-loops,
buffer replacement/release, camera navigation, GPU initialization races,
deterministic activity expiry/restarts, burst buffer reuse and reduced motion.
Recording tests cover play/pause, speed changes, restart, stream order and gaps,
replacement mappings, invalid lines, unusable files and unsupported-version stops.
Python's contract-artifact tests remain independent.

For a browser check, open the real capture with no model or replay running and
confirm that its graph renders and edges brighten as playback advances. Pause
midway and confirm that the accepted step stays fixed after existing highlights
expire. Resume, try each speed, then restart: the first mapping must return to
epoch 0 and the fire counters must start over. Use a recording with a malformed
line followed by valid fires, a gap in `t` and a replacement mapping to check
that playback continues in recorded order. Empty files and unsupported versions
should show clear errors; switching to live input must stop recording delivery.

Connect to the replay, stop and
restart that replay, and confirm mapping-first recovery and cleared counters.
Active edges and their arrowheads should brighten during fires and settle back
after 600 ms without activity. Check a stream with gaps in `t` and repeated pairs;
the former must not delay a highlight and the latter must restart its duration.
Replace the mapping or reconnect during a highlight to confirm no activity leaks
into the new graph. Enable the system's reduced-motion preference and confirm
highlights hold steady before disappearing.
Verify that the reference recording replaces its first graph with only Sensory
and Output groups, 3 nodes and 2 edges. Load the real capture and inspect all
five groups, 1,958 nodes and 19,037 directed edges. Test dragging, wheel/button
zoom, keyboard panning and Fit; resize to a narrow window and repeat. In an unsupported-WebGPU browser,
confirm that the status explains the problem while both stream sources remain
usable. WebGPU uses the local machine's adapter; passing protocol tests alone
does not prove hardware support.
