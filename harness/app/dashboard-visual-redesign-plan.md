# Dashboard Visual Redesign Plan: Cockpit & Instrument Aesthetic

- **Status**: Plan only (design specification)
- **Date**: 2026-10-21
- **Target Branch**: `docs/dashboard-visual-redesign-plan`
- **Target Implementation**: Follow-up implementation PR
- **Related Issues**: [#41](https://github.com/Sweet-Rice/fly-brain-lm/issues/41) (Export run and token telemetry for timeline/session bar, deferred), [#42](https://github.com/Sweet-Rice/fly-brain-lm/issues/42) (Export KC–MBON recurrent memory and dopamine telemetry, deferred)

## 1. Goal and Non-Goals

- **Goal**: Restyle the browser dashboard ([`harness/app`](README.md)) to adopt the high-density, dark scientific-instrument cockpit aesthetic of the visual reference. Reorganize desktop layout into a 3-column workspace that prioritizes the central graph while preserving all existing vanilla ES module features, DOM IDs, accessibility hooks, and runtime behavior.
- **Non-Goals**:
  - No build tooling, bundler (Vite), React conversion, charting library, or icon package; remain native no-build vanilla ES modules.
  - No 3D canvas, anatomical neuron meshes, biological coordinate projection, or FlyWire body ID hallucinations (`Body ID: not exported` remains explicit).
  - No fake token timeline, step scrubbing, record button, DA plot, state tensor, parameter perturbations, preset filter buttons, visibility toggles, display sliders, or model architecture dropdown.
  - No backend, protocol v1, or serving modifications; completions and graph fires stream over separate transports (`HTTP/SSE` vs `WebSocket`).
  - Open issues [#41](https://github.com/Sweet-Rice/fly-brain-lm/issues/41) and [#42](https://github.com/Sweet-Rice/fly-brain-lm/issues/42) remain future work and are not prerequisites for this visual redesign.

## 2. Visual Reference Analysis (Self-Contained)

The visual reference defines a dark, high-density scientific telemetry cockpit organized for rapid instrument monitoring:
- **Palette**: Deep near-black graph background (`#0a0d12`), charcoal panel surfaces (`#121720`), elevated sub-surfaces (`#18202c`), and crisp, muted borders (`#1e2633`).
- **Typography & Scale**: Dense, clean typography pairing sans-serif UI headers (`system-ui`, `-apple-system`, `sans-serif`) with monospace numeric telemetry (`ui-monospace`, `SFMono-Regular`, `Consolas`). Target scale: 16–18px section titles, 13–14px body text, 12px metadata and badges. Verify all text/background combinations meet WCAG AA (minimum 4.5:1 text contrast).
- **Accents**: Restrained cyan (`#38bdf8`) / teal for focus rings and selection accents; existing amber and violet colors are reserved strictly for mapped neuron group data, never decorative tinting.
- **Geometry & Spatial Economy**: Tight 8–12px padding and gaps with modest 4–6px border radii. On desktop viewports, the central graph and primary telemetry dominate the first fold without vertical overflow traps or nested scrolling traps.

## 3. Mapping Reference Regions to Implemented Features

| Reference Region | Implemented Feature & Controls | DOM Anchors | Constraints & Data Truthfulness |
|---|---|---|---|
| **Top Header** (~60–68px) | Workspace title, eyebrow, source status badge, and accepted mapping counters. | `<header>`, `.eyebrow`, `h1`, `#source-status`, `#nodes`, `#edges` | Displays high-level summary badges; does not duplicate controls or invent checkpoint metadata. |
| **Left Rail** (~220–240px) | WebSocket connection form, NDJSON recording file picker, and mapped groups table. | `#connection`, `#endpoint`, `#disconnect`, `#recording`, `#groups` table | Read-only telemetry of declared group labels and node counts; not clickable pathway filter presets. |
| **Center Viewport** (Dominant flex) | WebGPU 2D graph canvas, canvas labels overlay, status banner, and navigation controls. | `#viewport`, `#graph-labels`, `#gpu-status`, `#fit-graph`, `#zoom-in`, `#zoom-out` | 2D grouped-grid schematic; arrowheads point to destination; click-to-select and pan/zoom gestures preserved. |
| **Lower Dock** (Below graph) | Prompt composer & generation interface, plus recording playback transport bar. | `.prompt-section`, [`mountPrompt`](prompt-view.js), `#recording-play`, `#recording-pause`, `#recording-restart`, `#recording-speed` | Transport controls playback rate (500 ms at 1×), NOT inference pause. Prompt retains sampling parameters, in-memory API key, and SSE stream. |
| **Right Inspector Rail** (~300–340px) | Neuron Inspector: sparse ID search, group role, degree metrics, paginated neighbors, and fire history. | `.inspector-section`, [`mountInspector`](inspector.js), `#inspector-select-form`, `#inspector-node-input`, `#inspector-select-btn`, `#inspector-clear-btn` | Retains $O(1)$ sparse indexing, 32-step history cap, and missing-data notice; FlyWire body IDs remain explicitly unavailable. |
| **Collapsible Diagnostics** (Bottom) | Stream diagnostics panel: step counter, fire counts, dropped messages, protocol status, and latest fire. | `.stream-section`, `#step`, `#fires`, `#dropped`, `#pairs-dropped`, `#protocol-status`, `#last-fire` | Collapsed by default under an expandable `<details>` disclosure to keep the primary cockpit view compact. |

### Complete Inventory of Preserved Named Controls
- **Source & Playback**:
  - WebSocket connection form `#connection`: input `#endpoint`, submit button (`Connect`), disconnect button `#disconnect`, endpoint guidance `#endpoint-help`.
  - Recording file input `#recording` and guidance text `#recording-help` ([`harness/app/sources.js`](sources.js)).
  - Playback transport controls: Play `#recording-play`, Pause `#recording-pause`, Restart `#recording-restart`, speed selector `#recording-speed` (0.25×..4×) ([`harness/app/playback.js`](playback.js)).
  - Live connection status text `#source-status`.
- **Graph Viewport & Gestures**:
  - WebGPU status `#gpu-status`, canvas `#viewport`, labels container `#graph-labels`, guidance hint `#graph-help`.
  - Camera navigation buttons: Fit `#fit-graph`, Zoom in `#zoom-in`, Zoom out `#zoom-out` ([`harness/app/camera.js`](camera.js)).
  - Interactive gestures: mouse drag-to-pan, scroll-to-zoom, node click-to-select, background click-to-clear, keyboard navigation (arrows to pan, +/− to zoom, 0/Home to fit).
- **Prompt Composer**:
  - Multiline prompt textarea `#prompt-input` (`Ctrl+Enter` / platform `Cmd+Enter`), submit button `#prompt-generate-btn`, cancel button `#prompt-cancel-btn` (with `AbortController`), clear button `#prompt-clear-btn`, clipboard copy button `#prompt-copy-btn`.
  - Parameter inputs: max tokens `#prompt-max-tokens` (1..128), temperature `#prompt-temperature` (0.0..2.0), top-k `#prompt-top-k` (1..50257).
  - Session memory-only API key input `#prompt-api-key`, health retry button `#prompt-health-retry-btn`, state badge `#prompt-status`, polite announcement `#prompt-announcement`, streaming output container `#prompt-output` ([`harness/app/prompt-view.js`](prompt-view.js), `PROMPT_DOM_IDS`).
  - Preserve current-run metadata, usage, and finish reason (`#prompt-run-id`, `#prompt-usage`, `#prompt-finish-reason`), inline validation errors, disabled/busy states, and partial output after cancellation.
  - Supports exact states: `idle`, `validating`, `submitting`, `streaming`, `cancelling`, `completed`, `cancelled`, and `failed` ([`harness/app/generation.js`](generation.js)).
- **Neuron Inspector**:
  - Search form `#inspector-select-form`: numeric input `#inspector-node-input`, Inspect button `#inspector-select-btn`, Clear button `#inspector-clear-btn`.
  - Details container `#neuron-details`: Neuron ID `#neuron-id`, Group / Role `#neuron-group`, Body ID `#neuron-body-id` ("not exported").
  - Degree metrics (in-degree, out-degree), paginated upstream/downstream neighbor buttons (`Prev`/`Next`, 10 per page; clicking any neighbor selects that node), bounded observed fire step list (max 32 steps per epoch), missing-data notice, live status `#inspector-status` ([`harness/app/inspector.js`](inspector.js)).
- **Stream Diagnostics & Telemetry**:
  - Counters `#nodes`, `#edges`, `#step`, `#fires`, `#dropped`, `#pairs-dropped`, status `#protocol-status`, groups table `#groups` (Group, ID, Nodes), and `#last-fire` preview string ([`harness/protocol/v1/SPEC.md`](../protocol/v1/SPEC.md)).

## 4. Layout, Responsive, and Visual Specification

- **Desktop (>=1280px)**: 3-column cockpit grid:
  - Header: Minimum height 56px with flex wrapping support to prevent clipping under zoom; includes workspace eyebrow, title, status pill, and mapping telemetry badges.
  - Cockpit Grid: Three-column layout (`grid-template-columns: minmax(220px, 240px) minmax(0, 1fr) minmax(300px, 340px); gap: 10px; padding: 12px; box-sizing: border-box; align-items: start;`).
  - Left Rail: Vertical stack for connection form, recording file picker, and mapped groups table. No nested scrolling prescriptions; natural content height allows standard document scrolling.
  - Center Viewport & Dock: Vertical flex column with 10px gap. WebGPU canvas allocates `clamp(420px, 50vh, 580px)` height to dominate the first fold. Prompt composer and recording transport dock directly underneath without artificial height clipping.
  - Right Inspector Rail: Dedicated ~300–340px sidebar housing the Neuron Inspector card with natural document-flow pagination.
- **Tablet (900px–1279px)**: 2-column layout (Center + Inspector):
  - Left rail collapses into an expandable full-width disclosure drawer (`<details class="rail-left-drawer">`) positioned immediately beneath the header.
  - Center and right columns share remaining width (`grid-template-columns: minmax(0, 1fr) 300px; gap: 10px;`).
- **Mobile (<900px)**: Single-column linear vertical stack:
  - Reading order: Header -> Source drawer -> Graph viewport -> Prompt dock -> Inspector -> Stream diagnostics.
  - Let inputs, tables, and status text shrink or wrap within `min-width: 0` containers; prevent horizontal page overflow without hiding clipped content. Touch targets enforce minimum 44px (`min-height: 44px; min-width: 44px;`).
- **Design Tokens & Typography**:
  - Backgrounds: Root/Canvas `#0a0d12`, Surface `#121720`, Elevated Surface `#18202c`, Panel Border `#1e2633`, Subtle Border `#161d27`.
  - Text & Accents: Text primary `#e2e8f0`, text muted `#8492a6`, accent/focus `#38bdf8`, error `#f87171`.
  - Type scale: 16–18px titles, 13–14px body text, 12px metadata/telemetry; monospace font family `ui-monospace, SFMono-Regular, Consolas`.
  - Group colors: Retain the renderer's existing group-to-color assignments consistently in nodes, edges, and group telemetry; do not assign biological meaning to a decorative reference-image color.
  - Contrast & Motion: Minimum 4.5:1 text contrast meeting WCAG AA; strict compliance with `@media (prefers-reduced-motion: reduce)` (600 ms solid highlight without transition animation).
  - Zoom & Keyboard: Full functional stability up to 200% browser zoom with zero nested scroll clipping; visible 2px cyan focus rings (`outline: 2px solid #38bdf8; outline-offset: 2px;`) on all interactive controls.

## 5. File-Level Change Map and Frozen Logic Seams

- **[`harness/app/index.html`](index.html)** (`:11-105`):
  - Reorganize semantic structure into `<header class="app-header">`, `<div class="cockpit-layout">`, `<aside class="rail-left">`, `<div class="viewport-center">`, `<aside class="rail-right">`, and `<details class="diagnostics-panel">`.
  - Group recording playback transport buttons within the lower prompt dock header or immediately beneath the graph canvas.
  - Preserve all existing DOM IDs (`#viewport`, `#prompt-workspace`, `#inspector-workspace`, `#endpoint`, `#recording`, `#groups`, etc.) and ARIA attributes.
- **[`harness/app/style.css`](style.css)** (`:1-85, 229-319, 769-893`):
  - Replace two-column `.workspace-grid` with three-column `.cockpit-layout` CSS grid.
  - Define dark instrument color tokens, typography scale (16–18px titles, 13–14px body, 12px telemetry), WCAG AA contrast, and responsive media queries (`max-width: 1279px`, `max-width: 899px`).
  - Style compact forms and tables without artificial scroll containers or clipped headers.
- **[`harness/app/main.js`](main.js)** (`:1-213`):
  - Preserve `main.js` event and DOM wiring as-is; only layout-related DOM updates if strictly necessary, zero scope by default since existing IDs remain stable.
  - Preserve `handleGenerate` source switching (recording to live stream) and protocol receiver event wiring (`mapping`, `fire`, `reset`).
- **[`harness/app/prompt-view.js`](prompt-view.js)** (`:83-566`):
  - Refine prompt composer internal grid to dock cleanly below the graph canvas.
  - Preserve `GenerationController` state machine, keyboard submission (`Ctrl+Enter`/`Cmd+Enter`), memory-only API key handling, and clipboard copy.
- **[`harness/app/inspector.js`](inspector.js)** (`:171-423`):
  - Refine card and neighbor list styling for the 300–340px right rail.
  - Preserve `NeuronIndex` topology/activity caching, neighbor pagination (10 per page), and selection events (`node-select`, `select-node`).
- **[`harness/app/renderer.js`](renderer.js)** & **[`harness/app/gpu.js`](gpu.js)** (`renderer.js:1-247`, `gpu.js:1-302`):
  - Update canvas background clear color to `#0a0d12` and selection ring color to match `#38bdf8` palette.
  - Preserve static triangle geometry, 2D camera matrices, 600 ms edge highlight decay, and vertex buffer allocation invariants.
- **Frozen Logic Seams**:
  - Do NOT touch [`harness/app/protocol.js`](protocol.js) (`ProtocolReceiver`), [`harness/app/generation.js`](generation.js) (`GenerationController`), [`harness/app/sources.js`](sources.js), [`harness/app/playback.js`](playback.js), [`harness/app/layout.js`](layout.js), [`harness/app/camera.js`](camera.js), [`harness/app/activity.js`](activity.js), [`harness/app_server.py`](../app_server.py), or [`model/serve/serve.py`](../../model/serve/serve.py).
  - Semantics documented in [`harness/app/README.md`](README.md) and [`harness/protocol/v1/SPEC.md`](../protocol/v1/SPEC.md) remain authoritative.

## 6. Ordered Implementation Phases and Acceptance Gates

1. **Phase 1: Semantic Shell & Grid Layout** (`index.html`, `style.css`):
   - Restructure markup into 3-column cockpit grid; verify container IDs and mount containers are intact.
   - *Gate*: Workspace loads cleanly; all existing DOM IDs present; 3-column grid renders without layout break or console error.
2. **Phase 2: Header, Left Rail, and Graph Viewport** (`index.html`, `style.css`, `renderer.js`):
   - Style compact header telemetry badges, left connection/recording rail, mapped groups table, and dark graph canvas.
   - *Gate*: Loading recording or WebSocket connection updates header counters, populates groups table, and renders 2D graph with pan/zoom.
3. **Phase 3: Prompt/Transport Dock and Inspector Rail** (`prompt-view.js`, `inspector.js`, `style.css`):
   - Dock prompt composer and playback transport below graph; refine inspector rail typography and neighbor pagination buttons.
   - *Gate*: Prompt submits/cancels; transport play/pause/speed operates; inspector selects node, displays degrees, and paginates neighbors.
4. **Phase 4: Collapsible Diagnostics and Responsive Breakpoints** (`index.html`, `style.css`):
   - Implement bottom collapsible diagnostics disclosure; verify 1280px desktop, 900px tablet, and mobile layouts.
   - *Gate*: Smooth breakpoint transitions without horizontal scrollbars; full control accessibility under 200% zoom.
5. **Phase 5: Verification and Final Polish**:
   - Execute verification smoke matrix across offline recording and live model workflows.
   - *Gate*: All checks in verification matrix pass; existing test suite passes without regressions.

## 7. Behavior Preservation and Data Honesty

- **Schematic 2D Viewport**: Central graph is a deterministic 2D grouped-grid schematic based on mapping arrays, not a 3D anatomical brain or physical coordinate reconstruction. Coordinates are calculated locally; protocol v1 carries no spatial positioning.
- **Dock vs. Timeline**: Lower dock contains the prompt composer and recording transport; it is NOT an inference scrubber or token timeline. Protocol `t` establishes event order, not wall-clock time. Recording playback uses a synthetic 500 ms cadence at 1×.
- **Separate Transports**: Model inference tokens stream over same-origin `HTTP/SSE`; graph fires stream over WebSocket. They operate on separate transports; the UI must never claim token-to-fire synchronization or known checkpoint revision.
- **Data Limitations & Missing Spikes**: A fire is an accepted source-destination pair, not a biological spike or voltage measurement. Missing fire events do not prove neuron inactivity. FlyWire body IDs remain explicitly displayed as not exported.
- **Playback vs. Inference Pause**: Playback pause halts local synthetic message delivery (preserving remaining delay), not upstream server inference.
- **Truthful Source Switching**: When generation begins during recording playback, `main.js` transitions truthfully to the live stream without claiming synchronized playback.
- **Deferred Issues [#41](https://github.com/Sweet-Rice/fly-brain-lm/issues/41) & [#42](https://github.com/Sweet-Rice/fly-brain-lm/issues/42)**: Issue #41 provides authoritative token-to-step correlation and request boundaries for future timeline/session bars. Issue #42 provides read-only KC–MBON recurrent memory tensor ($S$) and dopamine telemetry / named tensor capture, which depends on #41. Neither is a prerequisite for this UI restyling; neither involves parameter perturbation endpoints.

## 8. Baseline Review Evidence and Future Verification Matrix

- **Observed Baseline (2026-10-21 Review)**:
  - Desktop (1586x992): Initial document height measured 2642px pre-file load; the large header and source controls precede the graph. Loaded capture `once_upon_a_time.ndjson` (1,958 nodes, 19,037 edges, last step 10, 11 accepted fires, zero dropped messages or undeclared pairs); inspector verified on node 0 (Glomerulus, outdegree 167, 17 pages). Browser reported "No WebGPU adapter is available"; GPU rendering was not verified.
  - Mobile (390x844): Document height 4955px; zero horizontal overflow (`documentWidth 390`); static model proxy 404 notice and Retry Health button verified.
- **Practical Future Smoke Steps**:
  - *Offline Static Review*: Run `python -m http.server 8772 --bind 127.0.0.1 --directory harness`; open `http://127.0.0.1:8772/app/`; load `harness/example/once_upon_a_time.ndjson`. Verify Play/Pause/Restart/Speed, inspector node selection/pagination, and responsive breakpoints.
  - *Live Integrated Review*: Initialize scratch checkpoint (`python -m model.init_model --impl vibe2 --out /tmp/scratch.pt`), launch model server (`python -m model.serve.serve --ckpt /tmp/scratch.pt --port 8771 --viz-port 8767`), run app server (`python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771`). Open `http://127.0.0.1:8772/app/?ws=ws://127.0.0.1:8767/stream`. Test prompt generation, token streaming, cancellation, and clipboard copy.
  - *Visual Capture*: Capture browser screenshots at reference Desktop (1586x992), Tablet (1024x768), Mobile (390x844), and 200% zoom (1280x800 base). Do NOT add brittle screenshot or wording regression tests. Existing tests run once after implementation.
- **Future Verification Matrix**:

| Verification Check | Target Configuration | Expected Observable Behavior |
|---|---|---|
| **Offline Recording Smoke** | Static server command above -> load `once_upon_a_time.ndjson` | Graph renders; Play/Pause/Restart/Speed function; groups table populates; inspector selects node 0 and paginates neighbors. |
| **Live Prompt Smoke** | `vibe2` scratch checkpoint on 8771/8767 + `app_server` on 8772 | Model health shows ready; prompt streams tokens; Cancel aborts; Copy captures output; live graph displays fires. |
| **Prompt State Machine** | Offline static mode & live server | Verify all readiness (`/health`), auth (API key header), cancel (`AbortController`), and error states display clear notices without crash. |
| **Source Switching & Resync** | Connect WS -> disconnect -> load recording -> trigger Generate | Reset clears graph; disconnect stops stream; Generate transitions from recording to live truthfully; repeated switching is stable. |
| **Multi-Viewport Check** | Desktop (1586x992), Tablet (1024x768), Mobile (390x844) | Desktop displays 3 columns; Tablet collapses left rail; Mobile stacks cleanly with 0 horizontal overflow. |
| **Accessibility & Zoom** | 200% browser zoom at 1280x800 base; keyboard navigation | Tab reaches all inputs/buttons; arrow keys pan graph; focus rings visible; no clipped text or overlapping controls; reduced motion observed. |
| **WebGPU Unavailable** | Browser/environment lacking WebGPU adapter | Displays clean actionable fallback notice ("No WebGPU adapter is available") without console exceptions; protocol/inspector work normally. |
| **Regression Suite** | `npm test` in `harness/app` (Node.js 22+) | All existing unit and protocol tests pass cleanly (run once after implementation). |
