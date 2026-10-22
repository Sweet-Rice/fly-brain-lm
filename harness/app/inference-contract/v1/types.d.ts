/** UI inference contract v1. Separate from the mapping/fire visualization protocol. */
export type InferenceContractVersion = 1;
export type FinishReason = 'length' | 'stop';

/** Only readiness and model label are available; no loading phase or checkpoint identity is exported. */
export interface HealthResponse {
  status: 'ok';
  model: string;
  note: string;
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
