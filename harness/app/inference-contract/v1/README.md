# UI inference contract v1

This is the versioned frontend contract for the existing `model.serve.serve` HTTP API through `harness.app_server`. It does not change either backend. The TypeScript declarations in [`types.d.ts`](types.d.ts) are the consumable request/response types; [`fixture.js`](fixture.js) is deterministic **development/test data**, not a captured model run or a production fallback.

This version is a source-level compatibility contract. The current server does not negotiate a contract version or return a version header. `/v1/completions` is an OpenAI-compatible route, not the mapping/fire visualization protocol. HTTP inference uses JSON booleans, nulls, and floating-point sampling parameters normally; the visualization protocol's integer/string-only restriction does not apply here.

## Transport and endpoints

| Operation | Request | Successful response type |
|---|---|---|
| Readiness | `GET /health` | `HealthResponse` |
| Loaded model label | `GET /v1/models` | `ModelListResponse` |
| Stream a prompt | `POST /v1/completions`, `StreamingCompletionRequest` | SSE `CompletionEvent` payloads |
| Complete without streaming | `POST /v1/completions`, `NonStreamingCompletionRequest` | `CompletionResponse` |

Requests use `Content-Type: application/json`. A configured API key is sent as `Authorization: Bearer <key>` on both health and completion requests. The browser keeps the key in memory only. Keys, prompt content, and credentials do not belong in fixtures or committed configuration.

`HealthResponse.status = "ok"` means the loaded service is ready. The service exposes a model label and note, but **no checkpoint digest, implementation identity, loading phase, queue position, or training state**. A model-loading process that has not opened its HTTP listener is indistinguishable from a stopped service. The proxy reports unavailability; the UI must not fabricate a `loading` response or known checkpoint revision.

The workspace consumes text completions only. The proxy also forwards `/v1/chat/completions`, but its chat-delta format is not part of this client contract and is not an interchangeable input to `GenerationController`.

## Request validation and settings

The frontend validates these bounds before sending a request:

| Field | Type | Frontend constraint |
|---|---|---|
| `prompt` | string | Must contain non-whitespace text; preserve the original text when sending. |
| `max_tokens` | integer | 1 through 128. |
| `temperature` | finite number | 0 through 2; zero selects greedy sampling. |
| `top_k` | integer | 1 through 50257. |
| `stream` | boolean | `true` for SSE, omitted/`false` for a JSON completion. |
| `stream_options.include_usage` | boolean, optional | Request a final usage payload when `true`. |
| `stop` | string or array of strings, optional | Supported by the service; not currently exposed by the prompt controls. |
| `model` | string, optional | Label only: the frozen server uses its already-loaded model and does not switch checkpoints. |

The typed frontend request supplies all four generation parameters explicitly. The backend independently coerces/clamps token limits against its configured cap and truncates prompts to its accepted context. Frontend validation is not a claim that the frozen backend rejects every out-of-range setting. New settings must not appear in controls until the service supports them.

## SSE ordering, text, and identity

A successful streaming response is HTTP 200, `Content-Type: text/event-stream`, with `Cache-Control: no-cache`. Each event is `data: <payload>` followed by a blank line. A response has this order:

1. Zero or more `TextChunk` JSON payloads: one choice at index zero, decoded text, null `logprobs`, and null `finish_reason`.
2. One `FinishChunk`: empty text and `finish_reason` equal to `length` or `stop`.
3. One `UsageChunk` if usage was requested: empty `choices` and integer prompt/completion/total counts.
4. Literal `data: [DONE]` followed by a blank line. `[DONE]` is not JSON and is not quoted on the wire.

Every JSON completion payload has the same server-generated `id`, model label, `object: "text_completion"`, and `created` timestamp (Unix seconds). The local `GenerationController` also assigns a stable `runId` for stale-callback rejection. That **local run id is not sent to the backend and is not the server completion id**. No request-to-visualization correlation is implied; authoritative token/run telemetry is tracked in #41.

SSE events and transport chunks are not token boundaries. Preserve whitespace; decode UTF-8 incrementally across byte boundaries; concatenate only `choices[].text`, not usage or finish metadata. Usage counts come from the server and may include an end-of-text token that is not displayed. A connection ending before `[DONE]` is a failed/truncated stream, not successful completion. Preserve already received text on failure.

Client states are `idle`, `validating`, `submitting`, `streaming`, `cancelling`, `completed`, `cancelled`, and `failed`. Only the active local run can update the UI. Do not retry a generation automatically after an ambiguous transport failure: the server may still be executing it. A deliberate new submission creates a new local run and receives a new server completion id.

## Cancellation

Cancel is a client action, not a new HTTP endpoint or SSE event:

- Abort the active fetch with `AbortController`, stop accepting old-run callbacks, and preserve partial text.
- The proxy detects the downstream disconnect and closes the upstream HTTP connection.
- The frozen model server notices the disconnect on its next socket write, closes its generator, and releases its single-generation lock.
- An in-progress compute step is not interrupted. Cancellation is **next-write best effort**, with no authoritative backend acknowledgment or `finish_reason: "cancelled"`.
- A local `cancelled` state does not promise that all upstream work stopped at the instant the button was pressed. Do not silently retry the aborted request.

## Errors and safe presentation

HTTP failures use `ErrorResponse` where available. The stable classification is the HTTP status plus `error.type`; the current API has no separate `error.code` field.

| Status | Known `error.type` | Meaning / safe UI action |
|---|---|---|
| 400 | `invalid_request_error` | Invalid JSON or request fields; correct the request. Frontend validation errors should remain local and field-specific. |
| 401 | `authentication_error` | Authentication rejected; update the in-memory key and retry readiness. |
| 405 | `invalid_request_error` | Wrong HTTP method; check the client endpoint/method configuration. |
| 411 | `invalid_request_error` | Missing request-body length; browser `fetch` supplies this automatically for the JSON request. |
| 413 | `invalid_request_error` | Proxy request-body limit exceeded; shorten the request. |
| 503 | `service_unavailable` | Model service unreachable or communication failed. It may be stopped or still loading; retry readiness, not generation automatically. |
| 504 | `timeout_error` | Upstream response timed out; check the service before submitting a new run. |
| 5xx | `upstream_error`, another type, or no usable body | Runtime/service failure. Retain partial output and present generic recovery guidance. |

An exception after SSE headers may simply truncate the stream; structured runtime error payloads are not guaranteed by the frozen server. Malformed JSON events and missing `[DONE]` are client stream errors. Unknown status/type combinations receive a generic error; never interpret them as success or model output. Error messages are diagnostic input: do not expose traces, HTML, local paths, credentials, or raw request data in user-facing messages.

## Browser origins and configuration

Use the same-origin proxy instead of adding permissive CORS to frozen serving code:

```console
python -m harness.app_server --port 8772 --api-url http://127.0.0.1:8771
```

Open `http://127.0.0.1:8772/app/`. The browser calls relative `/health` and `/v1/completions` routes; the proxy forwards to its fixed loopback upstream. Configure the upstream with `--api-url`, not a committed workstation URL or key. The proxy intentionally emits no CORS permission headers. A different-port origin is a different browser origin.

Static `python -m http.server` still supports recording/graph inspection but does not proxy inference. A 404/405/501 for inference routes in that mode should guide the contributor to `harness.app_server`, not select a fake model fallback.

## Consume and verify

TypeScript consumers import the declarations with a type-only import, for example from a module next to `generation.js`:

```typescript
import type { StreamingCompletionRequest, CompletionEvent } from './inference-contract/v1/types.js';
```

Tests can import the checked session fixture directly as an ES module. It covers a successful multi-chunk Unicode stream, stable server identity, terminal/usage ordering, and representative structured HTTP errors. It contains intentionally authored data and is never imported by the running workspace.

The browser application remains plain JavaScript with no build step. Runtime tests still work without npm installation. The TypeScript dependency is development-only, pinned in the app's lockfile:

```console
npm --prefix harness/app test
npm --prefix harness/app ci --ignore-scripts
npm --prefix harness/app run typecheck
```

Type checking validates the declarations, fixture, and positive/negative consumer examples. CI runs both runtime tests and contract checks. Backend implementation, model/training internals, graph topology, recurrent-memory telemetry, and dashboard design are outside this contract.

Additive optional fields remain compatible with this version. Removing or changing a field's type or meaning requires a new contract version and coordinated client migration; do not silently reinterpret v1 events.
