# FlyBrainLM prompt and live brain workspace

An integrated React, TypeScript, and Vite workspace pairing FlyBrainLM HTTP prompt
generation with an embedded live WebGPU brain viewer and neuron inspector. The application
mounts the shared `harness/app/live-atlas.js` module in `AtlasWorkspace`, reusing the
tested WebGPU rendering pipeline, neuron indexer, and protocol receiver, while
`useGeneration` drives HTTP text generation and health polling.

## Local development

### Prerequisites

- Node.js 22+
- A running FlyBrainLM model service with HTTP API (port 8771) and visualization stream (port 8765)

### Starting the real model

Checkpoints are gitignored and not bundled; initialize an untrained scratch checkpoint
first (default `model.init_model` writes `model/checkpoints/<impl>.pt`, e.g. `vibe.pt`,
not `init.pt`; do not overwrite private trained checkpoints):

```console
# Step 1: Initialize an untrained scratch checkpoint (vibe or vibe2) to a new path
python -m model.init_model --impl vibe2 --out /tmp/flybrain-scratch.pt

# Step 2: Start the model server with HTTP API on 8771 and visualization stream on 8765
python -m model.serve.serve --ckpt /tmp/flybrain-scratch.pt --port 8771 --viz-port 8765
```

### Starting the frontend

From the repository root:

```console
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173/`.

### Same-origin routing and proxy configuration

- **Development (`5173`)**: The Vite development server proxies same-origin `/health` and
  `/v1/*` HTTP requests to `FLYBRAIN_API_URL` (default `http://127.0.0.1:8771`), and
  WebSocket upgrades on `/stream` to `FLYBRAIN_STREAM_URL` (default `ws://127.0.0.1:8765`).
  The browser connects to same-origin `ws(s)://<host>/stream`, avoiding extra endpoint
  configuration and browser mixed-content restrictions.
- **Preview (`4173`)**: `npm --prefix frontend run preview` serves the production build
  and uses the exact same Vite proxy rules for both HTTP and WebSocket upgrades.
- **Production**: Deploy the static bundle from `frontend/dist/` behind a reverse proxy
  (such as Nginx or Caddy) configured to route `/health` and `/v1/*` to the model HTTP
  port and proxy WebSocket upgrade requests on `/stream` to the model visualization port.
- **Configurable ports**: Set environment variables before starting Vite to override ports:
  ```console
  FLYBRAIN_API_URL=http://127.0.0.1:9001 FLYBRAIN_STREAM_URL=ws://127.0.0.1:9002 npm --prefix frontend run dev
  ```
  Never commit workstation URLs or credentials.
- **Memory-only credentials**: The optional API key in the interface remains in
  component/controller memory only and is never written to browser storage. Only the
  visual theme preference is persisted in `localStorage`.

### Network HTTPS and WebGPU

WebGPU requires a secure browser context: loopback HTTP or trusted HTTPS. Opening
the workspace through a Tailnet IP over plain HTTP disables WebGPU; a private
network alone does not make the browser origin secure.

For private Tailscale HTTPS, enable Serve/HTTPS with your Tailnet administrator,
then start Vite with the exact device hostname allowed:

```console
FLYBRAIN_ALLOWED_HOSTS=<device>.<tailnet>.ts.net npm --prefix frontend run dev -- --host 0.0.0.0
tailscale serve --bg http://127.0.0.1:5173
```

Open the HTTPS URL reported by Tailscale, not the HTTP IP URL. Set
`FLYBRAIN_API_URL` and `FLYBRAIN_STREAM_URL` as usual when the model uses
non-default ports. `FLYBRAIN_ALLOWED_HOSTS` accepts a comma-separated explicit
hostname list for both development and preview; it does not disable Vite's host
checks. This uses private Serve, not public Funnel.

## Architecture and lifecycle

- `src/App.tsx`: Page layout composing the prompt composer, model response bench, and
  `AtlasWorkspace`. It coordinates generation submission with atlas connection via `onGenerate`.
- `src/components/GenerationSettings.tsx`: Native modal dialog for generation parameters
  and the memory-only API key, with keyboard focus cycling and inline validation.
- `src/components/atlas/AtlasWorkspace.tsx`: Mounts `mountLiveAtlas` from `harness/app/live-atlas.js`.
  It isolates DOM ownership within supplied container elements for the WebGPU canvas, region
  labels, and neuron inspector, and exposes an imperative `LiveAtlasHandle` (`ensureConnected`,
  `connect`, `disconnect`, `fit`, `zoom`, `dispose`) to callers.
- `src/hooks/useGeneration.ts`: React adapter around the DOM-free `GenerationController` in
  `harness/app/generation.js`, consuming types from `harness/app/inference-contract/v1/`.
  Forwards `GenerationSubmitOptions` to ensure atlas connection on generation submit.
- `src/hooks/useTheme.ts`: Central theme policy (operating system default, header toggle,
  retained in `localStorage`).
- `src/components/ui/`: Model-neutral design system primitives.
- `vite.config.ts`: Configurable loopback development and preview proxy for HTTP and WebSocket.

### Module lifecycle and performance

- **Shared live-atlas module**: `harness/app/live-atlas.js` (with declarations in `live-atlas.d.ts`)
  encapsulates `ProtocolReceiver`, `LiveSource`, `initializeGPU`, `mountInspector`, and group layout.
  While mount functions manage their supplied DOM containers, the underlying controller, indexer,
  protocol parsers, and layout math remain pure.
- **Batched counter snapshots**: Counter snapshots are coalesced and batched per animation frame;
  individual per-fire events stay out of React state to avoid render churn during high-frequency token generation.
- **GPU cancellation**: `initializeGPU` accepts an optional fourth options argument `{ signal }`,
  allowing pending asynchronous adapter and device initialization to abort cleanly during component unmount.
- **React StrictMode resilience**: The lifecycle design handles delayed adapter cleanup, late
  device destruction, real GPU remounts, single stream connection, and final cleanup without
  resource leaks or orphaned WebSockets.
- **Non-blocking stream decoupling**: Live activity is the configured model's shared stream, not
  token-aligned or per-request attribution; counters and step persist until an explicit source reset
  or reconnect. `onGenerate` calls `ensureConnected()` to reconnect if disconnected, with no claimed
  request/run correlation; the stream naturally persists across prompts. Stream disconnection,
  errors, or an unreachable WebSocket stream never halt, delay, or block HTTP text generation.

## Controls and data limits

- **Canvas interaction**: Clicking a node picks it; dragging above the movement threshold pans
  the camera without selecting; clicking the canvas background clears selection.
- **Graph navigation**: Drag canvas or use keyboard arrow keys to pan; Fit, Zoom In (`+`), and
  Zoom Out (`-`) buttons control framing (`+`/`-` keys zoom, `0`/`Home` fit).
- **Generation settings**: The composer’s Settings button opens a modal rather than expanding
  the page. Done, the close button, Escape, or a backdrop click dismiss it and restore focus
  to Settings. Invalid generation parameters reopen the dialog at the first invalid field.
- **Connection dots**: Idle connections are not drawn. Each validated fire sends one dot
  from source to target over the 600 ms activity window; a repeated fire restarts it.
  Nothing animates between fires. Reduced motion shows stationary dots along the fired
  connection for the same window, and hidden pages pause drawing.
- **Connection controls**: Connect / Disconnect button. Disconnecting explicitly resets the
  cached mapping, counters, and node selection; reconnecting restores the mapping only while
  counters restart and selection stays cleared.
- **Neuron Inspector**: Sparse node ID search, incoming/outgoing neighbor degree counts,
  paginated neighbor lists (10 per page with `Prev` and `Next`), and bounded observed fire history
  per node (capped at 32 steps) within the current epoch.
- **Data caveats**: Coordinates are illustrative layout projections; connectome body IDs are
  not exported in standard mappings and are explicitly displayed as unavailable / not exported
  (never inferred or speculative anatomy). The Activity tab's tooltip explains
  that fires are positive KC code, not biological spikes; no observed fire does not mean inactive.
- **Touch targets**: At least 44 px touch targets are guaranteed for mobile and viewport boundary
  controls; desktop inspector controls use a compact instrument layout without guaranteed 44 px targets.

## Retained legacy-only surfaces

The standalone dashboard in `harness/app/index.html` remains available for features retained
exclusively in the legacy harness:

- Offline recording playback controls and file picker (`reference.ndjson`)
- Run / token timeline (`request_lifecycle`, `token_step`, `stream_status`)
- Memory / dopamine inspector tables (observed writes, head summaries, feature slices)

These telemetry and recording surfaces are intentionally not embedded in the React workspace.

## Build and quality commands

```console
npm --prefix frontend run build
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend run preview
```

`build` type-checks and writes the static production bundle to `frontend/dist/`. `preview`
serves that bundle on `http://127.0.0.1:4173/` using the same proxy rules. Continuous
integration runs formatting, linting, typechecking, and production build; it does not run
or claim browser tests for React.

## Design system

The interface uses a small, dependency-free component layer in `src/components/ui/`:

- `Button`: primary, secondary, quiet, and compact actions.
- `Field`, `Input`, and `Textarea`: labels, hints, errors, and ARIA relationships.
- `Panel`: neutral structural surface with optional heading metadata.
- `Status`: semantic connection and generation states.
- `Tooltip`: focusable-trigger help text linked with `aria-describedby`.

These components contain no inference or model-specific logic. Shared tokens in `src/index.css`
define color, spacing, typography, radius, focus, and motion behavior. Controls have visible
keyboard focus and meet touch target requirements on mobile and viewport boundaries.

The visual direction is a **neural field notebook**, not another chat transcript: a serif
writing surface, compact instrument labels, circuit-line details, and a side-by-side
stimulus/response bench at laptop and desktop widths. Research references included
[minimal-llm-ui](https://github.com/richawo/minimal-llm-ui),
[Ollama Chat UI](https://github.com/JithinM/ollama-chat-ui), and
[assistant-ui](https://github.com/assistant-ui/assistant-ui).

### One-screen desktop layout

At viewports at least 1200 × 680 CSS pixels, the workspace fills the viewport:
equally sized prompt and response panels share the top row, and the graph fills the
wide row beneath both, with the readout overlaid at its lower right. The neuron
inspector and group legend stack in the right column; group placement is in each
row's hover title.
Both 1920 × 1080 and 2560 × 1440 use the same panel arrangement and type sizes;
additional space expands the writing surfaces rather than the controls.
The main surface keeps only functional headings, state, and controls; marketing copy,
keyboard-help paragraphs, endpoint URLs, and redundant counters are not shown.
Diagnostic identifiers and readout caveats are available through hover titles.
Long responses and inspector details scroll inside their panels, with rounded,
theme-colored scrollbars. Generation settings open over the workspace without shifting
the panels and can scroll within the dialog. The response region is keyboard-focusable
for scrolling. Smaller or heavily zoomed viewports retain the normal scrolling document
rather than clipping controls.

`src/main.tsx` imports the global stylesheet before `App` so the declared cascade
layer order is established before atlas component styles, including in production.

## Focused verification evidence

- **Test suites**: Frontend lint, format:check, typecheck, and build passed cleanly. Shared
  live atlas lifecycle and consumer integration are validated by 240/240 tests in the harness
  test suite, including reduced-motion, hidden-page, and graph-reset dot-flow transitions.
- **Real model smoke**: Verified on CPU with a fresh untrained `vibe2` scratch checkpoint
  (HTTP 8771, WS 8765, Vite dev 5173): 1,958 real nodes and 19,037 edges loaded, real text
  generation and accepted activity with zero drops.
- **Headless WebGPU readback**: Headless SwiftShader software-GPU rendering omits presented
  canvas output in screenshots; verified via direct GPU texture readback proving graph layout,
  curved edges, regions, live highlights, and selected neighborhood.
- **Interactivity & lifecycle**: Real canvas click on node 700 selected it (11 incoming / 5 outgoing);
  inspector lookup for node 0 gave 167 outgoing neighbors across 17 pages; next page and neighbor
  101 inspection worked. Disconnect cleared mapping, counters, and selection; reconnect restored
  the mapping with restarted counters and cleared selection. Submitting a prompt after manual
  disconnect auto-reconnected the stream. Cancel and keyboard resubmit functioned correctly.
  Unsupported-WebGPU browsers degraded gracefully while retaining node inspection.
  Layout verified at 1440, 1024, and 390 widths with no horizontal document overflow in both
  light and dark themes. React StrictMode smoke confirmed delayed adapter cleanup, late device
  destruction, real GPU remount, single stream connection, and final cleanup.
- **Production preview smoke (port 4173)**: Verified under two conditions: (1) with an
  intentionally unreachable visualization stream, HTTP generation still completed 4 tokens;
  (2) live preview proxy smoke verified both default `/stream` WS proxy and HTTP
  `/health` + `/v1/completions` working on 4173 with 1,958 nodes, 19,037 edges, 4 generated
  tokens, 7 accepted fires, 0 drops, `layout='brain'`, and inspector node selection 700.
- **Compact workspace smoke**: With the trained `vibe2-tinystories` model, the document
  fit exactly at 1920 × 1080 and 2560 × 1440 without page overflow. The balanced
  prompt/response arrangement was also checked at 1568 × 804, with a real 128-token
  response overflowing only its own scroll region. Light/dark layouts, inspector
  Links scrolling, and readout
  Previous/Latest paging were exercised. A 128-token development run and an 8-token
  production-preview run completed with zero dropped signals. Popup keyboard cycling,
  Escape, backdrop dismissal, invalid-field focus, and the 390 × 844 mobile popup were
  checked; 1280 × 720 retained document scrolling without horizontal overflow.
  Actual GPU texture readback showed the dot geometry.

- **Uncluttered workspace smoke**: At 1568 × 804 and 1280 × 720, the document,
  graph tile, prompt/response panels, groups, and selected Activity inspector had
  no overflow after an actual 8-token completion. Localhost provided a secure
  context and working WebGPU; the Tailnet HTTP origin correctly reported
  `HTTPS required for graph`. Through private Tailscale Serve HTTPS, the same
  workspace had a secure context, drew the graph without the WebGPU banner, and
  completed a 64-token generation with live readout paging (64/64) and no errors.
- **Fire-dot and wide-graph smoke**: The graph canvas measured 1349 × 502 at
  1920 × 1080 and 875 × 302 at 1280 × 720, with no page overflow. GPU texture
  readback showed no connection dots while idle, with one GPU submission in 800 ms
  rather than a continuous loop. During a real generation, consecutive frames showed
  dots travelling from the antennal lobe through the calyx toward the lobe, with no
  WebGPU errors.
