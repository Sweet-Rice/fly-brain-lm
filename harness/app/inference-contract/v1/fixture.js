// Development and tests only. The running UI never imports this recording or substitutes it for a model.
/** @satisfies {import('./types.js').InferenceFixture} */
export const fixture = {
  contract_version: 1,
  health: { status: 'ok', model: 'flybrain-untrained', note: 'TEMPORARY, untrained' },
  models: {
    object: 'list',
    data: [{ id: 'flybrain-untrained', object: 'model', created: 0, owned_by: 'flybrainlm' }],
  },
  request: {
    prompt: 'Continue this story about a fly.',
    max_tokens: 8,
    temperature: 0,
    top_k: 50,
    stream: true,
    stream_options: { include_usage: true },
  },
  stream: {
    status: 200,
    content_type: 'text/event-stream',
    events: [
      {
        id: 'cmpl-000000000000000000000001', created: 1700000000,
        model: 'flybrain-untrained', object: 'text_completion',
        choices: [{ index: 0, text: 'A fly\n', logprobs: null, finish_reason: null }],
      },
      {
        id: 'cmpl-000000000000000000000001', created: 1700000000,
        model: 'flybrain-untrained', object: 'text_completion',
        choices: [{ index: 0, text: 'visits a café.', logprobs: null, finish_reason: null }],
      },
      {
        id: 'cmpl-000000000000000000000001', created: 1700000000,
        model: 'flybrain-untrained', object: 'text_completion',
        choices: [{ index: 0, text: '', logprobs: null, finish_reason: 'length' }],
      },
      {
        id: 'cmpl-000000000000000000000001', created: 1700000000,
        model: 'flybrain-untrained', object: 'text_completion',
        choices: [], usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 },
      },
      '[DONE]',
    ],
  },
  expected: {
    text: 'A fly\nvisits a café.',
    finish_reason: 'length',
    usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 },
    completion_id: 'cmpl-000000000000000000000001',
  },
  errors: [
    { status: 400, body: { error: { type: 'invalid_request_error', message: "'prompt' must be a string" } } },
    { status: 401, body: { error: { type: 'authentication_error', message: 'bad API key' } } },
    { status: 503, body: { error: { type: 'service_unavailable', message: 'Upstream model server unavailable' } } },
    { status: 504, body: { error: { type: 'timeout_error', message: 'Upstream model server timed out' } } },
  ],
};
