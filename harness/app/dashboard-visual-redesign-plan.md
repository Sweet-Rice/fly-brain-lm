# Dashboard Visual Redesign Plan

- **Status**: Original visual redesign implemented in [#46](https://github.com/Sweet-Rice/fly-brain-lm/pull/46). The selection overlay uses fuchsia (incoming) and coral (outgoing) because the planned cyan and amber matched KC and MBON nodes. Rendering gates were checked on the SwiftShader software WebGPU adapter; no hardware adapter was available. Current behavior is documented in the [app README](README.md#graph-and-decoded-readout).
- **Date**: 2026-10-21
- **Related**: [#41](https://github.com/Sweet-Rice/fly-brain-lm/issues/41) run/token telemetry and [#42](https://github.com/Sweet-Rice/fly-brain-lm/issues/42) KC–MBON memory/dopamine telemetry. Both are future backend work and not prerequisites.

This is the historical redesign plan, not the current control inventory. The
subsequent live-only cutover removed Source/Settings, recording transport,
parameter/auth fields, and redundant retry/clear controls. Its original
"preserve every control" requirement and baseline setup below are superseded by
the [current workspace guide](README.md).

## 1. Goal and non-goals

**Goal.** Restyle the browser workspace (`harness/app`) after a reference dashboard mockup: a compact dark instrument layout whose dominant central graphic is a **fly brain**. The mapping's actual nodes and directed edges are drawn inside a frontal-view fly-brain illustration, at the neuropils where the modeled connections occur. Every existing control and behavior remains.

**Non-goals.**
- No build step, framework, chart or icon dependency; keep native ES modules.
- No protocol, backend, model, serving or data-pipeline change. Layout stays harness-owned ([SPEC](../protocol/v1/SPEC.md) excludes coordinates) and derived from the mapping alone ([API §6](../API.md)).
- No measured anatomy: no 3D meshes, soma coordinates, scale bar, hemisphere label, mirrored second circuit, or decorative neuron-like point cloud.
- No reference-only controls or data: token timeline or scrubbing, step/record buttons, activity or dopamine plots, dopamine neuron population, state tensor, parameter sliders, pathway filters, visibility toggles or model dropdown.

## 2. Reference summary

The mockup is local-only and not in the repository. It shows:
- A ~64px header: title, connection pill, dataset counts and mode buttons.
- A ~230px left rail of pathways and view options.
- A dominant center panel, about 60% of a 1586×992 viewport: a frontal view of the whole fly brain (central brain plus both optic lobes) as a dim, dense backdrop. A bright pathway runs from cyan Kenyon cells at the dorsal mushroom-body calyces through curved tracts to amber MBONs near the midline. Callouts with leader lines name each population; the panel has a legend, orientation axes and an "illustrative" chip.
- A transport strip under the brain and a ~340px right rail of stacked cards.
- Near-black canvas, charcoal panels, thin muted borders, 8–12px gaps, small radii, dense 12–14px type, and color reserved for data.

Adopted: the shell, the frontal brain silhouette, region placement, curved tracts, callouts, role colors, and dim base edges with bright activity. Not adopted: anything the data cannot back (§1).

## 3. Central fly-brain visual

### 3.1 What the data supports

- A mapping carries only groups, nodes and directed edges. The model exporter's groups are exactly `Glomerulus`, `KC_gamma`, `KC_alphabeta`, `KC_alphaprime_betaprime` and `MBON` (`GROUP_NAMES` in [`viz_stream.py`](../viz_stream.py)).
- Glomerulus nodes are PN-side glomerular inputs. MBON nodes are model compartments (three lobes × `heads_per_lobe`), and each KC connects to its own lobe's compartments ([API §6](../API.md)).
- The bundled wiring stores KC body IDs but no coordinates, and mappings carry no body IDs ([`data/README.md`](../../data/README.md)). Glomerulus and MBON nodes have no single-neuron position.

The center is therefore an **anatomically arranged schematic**: real nodes and edges placed in the right neuropils at illustrative positions.

### 3.2 Brain template

New module `harness/app/brain-atlas.js`, static data plus pure helpers:
- Normalized frontal-view outlines: central brain, both optic lobes and, per hemisphere, antennal lobe (AL), mushroom-body calyx, peduncle, vertical (α/α′) lobes and medial (β/β′/γ) lobes.
- Placement areas (ellipses or ellipse sectors) inside those outlines, and tract waypoints for AL→calyx (antennal lobe tract) and calyx→lobes (peduncle).
- The exact group-name→region table and `groupStyle(group, index)` (color and placement label), shared by the layout and the left-rail legend.

The AL and mushroom body are enlarged relative to true neuropil size so the circuit fills most of its hemisphere; that exaggeration is part of the illustrative label. `buildGraph` emits the template as a new static `regions` triangle array: muted low-alpha fills and outlines using the existing 7-float vertex with edge index −1. The renderer uploads it once per mapping and draws it before edges through the existing pipeline. No shader change or per-frame work. Context neuropils carry no dots.

### 3.3 Node placement

| Group | Placement | Reason |
|---|---|---|
| `Glomerulus` | Antennal lobe | Glomeruli are AL compartments and the circuit's inputs. |
| `KC_gamma`, `KC_alphabeta`, `KC_alphaprime_betaprime` | Three adjacent calyx sectors, one per group | Glomerulus→KC edges model PN input, which arrives in the calyx. |
| `MBON` | The lobe of the KC group supplying most of the node's declared incoming edges; a shared lobe area if none or tied | KC→MBON output occurs in the lobes. Placement uses mapping edges, not id arithmetic or counts. |

- The circuit fills one hemisphere: the viewer's left, where the bundled right-side KCs (`kc_side` in [`build_wiring.py`](../../data/build_wiring.py)) appear in frontal view. The other hemisphere's AL and mushroom body remain outline-only context. The UI shows no left/right label because mappings carry no side.
- Within an area, members sort by numeric id and fill a deterministic golden-angle spiral; no randomness. One uniform scale keeps node centers in the densest area at least 2.5 × `RADIUS` apart.
- Fallback: if no group name matches (for example protocol fixtures `PN`, `KC`, `Sensory`), keep today's grouped grid and draw no brain. In mixed mappings, unmatched groups occupy a labeled grid row beneath the brain. Empty groups keep a label; isolated nodes, sparse ids and self-loops still render.

### 3.4 Edges and activity

- Each declared pair keeps one directed shaft and destination arrowhead, with every vertex tagged by edge index, so activity semantics do not change.
- Edges between tract-linked areas (AL→calyx, calyx→lobe) become fixed 4-segment quadratic curves through the tract waypoint, producing the reference's bundled-tract look. Other edges stay straight; self-loops are unchanged.
- `buildGraph` and `buildSelectionGeometry` share one path function so selection overlays follow the curves.
- Tune base edge alpha so the silhouette and nodes remain legible beneath 19,037 overlapping edges. The [600 ms highlight](README.md#activity-highlights) is unchanged.
- Budget: a non-self edge grows from 3 to 9 triangles, increasing the real capture's edge buffer from ≈4.8 MB to ≈14.4 MB (19,037 × 27 vertices × 28 bytes). Measure layout and upload with [`stress-profile.mjs`](stress-profile.mjs) and [`stress.js`](stress.js), then record the results in the README.

### 3.5 Labels, legend and chrome

- Callouts reuse `graph.labels`, still one per mapping group and positioned by `gpu.js` through the camera. Each shows the mapping group name at its area; leader lines live in `regions`.
- Panel chip: "Schematic layout: illustrative positions, not measured anatomy", shown whenever the template is drawn.
- Legend: group swatches, active edge, selected node and incoming/outgoing overlay colors. Orientation: "Frontal view · dorsal ↑". No scale bar.
- Role colors: Glomerulus green; three distinguishable cyan, teal and blue KC tones; MBON amber. Unmatched groups keep the index palette. If selection overlays (incoming cyan, outgoing amber) become indistinguishable, adjust only the overlay colors.
- Picking (`pickNode` over `graph.positions`), pan/zoom and keyboard navigation do not change. Fit frames the whole brain.

## 4. Dashboard shell

| Region | Existing content | Notes |
|---|---|---|
| Header | Title; `#source-status` moved into a wrapping pill; `#nodes` and `#edges` moved out of the metrics list | Label counts as "mapping nodes" and "declared connections", never neurons or synapses. Show no checkpoint identity. |
| Left rail | Existing `<details open class="source-details">`: `#connection` (`#endpoint`, Connect, `#disconnect`, `#endpoint-help`) and `#recording`; `#groups` restyled as legend (swatch, group, ID, nodes, placement) | Read-only legend, not pathway presets. |
| Center | Title, chip, `#fit-graph`, `#zoom-in`, `#zoom-out`, `#gpu-status`, `#viewport`, `#graph-labels`, `#graph-help` | Fly-brain visual per §3. |
| Dock | Recording strip under the canvas (`#recording-play`, `#recording-pause`, `#recording-restart`, `#recording-speed`, `#recording-help`); prompt panel `#prompt-workspace` below | Transport paces recordings only; it is neither inference pause nor a token timeline. |
| Right rail | Inspector `#inspector-workspace` | Behavior unchanged. |
| Diagnostics | `.stream-section` as an open-by-default `<details>` strip: `#step`, `#fires`, `#dropped`, `#pairs-dropped`, `#protocol-status`, `#last-fire` | Open so errors and drops stay visible; users may collapse it. |

Every ID exists exactly once. Moved elements keep ID, role and live-region attributes, so `main.js` wiring stays untouched except for legend columns.

### Preserved controls and states

- **Source**: endpoint, Connect, Disconnect and recording file; Play, Pause, Restart and 0.25×–4× speed; source status.
- **Graph**: Fit, Zoom in/out; drag pan, wheel zoom, click select and background clear; arrows, +/−, 0 and Home on the focused canvas.
- **Prompt** ([`prompt-view.js`](prompt-view.js) `PROMPT_DOM_IDS`): health and Retry Health; prompt with Ctrl/Cmd+Enter; max tokens 1–128, temperature 0–2, top-k 1–50257; in-memory API key; Generate, Cancel, Clear and Copy Output; run ID, usage, finish reason, output, inline errors and announcements; every [`GENERATION_STATES`](generation.js) value.
- **Inspector** ([`inspector.js`](inspector.js)): ID form with Inspect/Clear; ID, group and body ID "not exported"; degrees; 10-node neighbor pages with Prev/Next and click selection; up to 32 recent fire steps; missing-data caveat and status.
- **Diagnostics**: all six counters, protocol status, groups table and latest-fire preview.

## 5. Layout and visual specification

- **≥1280px**: Header has minimum 56px height and wraps. Grid uses `minmax(220px, 240px) minmax(0, 1fr) minmax(300px, 340px)`, 10px gap and 12px padding. Canvas height `clamp(460px, 62vh, 720px)` gives about 615px at 992px viewport height, matching the reference's emphasis.
- **900–1279px**: Center and inspector use `minmax(0, 1fr) 300px`; the same left-rail `<details>` spans full width above.
- **<900px**: One column: header, source, graph, transport, prompt, inspector, diagnostics. Use `min-width: 0`, wrap text and tables, prevent horizontal page overflow, and provide 44px touch targets.
- **Tokens**: canvas `#0a0d12`, surface `#121720`, elevated `#18202c`, border `#1e2633`, text `#e2e8f0`, muted `#8492a6`, focus `#38bdf8`, error `#f87171`; monospace numerals.
- **Type and access**: 16–18px titles, 13–14px body and 12px metadata; WCAG AA text contrast (4.5:1); visible 2px focus rings; page scrolling only (no nested scroll areas or fixed-height text containers); existing reduced-motion highlight; full function at 200% zoom.

## 6. File change map

| File | Change |
|---|---|
| `brain-atlas.js` (new) | Outlines, placement areas, tract waypoints, group table and `groupStyle`. |
| [`layout.js`](layout.js) | `buildGraph(mapping)` keeps signature and existing fields and adds `regions`; brain placement when any group matches, grid otherwise; shared curved edge path for base and selection geometry. |
| [`renderer.js`](renderer.js) | Upload and draw `graph.regions` first among static buffers; no shader change. |
| [`gpu.js`](gpu.js) | Canvas clear color to the canvas token; callout label class; `pickNode` unchanged. |
| [`index.html`](index.html), [`style.css`](style.css) | Shell and visuals per §4–5. |
| [`main.js`](main.js) | Groups legend adds swatch and placement through `groupStyle`; keep all other wiring, including `handleGenerate` source switching. |
| [`prompt-view.js`](prompt-view.js), [`inspector.js`](inspector.js) | Add class hooks only if CSS alone cannot achieve the layout; no behavior change. |
| [`README.md`](README.md) | Replace the grid-layout description, document schematic limits and record measured geometry/upload numbers. |
| [`test/layout.test.js`](test/layout.test.js) | Replace grid-specific vertex-count assertions with the phase-1 behavioral checks. |

Untouched: `protocol.js`, `generation.js`, `sources.js`, `playback.js`, `camera.js`, `activity.js`, `NeuronIndex`, `harness/app_server.py`, `harness/viz_stream.py`, `model/` and the protocol.

## 7. Phases and acceptance gates

1. **Atlas and layout** (pure, Node-testable). On the real capture, glomeruli lie in the AL area, KCs in their groups' calyx sectors and MBONs in their incoming KC group's lobe. Node centers stay at least 2.5 × `RADIUS` apart. Output is identical across runs and node-order permutations. Every edge vertex carries its index and arrows end at destinations. Fixtures fall back to the grid without a template. Empty, sparse, isolated and self-loop cases render; bounds contain all geometry; layout time is measured.
2. **Rendering**. In a hardware-WebGPU browser with the real capture, Fit frames a visible brain and dots are at least 2 CSS px across in the 1586×992 desktop layout. Fires light curved AL→calyx→lobe tracts. Clicking selects the correct node and overlays follow curves. Replacement mappings rebuild with no GPU errors; upload size and time are recorded.
3. **Shell**. Every existing ID appears once, and all §4 controls work offline and live.
4. **Responsive and accessibility**. §5 rules hold at 1586×992, 1024×768, 390×844 and 200% zoom; keyboard reaches everything; reduced motion is respected.
5. **Docs and verification**. The §9 matrix passes and the existing JavaScript suite passes once.

## 8. Data honesty

- Positions are illustrative neuropil placements, stated by the chip and README; nothing implies measured coordinates or body side.
- Counts are mapping nodes and declared connections. Glomerulus and MBON nodes remain model abstractions; labels and inspector use mapping group names.
- A fire is a declared edge from a positive KC code, not a spike, and no fire does not mean inactivity.
- Tokens use HTTP/SSE and fires use WebSocket; the UI shows no alignment.
- Playback pause stops only local delivery. Generate may still switch from recording to live, and status must say so.
- Rejected alternatives: real 3D coordinates (separate data work needing body-ID/coordinate export; glomerulus and MBON nodes have no single-neuron position), mirrored bilateral circuit (duplicates nodes and makes picking ambiguous), decorative point cloud (looks like data).
- #41 can enable timeline/session UI. #42, read-only memory/dopamine telemetry dependent on #41, could later feed right-rail plots. Neither is in scope.

## 9. Baseline evidence and verification

**Observed baseline before redesign (2026-10-21).**
- At 1586×992, the document was 2642px tall before loading a file; header and source controls precede the graph. The real capture loaded 1,958 nodes, 19,037 edges, last step 10, 11 accepted fires and zero dropped messages or undeclared pairs. Node 0 showed Glomerulus, body ID not exported, out-degree 167 across 17 pages, and steps 0–10.
- At 390×844, the document was 4955px tall with no horizontal overflow; the static-mode 404 notice and Retry Health were visible.
- The browser reported "No WebGPU adapter is available", so graph rendering was not observed. Rendering gates need a hardware-WebGPU browser.

**Current setup.** Use the [owned live workspace](README.md#run-the-live-workspace-real-model--app-server) or the separate [recorded Canvas viewer](../recordings/README.md#review-without-a-model). The original static-page file-picker setup is no longer supported by `/app/`.

| Check | Setup | Expected |
|---|---|---|
| Layout | Node; real capture and fixtures | Phase-1 gate. |
| Brain render | Hardware WebGPU; real capture | Phase-2 gate plus screenshot. |
| Recording | Offline | Play, Pause, Restart and speed work; counters, legend and inspector update. |
| Live prompt | Live | Health ready; streaming; Cancel keeps partial output; Copy and Clear; API-key auth failure and recovery; live fires on the brain. |
| Source switching | Live and offline | Connect, disconnect, open recording, Generate to live; repeated switches clear old activity. |
| Viewports | 1586×992, 1024×768, 390×844, 200% zoom | §5 layouts, no horizontal overflow, screenshots. |
| No WebGPU | Browser without adapter | Actionable status; recording, legend, inspector and prompt still work. |
| Regression | `npm --prefix harness/app test` | Existing suite passes with updated layout tests. |

Do not add screenshot or wording tests.
