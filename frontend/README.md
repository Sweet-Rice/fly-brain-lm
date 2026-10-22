# FlyBrainLM prompt frontend

A focused React/TypeScript prompt workspace for the existing FlyBrainLM HTTP inference API. It is intentionally separate from the WebGPU atlas in `harness/app/`: the prompt frontend owns text generation and shared interface primitives; the harness owns neuron visualization and telemetry inspection.

## Local development

Prerequisites: Node.js 22+ and a FlyBrainLM model service listening on `http://127.0.0.1:8771`. From the repository root:

```console
npm --prefix frontend ci
npm --prefix frontend run dev
```

The second command is the single development command. Open `http://127.0.0.1:5173/`. Vite proxies same-origin `/health` and `/v1/*` requests to the model service, so the browser needs no permissive CORS configuration.

To use another loopback model port, set `FLYBRAIN_API_URL` before starting Vite. Never commit workstation URLs or credentials.

```console
FLYBRAIN_API_URL=http://127.0.0.1:9001 npm --prefix frontend run dev
```

The optional API key in the interface remains in component/controller memory and is not written to browser storage. Only the visual theme preference is stored locally.

## Build and quality commands

```console
npm --prefix frontend run build
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run format:check
npm --prefix frontend run preview
```

`build` type-checks and writes the static production bundle to `frontend/dist/`. `preview` serves that bundle on `http://127.0.0.1:4173/` and uses the same development proxy. The production host must route `/health` and `/v1/*` to the model service. `dist/` and `node_modules/` are generated and ignored.

## Design system

The interface uses a small, dependency-free component layer in `src/components/ui/`:

- `Button`: primary, secondary, quiet, and compact actions.
- `Field`, `Input`, and `Textarea`: labels, hints, errors, and ARIA relationships.
- `Panel`: neutral structural surface with optional heading metadata.
- `Status`: semantic connection and generation states.
- `Tooltip`: focusable-trigger help text linked with `aria-describedby`.

These components contain no inference or model-specific logic. Shared tokens in `src/index.css` define color, spacing, typography, radius, focus, and motion behavior. Controls have visible keyboard focus and at least 44 px touch targets.

The visual direction is a **neural field notebook**, not another chat transcript: a serif writing surface, compact instrument labels, circuit-line details, and a side-by-side stimulus/response bench at laptop and desktop widths. Research references included [minimal-llm-ui](https://github.com/richawo/minimal-llm-ui), [Ollama Chat UI](https://github.com/JithinM/ollama-chat-ui), and [assistant-ui](https://github.com/assistant-ui/assistant-ui). We retain their useful patterns—persistent readiness, prominent composer, progressive settings, streamed output, composable controls—without copying chat bubbles, session sidebars, or their visual systems.

Theme behavior is decided centrally by `useTheme`: first visit follows the operating-system preference, the header control switches light/dark explicitly, and that preference is retained in `localStorage`. Both themes use the same semantic tokens and meet the same focus/layout behavior.

## Architecture

- `src/App.tsx`: FlyBrainLM-specific prompt workflow and page composition.
- `src/hooks/useGeneration.ts`: React adapter around the existing DOM-free `harness/app/generation.js` client. No service client is duplicated.
- `src/hooks/useTheme.ts`: the single theme policy.
- `src/components/ui/`: model-neutral primitives.
- `vite.config.ts`: configurable loopback development/preview proxy.

The React adapter consumes the versioned types in `harness/app/inference-contract/v1/`. Cancellation, stale-run rejection, streaming parsing, safe errors, readiness polling, and run identity therefore remain owned by the already tested `GenerationController`.
