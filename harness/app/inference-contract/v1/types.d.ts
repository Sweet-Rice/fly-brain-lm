/** UI inference contract v1. Separate from the mapping/fire visualization protocol. */
export type InferenceContractVersion = 1;
export type FinishReason = 'length' | 'stop';

/** Readiness and model label; checkpoint identity only when harness.app_server launched the model. */
export interface HealthResponse {
  status: 'ok';
  model: string;
  note: string;
  /** Present only when harness.app_server launched the model (--model-ckpt): file name (never a path) and full sha256. */
  checkpoint?: { name: string; sha256: string };
}

export interface ModelListResponse {
  object: 'list';
  data: readonly {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }[];
}

/** Bounds and integer/finite-number constraints are specified in README.md, not expressible by number. */
export interface CompletionParameters {
  prompt: string;
  max_tokens: number;
  temperature: number;
  top_k: number;
  /** Optional label; the frozen server always uses its already-loaded model. */
  model?: string;
  stop?: string | readonly string[];
}

export interface StreamingCompletionRequest extends CompletionParameters {
  stream: true;
  stream_options?: { include_usage?: boolean };
}

export interface NonStreamingCompletionRequest extends CompletionParameters {
  stream?: false;
}

export type CompletionRequest = StreamingCompletionRequest | NonStreamingCompletionRequest;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionEnvelope {
  /** Server-generated completion id, stable across every frame of this HTTP response. */
  id: string;
  /** Unix epoch seconds, not a visualization step or elapsed duration. */
  created: number;
  model: string;
  object: 'text_completion';
}

export interface TextChunk extends CompletionEnvelope {
  choices: readonly [{ index: 0; text: string; logprobs: null; finish_reason: null }];
}

export interface FinishChunk extends CompletionEnvelope {
  choices: readonly [{ index: 0; text: ''; logprobs: null; finish_reason: FinishReason }];
}

export interface UsageChunk extends CompletionEnvelope {
  choices: readonly [];
  usage: TokenUsage;
}

/** SSE data payloads. [DONE] is literal text, not a JSON string on the wire. */
export type CompletionEvent = TextChunk | FinishChunk | UsageChunk | '[DONE]';

export interface CompletionResponse extends CompletionEnvelope {
  choices: readonly [{ index: 0; text: string; logprobs: null; finish_reason: FinishReason }];
  usage: TokenUsage;
}

/** Known error.type values; clients must also tolerate unfamiliar strings. */
export type KnownErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'service_unavailable'
  | 'model_loading'
  | 'model_exited'
  | 'timeout_error'
  | 'upstream_error';

export interface ErrorResponse {
  error: {
    type: string;
    /** Diagnostic input; render a safe user message rather than exposing traces or local paths. */
    message: string;
  };
}

/** Client state, not additional backend messages. Cancellation has no server acknowledgment. */
export type GenerationState =
  | 'idle'
  | 'validating'
  | 'submitting'
  | 'streaming'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Stable projection of GenerationController.getState(); local runId is not a server completion id. */
export interface GenerationSnapshot {
  state: GenerationState;
  runId: string | null;
  modelCompletionId: string | null;
  text: string;
  finishReason: FinishReason | null;
  usage: TokenUsage | null;
}

/** Form values accepted by the plain-JS service client before runtime validation. */
export interface GenerationInput {
  prompt?: string;
  maxTokens?: string | number | null;
  max_tokens?: string | number | null;
  temperature?: string | number | null;
  topK?: string | number | null;
  top_k?: string | number | null;
}

export interface ValidationErrors {
  prompt?: string;
  maxTokens?: string;
  temperature?: string;
  topK?: string;
}

export interface HealthSnapshot {
  status: 'unknown' | 'checking' | 'loading' | 'ready' | 'error';
  modelId: string | null;
  note: string | null;
  message: string;
  ready: boolean;
  checkpoint: { name: string; sha256: string } | null;
}

export interface GenerationClientSnapshot extends GenerationSnapshot {
  error: string | null;
  validationErrors: ValidationErrors;
  health: HealthSnapshot;
}

export interface GenerationClientOptions {
  /** Relative same-origin paths by default; configure the proxy upstream with --api-url. */
  endpoint?: string;
  healthEndpoint?: string;
  fetch?: typeof globalThis.fetch;
  apiKey?: string | null;
}

export interface GenerationStart {
  prompt: string;
  maxTokens: number;
  temperature: number;
  topK: number;
  runId: string;
}

export interface GenerationSubmitOptions {
  onGenerate?: ((request: GenerationStart) => void | Promise<void>) | null;
}

export type GenerationResult =
  | { success: true; text: string; runId: string; usage: TokenUsage | null; finishReason: FinishReason | null }
  | { success: false; errors: ValidationErrors }
  | { success: false; cancelled: true; text?: string }
  | { success: false; aborted: true }
  | { success: false; error: string; text?: string };

/** Development/test-only session fixture. Never selected as a production model fallback. */
export interface InferenceFixture {
  contract_version: InferenceContractVersion;
  health: HealthResponse;
  models: ModelListResponse;
  request: StreamingCompletionRequest;
  stream: {
    status: 200;
    content_type: 'text/event-stream';
    events: readonly CompletionEvent[];
  };
  expected: {
    text: string;
    finish_reason: FinishReason;
    usage: TokenUsage;
    completion_id: string;
  };
  errors: readonly {
    status: number;
    body: ErrorResponse;
  }[];
}
