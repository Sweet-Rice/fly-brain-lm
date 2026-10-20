# Standalone visualization harness

This is issue #18's browser/WebGPU scaffold. It accepts a configurable live
WebSocket source or a local NDJSON recording through one v1 receiver. It shows
validated mapping counts, groups and accepted fire events and initializes a
WebGPU viewport. Graph layout and drawing belong to #2; animation belongs to
#19; timed playback controls belong to #20. The existing `harness/example/`
Canvas demo is unchanged.

## Run from a fresh checkout

Python 3 serves the static application; there are no frontend dependencies, build
step, npm install or model requirements. From the repository root:

```console
python -m http.server 8772 --bind 127.0.0.1 --directory harness
```

Open **http://127.0.0.1:8772/app/** in a WebGPU-capable Chrome or Edge browser.
The page should show `WebGPU ready` and a cleared viewport. If an adapter is
unavailable, it shows an actionable message and protocol inspection still works.
Do not open the HTML with `file://`.

Choose **Open a recording** and select
`harness/protocol/v1/fixtures/reference.ndjson` or the real capture at
`harness/example/once_upon_a_time.ndjson`. This needs no network service, PyTorch,
checkpoint or tokenizer. The reference ends with 3 nodes, 2 edges and step 0
after its replacement mapping; the real capture ends with 1,958 nodes, 19,037
edges and step 10 (11 accepted fires). File reading processes the recording in
order, rather than reproducing inference timing. It yields regularly so switching
sources or clicking Disconnect can cancel a large file.

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
`process` method. A source switch/disconnect/reconnect clears protocol state;
late callbacks from an old socket or cancelled file cannot install old data.
An unexpected socket close retries after one second with a single retry timer.
Disconnect cancels that timer. File errors are displayed; malformed lines are
counted and skipped so later valid activity continues. Unsupported versions stop
either source until the user chooses a source again.

`main.js` publishes these DOM events on `#viewport` for the future renderer:

- `mapping`: `event.detail` is the fully validated mapping; discard the old scene.
- `fire`: `event.detail` is `{t, pairs}`, containing only accepted declared pairs.
- `reset`: discard all scene and animation state, including on reconnect.

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

Node.js 22+ runs the protocol/source/device lifecycle tests without installing
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
version shutdown. Python's contract-artifact tests remain independent.

For a browser check, load the real capture, connect to the replay, stop and
restart that replay, and confirm mapping-first recovery and cleared counters.
Check a narrow window and keyboard operation. In an unsupported-WebGPU browser,
confirm that the status explains the problem while both stream sources remain
usable. WebGPU uses the local machine's adapter; passing protocol tests alone
does not prove hardware support.
