# FlyBrainLM prompt and live brain workspace

The React workspace runs trained `vibe2-tinystories` inference in pure WebGPU WGSL
compute shaders. One recurrent model produces text, graph fires and token-aligned
readout telemetry. `GenerationController` consumes an in-page fetch/SSE transport;
there are no network requests to `/health`, `/v1/*` or `/stream`.

## Local development

### Prerequisites

- Node.js 22+, Git LFS, and a WebGPU-capable Chrome or Edge browser.
- Loopback HTTP or trusted HTTPS. No Python model server or API key.
- Hydrated `public/models/vibe2-tinystories/weights.bin` (123,537,408 bytes).

```console
git lfs install
git lfs pull
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173/`. The header reports download progress, then model
readiness. Missing WebGPU, an unhydrated LFS pointer or missing assets produces an
actionable error; Retry reloads a failed model. Device loss requires a page reload.

### Static deployment

`npm --prefix frontend run build` includes the model assets under `dist/models/`.
Host all of `dist/` on HTTPS; no inference or WebSocket reverse proxy is needed.
`npm --prefix frontend run preview` serves the bundle on loopback port 4173.
For subpath deployments, set Vite's base path; the runtime uses `import.meta.env.BASE_URL`.
Only the visual theme preference is retained in `localStorage`.

### Network HTTPS and WebGPU

WebGPU requires loopback HTTP or trusted HTTPS. A private network or Tailnet IP
over plain HTTP is not a secure context: neither model nor graph can run there.
For private Tailscale HTTPS, enable Serve/HTTPS, then allow the exact device hostname:

```console
FLYBRAIN_ALLOWED_HOSTS=<device>.<tailnet>.ts.net npm --prefix frontend run dev -- --host 0.0.0.0
tailscale serve --bg http://127.0.0.1:5173
```

Open the HTTPS URL reported by Tailscale. `FLYBRAIN_ALLOWED_HOSTS` is an explicit
comma-separated hostname list for development and preview, not a bypass of host checks.
Use private Serve, not public Funnel.

## Architecture and lifecycle

- `src/hooks/useGeneration.ts` owns one `Vibe2Runtime` and one `GenerationController`.
  Runtime status changes trigger in-page health checks; there is no health polling.
  Delayed disposal permits immediate development effect remounts.
- `harness/app/vibe2/` contains the GPT-2 byte BPE tokenizer, sampler, asset loader,
  topology builder, WGSL kernels, GPU scheduler and serialized completion runtime.
- The engine keeps all weights and math float32, uses the tied embedding/output head,
  and resets convolution and memory state per request. Graph step `t` persists across
  requests. Block-0 positive KC code drives graph fires.
- `AtlasWorkspace` subscribes to runtime telemetry and feeds `handle.publish(message)`.
  `mountLiveAtlas` validates protocol messages, owns canvas/inspector/readout DOM and
  exposes `publish`, `fit`, `zoom`, `setGeneration` and `dispose`. It owns no socket.
- Graph fire counters are coalesced per animation frame, not stored per fire in React.
  The readout receives lifecycle and per-token events from the same inference loop.
  The final completion token is intentionally `unprocessed`: no unused model step.
- Settings contain max tokens, temperature and top-K. Greedy decoding uses temperature 0.
  Cancellation preserves partial text and stops further steps after the in-flight GPU work.
- `useTheme` and the model-neutral primitives in `src/components/ui/` are unchanged.

### Assets and parity

`public/models/vibe2-tinystories/weights.bin` is tracked by Git LFS. The manifest,
tokenizer and golden vectors are plain Git files, available to CI without LFS downloads.
Regenerate from a trained checkpoint with:

```console
python -m model.vibe2.export_webgpu --ckpt model/checkpoints/vibe2_tinystories.pt --out frontend/public/models/vibe2-tinystories
```

From the browser console under Vite development, run the dev-only parity entry:

```javascript
await import('/src/model/parity.ts').then((m) =>
  m.runVibe2Parity('/models/vibe2-tinystories/'),
);
```

Require exact tokenizer and 32-token greedy matches, maximum top-logit difference
at most `1e-2`, and any KC mismatch only where the reference top-K margin is below
`1e-4`. The parity engine is independent of the app runtime and is destroyed afterward.

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

`build` type-checks and writes the static production bundle to `frontend/dist/`.
CI checks formatting, lint, types and production build; browser GPU parity is exercised
manually through the dev entry, not claimed as a CI GPU test.

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

- Python exporter/reference tests: 8 passed. Harness tests: 256 passed; inference
  typecheck passed. Frontend format, lint, typecheck and production build passed.
- Browser PyTorch parity: tokenizer failures `[]`, 32/32 greedy tokens matched,
  no block-0 KC mismatches; maximum top-logit difference `0.0069270134`.
  Measured throughput: 22.35 model steps/s on the managed browser's adapter
  (hardware-dependent, including GPU readback; not a throughput guarantee).
- Actual React generation for `Once upon a time`, temperature 0, max tokens 32,
  matched golden text and all token IDs. Atlas: 1,959 nodes / 19,037 edges;
  readout: Live, 32/32, last token unprocessed. Dot-only GPU texture readback
  contained 1,856 colored pixels, including 1,413 bright pixels.
- A 128-token run was cancelled after partial output: Stopped, text retained.
  No browser errors. Header progressed from Loading model 0% to Model ready.
- Network capture of one page load and generation: one weights download, no
  `/health`, `/v1/*` or `/stream` requests. No Python serving process was started.
