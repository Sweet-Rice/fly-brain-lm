import type {
  CompletionEvent, FinishChunk, HealthResponse, InferenceFixture,
  NonStreamingCompletionRequest, StreamingCompletionRequest,
  GenerationClientSnapshot, GenerationResult, GenerationState,
} from './types.js';
import { fixture } from './fixture.js';
import { GenerationController, SSELineParser } from '../../generation.js';

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

// Check the real no-build JS implementation, not a separately maintained controller declaration.
async function consumeClient(client: GenerationController) {
  const snapshot: GenerationClientSnapshot = client.getState();
  const state: GenerationState = snapshot.state;
  const ready: boolean = (await client.checkHealth()).ready;
  const result: GenerationResult = await client.submit(fixture.request, {
    onGenerate: async start => {
      const numericLimit: number = start.maxTokens;
      const localRunId: string = start.runId;
      void numericLimit;
      void localRunId;
    },
  });
  if (result.success) {
    const output: string = result.text;
    void output;
  }
  client.subscribe(current => {
    const serverId: string | null = current.modelCompletionId;
    void serverId;
  });
  // @ts-expect-error Completion inputs do not accept chat message arrays as prompts.
  client.submit({ ...fixture.request, prompt: ['not text'] });
  // @ts-expect-error Unexported checkpoint identities must not be invented by consumers.
  snapshot.health.checkpoint_digest;
  // @ts-expect-error Poll cadence is numeric, not an unchecked input string.
  client.startHealthPolling({ intervalMs: '1000' });
  void state;
  void ready;
}
const parser = new SSELineParser({ onEvent: data => { const text: string = data; void text; } });
parser.feed(new Uint8Array([100, 97, 116, 97]));
// @ts-expect-error SSE input consists of text or encoded bytes, not scalar numbers.
parser.feed(7);
void consumeClient;
