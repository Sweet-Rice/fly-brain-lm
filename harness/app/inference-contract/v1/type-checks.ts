import type {
  CompletionEvent, FinishChunk, HealthResponse, InferenceFixture,
  NonStreamingCompletionRequest, StreamingCompletionRequest,
} from './types.js';
import { fixture } from './fixture.js';

// Check that an independent TypeScript consumer can import the declarations and the checked fixture.
const session: InferenceFixture = fixture;
const events: readonly CompletionEvent[] = session.stream.events;
const request: StreamingCompletionRequest = session.request;
void events;
void request;

// Cancellation is a local client state, not a finish_reason acknowledged by the frozen server.
const finish: FinishChunk = {
  id: 'cmpl-check', created: 1700000000, model: 'flybrain-untrained', object: 'text_completion',
  choices: [{ index: 0, text: '', logprobs: null, finish_reason: 'length' }],
};
// @ts-expect-error No cancellation acknowledgment exists on the completion wire.
finish.choices[0].finish_reason = 'cancelled';

// @ts-expect-error Prompt is required; the frontend must not invent a production default prompt.
const missingPrompt: StreamingCompletionRequest = { max_tokens: 8, temperature: 0, top_k: 50, stream: true };
// @ts-expect-error Form control strings must be validated and converted before HTTP submission.
const stringLimit: StreamingCompletionRequest = { ...request, max_tokens: '8' };
// @ts-expect-error Non-streaming responses do not consume SSE requests.
const wrongTransport: NonStreamingCompletionRequest = request;
// @ts-expect-error The service does not currently publish a model-loading health phase.
const fabricatedLoadingState: HealthResponse = { status: 'loading', model: 'flybrain-untrained', note: '' };
void missingPrompt;
void stringLimit;
void wrongTransport;
void fabricatedLoadingState;
