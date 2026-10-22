import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationController,
  GENERATION_STATES,
  validateParams,
  SSELineParser,
} from '../generation.js';
import { fixture } from '../inference-contract/v1/fixture.js';

function createMockReadableStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const item = chunks[index++];
        controller.enqueue(typeof item === 'string' ? new TextEncoder().encode(item) : item);
      } else {
        controller.close();
      }
    },
  });
}

test('validateParams correctly identifies valid parameters and boundary values', () => {
  // Typical valid case
  const valid = validateParams({
    prompt: 'Tell me about flies',
    maxTokens: 64,
    temperature: 1.0,
    topK: 50,
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, {});

  // Boundary maxTokens (1 and 128)
  assert.equal(validateParams({ prompt: 'p', maxTokens: 1, temperature: 0, topK: 1 }).valid, true);
  assert.equal(validateParams({ prompt: 'p', maxTokens: 128, temperature: 2.0, topK: 50257 }).valid, true);

  // snake_case support
  assert.equal(validateParams({ prompt: 'p', max_tokens: 32, temperature: 0.5, top_k: 40 }).valid, true);
});

test('validateParams produces specific inline errors for invalid parameters', () => {
  // Blank prompt
  const blank1 = validateParams({ prompt: '', maxTokens: 64, temperature: 1.0, topK: 50 });
  assert.equal(blank1.valid, false);
  assert.ok(blank1.errors.prompt);

  const blank2 = validateParams({ prompt: '   \n  \t  ', maxTokens: 64, temperature: 1.0, topK: 50 });
  assert.equal(blank2.valid, false);
  assert.ok(blank2.errors.prompt);

  // Invalid max_tokens
  const badMaxTokens = [0, -1, 129, 10.5, NaN, 'abc', ''];
  for (const val of badMaxTokens) {
    const res = validateParams({ prompt: 'valid', maxTokens: val, temperature: 1.0, topK: 50 });
    assert.equal(res.valid, false, `maxTokens ${val} should be invalid`);
    assert.ok(res.errors.maxTokens);
  }

  // Invalid temperature
  const badTemp = [-0.1, 2.1, NaN, Infinity, -Infinity, 'xyz', ''];
  for (const val of badTemp) {
    const res = validateParams({ prompt: 'valid', maxTokens: 64, temperature: val, topK: 50 });
    assert.equal(res.valid, false, `temperature ${val} should be invalid`);
    assert.ok(res.errors.temperature);
  }

  // Invalid top_k
  const badTopK = [0, -5, 50258, 20.4, NaN, 'xyz', ''];
  for (const val of badTopK) {
    const res = validateParams({ prompt: 'valid', maxTokens: 64, temperature: 1.0, topK: val });
    assert.equal(res.valid, false, `topK ${val} should be invalid`);
    assert.ok(res.errors.topK);
  }
});

test('SSELineParser handles fragmented byte chunks across arbitrary boundaries', () => {
  const events = [];
  const parser = new SSELineParser({ onEvent: e => events.push(e) });

  const chunk1 = 'data: {"id":"cm';
  const chunk2 = 'pl-1","choices":[{"text":"Hello';
  const chunk3 = ' "}]}\n';
  const chunk4 = '\ndata: {"id":"cmpl-1","choices":[{"text":"world"}]}\n\n';

  parser.feed(chunk1, false);
  assert.equal(events.length, 0);

  parser.feed(chunk2, false);
  assert.equal(events.length, 0);

  parser.feed(chunk3, false);
  assert.equal(events.length, 0);

  parser.feed(chunk4, false);
  assert.equal(events.length, 2);
  assert.deepEqual(JSON.parse(events[0]), { id: 'cmpl-1', choices: [{ text: 'Hello ' }] });
  assert.deepEqual(JSON.parse(events[1]), { id: 'cmpl-1', choices: [{ text: 'world' }] });
});

test('SSELineParser decodes multibyte UTF-8 characters split across chunk boundaries', () => {
  const events = [];
  const parser = new SSELineParser({ onEvent: e => events.push(e) });

  // "🧠" is 4 bytes: 0xF0 0x9F 0xA7 0xA0
  // "Привет" has 2-byte Cyrillic characters
  const brainEmoji = '🧠';
  const encoder = new TextEncoder();
  const fullBytes = encoder.encode(`data: {"text":"${brainEmoji}"}\n\n`);

  // Split right in the middle of the 4-byte emoji
  const splitPoint = fullBytes.indexOf(0xF0) + 2;
  const part1 = fullBytes.slice(0, splitPoint);
  const part2 = fullBytes.slice(splitPoint);

  parser.feed(part1, false);
  assert.equal(events.length, 0);

  parser.feed(part2, true);
  assert.equal(events.length, 1);
  const parsed = JSON.parse(events[0]);
  assert.equal(parsed.text, '🧠');
  assert.ok(!parsed.text.includes('\uFFFD'), 'Should not contain replacement character');
});

test('SSELineParser handles CRLF line endings and SSE comments', () => {
  const events = [];
  const parser = new SSELineParser({ onEvent: e => events.push(e) });

  // Stream with CRLF and comment lines
  const data = ': keepalive comment\r\ndata: {"text":"one"}\r\n\r\n: second comment\r\ndata: {"text":"two"}\r\n\r\n';
  parser.feed(data, true);

  assert.equal(events.length, 2);
  assert.equal(JSON.parse(events[0]).text, 'one');
  assert.equal(JSON.parse(events[1]).text, 'two');
});

test('versioned inference fixture preserves text, identity, usage and terminal state across byte boundaries', async () => {
  const wire = fixture.stream.events.map(event =>
    `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(wire);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 3) chunks.push(bytes.slice(offset, offset + 3));

  const controller = new GenerationController({
    fetch: async url => url === '/health'
      ? new Response(JSON.stringify(fixture.health), { status: 200 })
      : new Response(createMockReadableStream(chunks), {
        status: fixture.stream.status, headers: { 'Content-Type': fixture.stream.content_type },
      }),
  });
  const snapshots = [];
  controller.subscribe(snapshot => snapshots.push(snapshot));
  try {
    await controller.checkHealth();
    assert.equal(controller.getState().health.ready, true);
    const result = await controller.submit(fixture.request);

    assert.equal(result.success, true);
    assert.equal(result.text, fixture.expected.text);
    assert.equal(result.finishReason, fixture.expected.finish_reason);
    assert.deepEqual(result.usage, fixture.expected.usage);
    const final = controller.getState();
    assert.equal(final.state, GENERATION_STATES.COMPLETED);
    assert.equal(final.modelCompletionId, fixture.expected.completion_id);
    assert.equal(final.runId, result.runId);
    assert.ok(snapshots.some(snapshot => snapshot.text === 'A fly\n'));
    assert.ok(snapshots.some(snapshot => snapshot.state === GENERATION_STATES.SUBMITTING));
    assert.ok(snapshots.some(snapshot => snapshot.state === GENERATION_STATES.STREAMING));
    assert.ok(snapshots.filter(snapshot => snapshot.runId).every(snapshot => snapshot.runId === result.runId));
  } finally {
    controller.dispose();
  }
});

test('GenerationController rejects duplicate submit when already active', async () => {
  let streamController;
  const hangingStream = new ReadableStream({
    start(c) {
      streamController = c;
    },
  });

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: hangingStream,
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const firstPromise = controller.submit({ prompt: 'Run 1', maxTokens: 10, temperature: 1.0, topK: 50 });

  // Wait a microtask for submit to become active
  await new Promise(r => setImmediate(r));
  assert.equal(controller.isActive(), true);

  // Attempt second submit while active
  await assert.rejects(
    async () => {
      await controller.submit({ prompt: 'Run 2', maxTokens: 10, temperature: 1.0, topK: 50 });
    },
    Error
  );

  // Clean up hanging stream
  streamController.close();
  await firstPromise.catch(() => {});
});

test('cancellation survives a late preparation rejection without becoming failure', async () => {
  let rejectPreparation;
  const preparation = new Promise((resolve, reject) => { rejectPreparation = reject; });
  let requests = 0;
  const controller = new GenerationController({
    fetch: async () => { requests++; return new Response(''); },
  });
  try {
    const pending = controller.submit(fixture.request, { onGenerate: () => preparation });
    controller.cancel();
    rejectPreparation(new Error('Preparation failed after cancellation'));
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(controller.getState().state, GENERATION_STATES.CANCELLED);
    assert.equal(controller.getState().error, null);
    assert.equal(requests, 0);
  } finally {
    controller.dispose();
  }
});

test('disposal from a validation subscriber cannot revive the run or start a request', async () => {
  let requests = 0;
  const controller = new GenerationController({
    fetch: async () => {
      requests++;
      return new Response(createMockReadableStream(['data: [DONE]\n\n']));
    },
  });
  controller.subscribe(snapshot => {
    if (snapshot.state === GENERATION_STATES.VALIDATING) controller.dispose();
  });
  const result = await controller.submit(fixture.request);
  assert.equal(result.cancelled, true);
  assert.equal(controller.getState().state, GENERATION_STATES.CANCELLED);
  assert.equal(requests, 0);
});

test('a replacement run started by a validation subscriber owns the final state', async () => {
  const prompts = [];
  const controller = new GenerationController({
    fetch: async (url, options) => {
      const prompt = JSON.parse(options.body).prompt;
      prompts.push(prompt);
      return new Response(createMockReadableStream([
        `data: ${JSON.stringify({ choices: [{ text: prompt }] })}\n\n`,
        'data: [DONE]\n\n',
      ]));
    },
  });
  let replacement;
  let replaced = false;
  controller.subscribe(snapshot => {
    if (!replaced && snapshot.state === GENERATION_STATES.VALIDATING) {
      replaced = true;
      controller.cancel();
      replacement = controller.submit({ ...fixture.request, prompt: 'Replacement' });
    }
  });
  try {
    const original = await controller.submit({ ...fixture.request, prompt: 'Original' });
    const current = await replacement;
    assert.equal(original.aborted, true);
    assert.equal(current.success, true);
    assert.deepEqual(prompts, ['Replacement']);
    assert.equal(controller.getState().text, 'Replacement');
    assert.equal(controller.getState().state, GENERATION_STATES.COMPLETED);
  } finally {
    controller.dispose();
  }
});

test('later subscribers retain the current state after an earlier subscriber replaces the attempt', async () => {
  const controller = new GenerationController();
  let replaced = false;
  let replacement;
  let latest;
  controller.subscribe(snapshot => {
    if (!replaced && snapshot.state === GENERATION_STATES.VALIDATING) {
      replaced = true;
      controller.cancel();
      replacement = controller.submit({ ...fixture.request, prompt: '   ' });
    }
  });
  controller.subscribe(snapshot => { latest = snapshot; });
  try {
    const original = await controller.submit(fixture.request);
    const invalid = await replacement;
    assert.equal(original.aborted, true);
    assert.equal(latest.state, GENERATION_STATES.FAILED);
    assert.equal(latest.state, controller.getState().state);
    assert.deepEqual(latest.validationErrors, invalid.errors);
  } finally {
    controller.dispose();
  }
});

test('validation failure cannot be overwritten when an older cancelled request settles', async () => {
  let rejectRequest;
  const request = new Promise((resolve, reject) => { rejectRequest = reject; });
  const controller = new GenerationController({ fetch: () => request });
  try {
    const pending = controller.submit(fixture.request);
    controller.cancel();
    const invalid = await controller.submit({ ...fixture.request, prompt: '   ' });
    assert.equal(invalid.success, false);
    const validationErrors = controller.getState().validationErrors;
    assert.ok(validationErrors.prompt);
    rejectRequest(new DOMException('Cancelled', 'AbortError'));
    const oldResult = await pending;
    assert.equal(controller.getState().state, GENERATION_STATES.FAILED);
    assert.deepEqual(controller.getState().validationErrors, validationErrors);
    assert.equal(oldResult.aborted, true);
  } finally {
    controller.dispose();
  }
});

test('completion returns its own result when a terminal subscriber starts the next run', async () => {
  const controller = new GenerationController({
    fetch: async (url, options) => {
      const prompt = JSON.parse(options.body).prompt;
      return new Response(createMockReadableStream([
        `data: ${JSON.stringify({ choices: [{ text: prompt, finish_reason: 'length' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
        'data: [DONE]\n\n',
      ]));
    },
  });
  let completed;
  let replacement;
  controller.subscribe(snapshot => {
    if (!completed && snapshot.state === GENERATION_STATES.COMPLETED) {
      completed = snapshot;
      replacement = controller.submit({ ...fixture.request, prompt: 'Replacement' });
    }
  });
  try {
    const original = await controller.submit({ ...fixture.request, prompt: 'Original' });
    const current = await replacement;
    assert.equal(original.success, true);
    assert.equal(original.text, completed.text);
    assert.equal(original.runId, completed.runId);
    assert.equal(original.finishReason, completed.finishReason);
    assert.deepEqual(original.usage, completed.usage);
    assert.notEqual(original.runId, current.runId);
    assert.equal(controller.getState().runId, current.runId);
  } finally {
    controller.dispose();
  }
});

for (const scenario of [
  { name: 'preparation', onGenerate: () => { throw new Error('Preparation failed'); } },
  { name: 'network', failRequest: async () => { throw new TypeError('Failed to fetch'); } },
  {
    name: 'HTTP',
    failRequest: async () => new Response(JSON.stringify({ error: { message: 'Service unavailable' } }), { status: 503 }),
  },
  {
    name: 'stream',
    failRequest: async () => new Response(createMockReadableStream([
      'data: {"choices":[{"text":"Partial original"}]}\n\n',
      'data: not-json\n\n',
    ])),
  },
]) {
  test(`${scenario.name} failure returns its own error when a terminal subscriber starts the next run`, async () => {
    const controller = new GenerationController({
      fetch: async (url, options) => {
        if (JSON.parse(options.body).prompt === 'Original') return scenario.failRequest();
        return new Response(createMockReadableStream(['data: [DONE]\n\n']));
      },
    });
    let failed;
    let replacement;
    controller.subscribe(snapshot => {
      if (!failed && snapshot.state === GENERATION_STATES.FAILED) {
        failed = snapshot;
        replacement = controller.submit({ ...fixture.request, prompt: 'Replacement' });
      }
    });
    try {
      const original = await controller.submit(
        { ...fixture.request, prompt: 'Original' },
        { onGenerate: scenario.onGenerate || null },
      );
      const current = await replacement;
      assert.equal(original.success, false);
      assert.equal(typeof original.error, 'string');
      assert.equal(original.error, failed.error);
      if (scenario.name === 'stream') assert.equal(original.text, failed.text);
      assert.equal(current.success, true);
      assert.equal(controller.getState().runId, current.runId);
    } finally {
      controller.dispose();
    }
  });
}

test('a disposed controller cannot start another generation', async () => {
  let requests = 0;
  const controller = new GenerationController({
    fetch: async () => {
      requests++;
      return new Response(createMockReadableStream(['data: [DONE]\n\n']));
    },
  });
  controller.dispose();
  await assert.rejects(controller.submit(fixture.request), Error);
  assert.throws(() => controller.startHealthPolling(), Error);
  assert.equal(controller.getState().state, GENERATION_STATES.IDLE);
  assert.equal(requests, 0);
});

test('GenerationController preserves partial text on user cancellation', async () => {
  let streamController;
  const stream = new ReadableStream({
    start(c) {
      streamController = c;
    },
  });

  const mockFetch = async (url, options) => ({
    ok: true,
    status: 200,
    body: stream,
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const submitPromise = controller.submit({ prompt: 'Cancel test', maxTokens: 64, temperature: 1.0, topK: 50 });

  await new Promise(r => setImmediate(r));

  // Push partial text
  streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Partial output "}]}\n\n'));
  await new Promise(r => setImmediate(r));

  assert.equal(controller.getState().text, 'Partial output ');

  // Cancel generation
  controller.cancel();

  const result = await submitPromise;
  assert.equal(result.cancelled, true);
  assert.equal(result.text, 'Partial output ');

  const state = controller.getState();
  assert.equal(state.state, GENERATION_STATES.CANCELLED);
  assert.equal(state.text, 'Partial output ');
});

test('GenerationController rejects truncated stream before [DONE] while preserving partial text', async () => {
  // Stream ends prematurely without [DONE]
  const chunks = [
    'data: {"choices":[{"text":"Partially generated text"}]}\n\n',
  ];

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: createMockReadableStream(chunks),
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const result = await controller.submit({ prompt: 'Truncation test', maxTokens: 64, temperature: 1.0, topK: 50 });

  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.equal(result.text, 'Partially generated text');

  const state = controller.getState();
  assert.equal(state.state, GENERATION_STATES.FAILED);
  assert.equal(state.text, 'Partially generated text');
});

test('GenerationController cancels reader immediately on parse error preceding EOF and preserves partial text', async () => {
  let cancelCalled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Good piece"}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"secret_prompt_leak" bad_json\n\n'));
      // Deliberately no EOF (controller.close is not called)
    },
    cancel() {
      cancelCalled = true;
    },
  });

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const result = await controller.submit({ prompt: 'Malformed test', maxTokens: 64, temperature: 1.0, topK: 50 });

  assert.equal(result.success, false);
  assert.equal(cancelCalled, true, 'reader.cancel() must be called on parse error without waiting for EOF');
  assert.ok(result.error);
  assert.ok(!result.error.includes('secret_prompt_leak'), 'Raw syntax excerpt or payload text must not leak');
  assert.equal(result.text, 'Good piece');

  const state = controller.getState();
  assert.equal(state.state, GENERATION_STATES.FAILED);
  assert.equal(state.text, 'Good piece');
});

test('GenerationController cancels reader immediately on [DONE] preceding upstream EOF', async () => {
  let cancelCalled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"cmpl-1","choices":[{"text":"Hello world"}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      // Upstream never sends EOF; stream remains open
    },
    cancel() {
      cancelCalled = true;
    },
  });

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: stream,
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const result = await controller.submit({ prompt: 'Done test', maxTokens: 64, temperature: 1.0, topK: 50 });

  assert.equal(result.success, true);
  assert.equal(result.text, 'Hello world');
  assert.equal(cancelCalled, true, 'reader.cancel() must be called on [DONE] without waiting for EOF');
  assert.equal(controller.getState().state, GENERATION_STATES.COMPLETED);
});
test('GenerationController handles server-emitted error payload while preserving partial text', async () => {
  const chunks = [
    'data: {"choices":[{"text":"Initial text"}]}\n\n',
    'data: {"error":{"message":"Engine out of memory"}}\n\n',
  ];

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    body: createMockReadableStream(chunks),
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const result = await controller.submit({ prompt: 'Server error test', maxTokens: 64, temperature: 1.0, topK: 50 });

  assert.equal(result.success, false);
  assert.equal(result.error, 'Engine out of memory');
  assert.equal(result.text, 'Initial text');

  const state = controller.getState();
  assert.equal(state.state, GENERATION_STATES.FAILED);
  assert.equal(state.text, 'Initial text');
});

test('GenerationController clear is disallowed when active and resets state when inactive', async () => {
  let streamController;
  const stream = new ReadableStream({
    start(c) {
      streamController = c;
    },
  });

  const controller = new GenerationController({
    fetch: async () => ({ ok: true, status: 200, body: stream }),
  });

  const submitPromise = controller.submit({ prompt: 'Clear test', maxTokens: 10, temperature: 1.0, topK: 50 });
  await new Promise(r => setImmediate(r));

  assert.throws(() => {
    controller.clear();
  }, /Cannot clear while generation is active/);

  controller.cancel();
  await submitPromise;

  assert.equal(controller.getState().state, GENERATION_STATES.CANCELLED);
  controller.clear();

  const resetState = controller.getState();
  assert.equal(resetState.state, GENERATION_STATES.IDLE);
  assert.equal(resetState.text, '');
  assert.equal(resetState.runId, null);
  assert.equal(resetState.error, null);
});

test('GenerationController validates before onGenerate callback and network call', async () => {
  let onGenerateCalled = false;
  let fetchCalled = false;

  const controller = new GenerationController({
    fetch: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, body: createMockReadableStream([]) };
    },
  });

  // Empty prompt should fail validation immediately
  const result = await controller.submit(
    { prompt: '   ', maxTokens: 10, temperature: 1.0, topK: 50 },
    {
      onGenerate: async () => {
        onGenerateCalled = true;
      },
    }
  );

  assert.equal(result.success, false);
  assert.equal(onGenerateCalled, false, 'onGenerate must not be called when validation fails');
  assert.equal(fetchCalled, false, 'Network call must not be made when validation fails');
  assert.equal(controller.getState().state, GENERATION_STATES.FAILED);
  assert.ok(controller.getState().validationErrors.prompt);
});

test('checkHealth provides honest model readiness without fabricated checkpoint metadata', async () => {
  // Case 1: Model server provides model id and note
  const mockFetch1 = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'ok',
      model: 'flybrain-v1',
      note: 'trained checkpoint',
    }),
  });

  const controller1 = new GenerationController({ fetch: mockFetch1 });
  const health1 = await controller1.checkHealth();

  assert.equal(health1.ready, true);
  assert.equal(health1.modelId, 'flybrain-v1');
  assert.equal(health1.note, 'trained checkpoint');
  assert.ok(health1.message);

  // Case 2: Model server provides status ok but omits model and note
  const mockFetch2 = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'ok' }),
  });

  const controller2 = new GenerationController({ fetch: mockFetch2 });
  const health2 = await controller2.checkHealth();

  assert.equal(health2.ready, true);
  // MUST NOT fabricate defaults
  assert.equal(health2.modelId, null);
  assert.equal(health2.note, null);
  assert.ok(health2.message);
});

test('checkHealth is stale-safe and disposal-safe', async () => {
  let resolveFirst;
  let fetchCount = 0;

  const mockFetch = async () => {
    fetchCount++;
    if (fetchCount === 1) {
      return new Promise(resolve => {
        resolveFirst = () => resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', model: 'stale-model' }),
        });
      });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', model: 'fresh-model' }),
    };
  };

  const controller = new GenerationController({ fetch: mockFetch });

  // Start first check (hangs)
  const firstCheckPromise = controller.checkHealth();
  // Trigger second check before first resolves
  const secondHealth = await controller.checkHealth();

  assert.equal(secondHealth.modelId, 'fresh-model');
  assert.equal(controller.getState().health.modelId, 'fresh-model');

  // Now first resolves late: must not overwrite fresh state
  resolveFirst();
  await firstCheckPromise;
  assert.equal(controller.getState().health.modelId, 'fresh-model');

  // Disposal safety: once disposed, in-flight checks do not update health state
  let resolveDisposed;
  const hangingFetch = () => new Promise(resolve => {
    resolveDisposed = () => resolve({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', model: 'never-applied' }),
    });
  });
  const controller3 = new GenerationController({ fetch: hangingFetch });
  const checkPromise3 = controller3.checkHealth();
  controller3.dispose();
  resolveDisposed();
  await checkPromise3;

  assert.notEqual(controller3.getState().health.modelId, 'never-applied');
  assert.equal(controller3.getState().health.ready, false);
});

test('checkHealth provides helpful error for 404 static server mode', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const health = await controller.checkHealth();

  assert.equal(health.ready, false);
  assert.match(health.message, /404/);
  assert.match(health.message, /harness\.app_server/);
});

test('Optional memory-only API key sends Authorization header', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      body: createMockReadableStream(['data: [DONE]\n\n']),
    };
  };

  const controller = new GenerationController({ fetch: mockFetch });

  // Without API key: no Authorization header sent
  await controller.submit({ prompt: 'No auth test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(capturedHeaders['Authorization'], undefined);

  // With API key: sends Bearer Authorization header
  controller.setApiKey('secret-token-123');
  await controller.submit({ prompt: 'Auth test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(capturedHeaders['Authorization'], 'Bearer secret-token-123');
});

test('deterministic deferred-promise regression: cancel A HTTP error body then submit B and resolve A -> B state/output unaffected', async () => {
  let resolveJsonA;
  const jsonPromiseA = new Promise(resolve => {
    resolveJsonA = resolve;
  });

  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.prompt === 'Prompt A') {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: () => jsonPromiseA,
      };
    }
    if (body.prompt === 'Prompt B') {
      return {
        ok: true,
        status: 200,
        body: createMockReadableStream([
          'data: {"choices":[{"text":"Output B"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      };
    }
    throw new Error(`Unexpected prompt: ${body.prompt}`);
  };

  const controller = new GenerationController({ fetch: mockFetch });
  const observedStates = [];
  controller.subscribe(s => observedStates.push(s.state));

  // 1. Submit Run A
  const promiseA = controller.submit({ prompt: 'Prompt A', maxTokens: 10, temperature: 1.0, topK: 50 });
  await new Promise(r => setImmediate(r));

  // Run A is now awaiting response.json()
  // 2. Cancel Run A
  controller.cancel();
  assert.equal(controller.getState().state, GENERATION_STATES.CANCELLED);

  // 3. Submit Run B
  const promiseB = controller.submit({ prompt: 'Prompt B', maxTokens: 10, temperature: 1.0, topK: 50 });

  // 4. Resolve Run A's deferred error json while Run B is in-flight or finishing
  resolveJsonA({ error: { message: 'Run A late error' } });

  const resultA = await promiseA;
  const resultB = await promiseB;

  // Run A result indicates cancellation/aborted and did not throw or return success
  assert.equal(resultA.success, false);
  assert.ok(resultA.cancelled || resultA.aborted);

  // Run B succeeded completely unaffected by Run A's late resolution
  assert.equal(resultB.success, true);
  assert.equal(resultB.text, 'Output B');

  const finalState = controller.getState();
  assert.equal(finalState.state, GENERATION_STATES.COMPLETED);
  assert.equal(finalState.text, 'Output B');
  assert.equal(finalState.error, null);
  // Ensure FAILED was not applied after Run B started
  const bIndex = observedStates.indexOf(GENERATION_STATES.SUBMITTING);
  const statesAfterB = observedStates.slice(bIndex);
  assert.ok(!statesAfterB.includes(GENERATION_STATES.FAILED), 'Run A must not transition controller to FAILED after Run B starts');
});

test('completions use only normalized controller.apiKey and clearing key removes headers', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      body: createMockReadableStream(['data: [DONE]\n\n']),
    };
  };

  const controller = new GenerationController({ fetch: mockFetch });

  // 1. Untrimmed key is normalized and trimmed
  controller.setApiKey('   Bearer secret-token-xyz   ');
  assert.equal(controller.getApiKey(), 'Bearer secret-token-xyz');

  await controller.submit({ prompt: 'Test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(capturedHeaders['Authorization'], 'Bearer Bearer secret-token-xyz');

  // 2. submit() ignores raw params.apiKey and uses controller.apiKey
  controller.setApiKey('canonical-key');
  await controller.submit({ prompt: 'Test', maxTokens: 10, temperature: 1.0, topK: 50, apiKey: 'bypassed-key' });
  assert.equal(capturedHeaders['Authorization'], 'Bearer canonical-key');

  // 3. Clearing key removes Authorization header from both submit and checkHealth
  controller.setApiKey('');
  assert.equal(controller.getApiKey(), null);

  await controller.submit({ prompt: 'Test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(capturedHeaders['Authorization'], undefined);

  let healthHeaders = null;
  const mockHealthFetch = async (url, options) => {
    healthHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    };
  };
  const healthController = new GenerationController({ fetch: mockHealthFetch, apiKey: 'temp-key' });
  healthController.setApiKey('   ');
  assert.equal(healthController.getApiKey(), null);
  await healthController.checkHealth();
  assert.equal(healthHeaders['Authorization'], undefined);
});

test('health polling does not churn message or notifications when status is unchanged', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        model: 'flybrain-v1',
      }),
    };
  };

  const controller = new GenerationController({ fetch: mockFetch });
  const notifications = [];
  controller.subscribe(state => {
    notifications.push({
      status: state.health.status,
      message: state.health.message,
    });
  });

  // Initial check: transitions from unknown -> checking -> ready
  await controller.checkHealth();
  assert.equal(fetchCount, 1);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].status, 'checking');
  assert.equal(notifications[1].status, 'ready');

  // Poll 1: health is unchanged
  await controller.checkHealth();
  assert.equal(fetchCount, 2);
  assert.equal(notifications.length, 2, 'No notification churn when health result is unchanged');

  // Poll 2: health is still unchanged
  await controller.checkHealth();
  assert.equal(fetchCount, 3);
  assert.equal(notifications.length, 2, 'No notification churn on repeated identical health check');

  // Now simulate health status change to error
  controller.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Server Error',
  });
  await controller.checkHealth();
  assert.equal(notifications.length, 3, 'Notifies when health actually changes');
  assert.equal(notifications[2].status, 'error');
});

test('stream reader releases lock on terminal [DONE], mid-stream parse error, and cancellation', async () => {
  // Case 1: [DONE] releases lock
  const stream1 = createMockReadableStream([
    'data: {"choices":[{"text":"Hello"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const controller1 = new GenerationController({
    fetch: async () => ({ ok: true, status: 200, body: stream1 }),
  });
  await controller1.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(stream1.locked, false, 'Stream lock must be released on [DONE]');

  // Case 2: Parse error releases lock
  const stream2 = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Part"}]}\n\n'));
      c.enqueue(new TextEncoder().encode('data: invalid_json\n\n'));
    },
    cancel() {},
  });
  const controller2 = new GenerationController({
    fetch: async () => ({ ok: true, status: 200, body: stream2 }),
  });
  await controller2.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(stream2.locked, false, 'Stream lock must be released on parse error');

  // Case 3: Cancellation releases lock
  const stream3 = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Start"}]}\n\n'));
    },
    cancel() {},
  });
  const controller3 = new GenerationController({
    fetch: async () => ({ ok: true, status: 200, body: stream3 }),
  });
  const submitPromise = controller3.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  await new Promise(r => setImmediate(r));
  controller3.cancel();
  await submitPromise;
  assert.equal(stream3.locked, false, 'Stream lock must be released on user cancellation');
});

test('static 501 and 405 provide actionable proxy guidance and safe errors sanitize tracebacks', async () => {
  // 501 Unsupported method
  const controller501 = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 501,
      statusText: "Unsupported method ('POST')",
    }),
  });
  const res501 = await controller501.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(res501.success, false);
  assert.match(res501.error, /501/);
  assert.match(res501.error, /harness\.app_server/);

  // 405 Method Not Allowed
  const controller405 = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 405,
      statusText: 'Method Not Allowed',
    }),
  });
  const res405 = await controller405.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(res405.success, false);
  assert.match(res405.error, /405/);
  assert.match(res405.error, /harness\.app_server/);

  // 500 with Python traceback in JSON error response is sanitized
  const controller500 = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({
        error: {
          message: 'Traceback (most recent call last):\n  File "serve.py", line 42, in generate\nZeroDivisionError: division by zero',
        },
      }),
    }),
  });
  const res500 = await controller500.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(res500.success, false);
  assert.ok(!res500.error.includes('Traceback'));
  assert.ok(!res500.error.includes('serve.py'));
  assert.match(res500.error, /internal error|Internal Server Error/i);

  // 503 with clean JSON message preserves actionable message
  const controller503 = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({
        error: { message: 'Upstream model server unavailable' },
      }),
    }),
  });
  const res503 = await controller503.submit({ prompt: 'test', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(res503.success, false);
  assert.equal(res503.error, 'Upstream model server unavailable');
});

import { mountPrompt, PROMPT_DOM_IDS } from '../prompt-view.js';

class MockElement extends EventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  appendChild(child) { this.children.push(child); return child; }
  getElementById(id) {
    const search = el => {
      if (el.id === id) return el;
      for (const child of el.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this);
  }
}

class MockDocument {
  createElement(tag) {
    const el = new MockElement(tag);
    el.ownerDocument = this;
    return el;
  }
}


test('mountPrompt announces completions and errors, never every streaming token', async () => {
  const doc = new MockDocument();
  const root = doc.createElement('div');

  const controller = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      body: createMockReadableStream([
        'data: {"choices":[{"text":"tok1"}]}\n\n',
        'data: {"choices":[{"text":"tok2"}]}\n\n',
        'data: {"choices":[{"text":"tok3"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    }),
  });

  const dispose = mountPrompt(root, {
    controller,
    pollHealth: false,
  });

  const announcement = root.getElementById(PROMPT_DOM_IDS.ANNOUNCEMENT);
  const output = root.getElementById(PROMPT_DOM_IDS.OUTPUT);

  // Initial announcement should be empty
  assert.equal(announcement.textContent, '');

  const announcements = [];
  let currentAnnouncement = announcement.textContent;
  Object.defineProperty(announcement, 'textContent', {
    get() {
      return currentAnnouncement;
    },
    set(value) {
      currentAnnouncement = String(value);
      announcements.push(currentAnnouncement);
    },
    configurable: true,
  });

  // Run generation
  await controller.submit({ prompt: 'Test announcement', maxTokens: 10, temperature: 1.0, topK: 50 });

  // Output rendered with all tokens
  assert.equal(output.textContent, 'tok1tok2tok3');

  // Announcement updated on completion, not for each streaming token
  assert.equal(announcements.length, 1);
  assert.ok(!announcements.some(a => a.includes('tok1') || a.includes('tok2') || a.includes('tok3')));
  assert.ok(announcements[0].length > 0);

  // Error announcement test
  const errorController = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      body: createMockReadableStream(['data: {"error":{"message":"Engine overloaded"}}\n\n']),
    }),
  });
  const disposeError = mountPrompt(root, {
    controller: errorController,
    pollHealth: false,
  });
  const errorAnnouncement = root.getElementById(PROMPT_DOM_IDS.ANNOUNCEMENT);
  const errorAnnouncements = [];
  let currentErrorAnnouncement = errorAnnouncement.textContent;
  Object.defineProperty(errorAnnouncement, 'textContent', {
    get() {
      return currentErrorAnnouncement;
    },
    set(value) {
      currentErrorAnnouncement = String(value);
      errorAnnouncements.push(currentErrorAnnouncement);
    },
    configurable: true,
  });

  await errorController.submit({ prompt: 'Test error announcement', maxTokens: 10, temperature: 1.0, topK: 50 });
  assert.equal(errorAnnouncements.length, 1);
  assert.ok(errorAnnouncements[0].length > 0);

  disposeError();
  dispose();
});

test('checkHealth maps model_loading to loading status and message', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    json: async () => ({
      error: {
        type: 'model_loading',
        message: 'The model server is still loading its checkpoint.',
      },
    }),
  });

  const controller = new GenerationController({ fetch: mockFetch });
  const snapshots = [];
  controller.subscribe(state => {
    snapshots.push(state.health);
  });

  const health = await controller.checkHealth();
  assert.ok(snapshots.length >= 2);
  assert.equal(snapshots[0].status, 'checking');
  assert.equal(snapshots[0].message, 'Checking whether the model service is ready…');

  assert.equal(health.status, 'loading');
  assert.equal(health.ready, false);
  assert.equal(health.checkpoint, null);
  assert.equal(
    health.message,
    'Model loading: the model server is loading its checkpoint. This page is ready; Generate unlocks automatically when the model answers.'
  );
});

test('checkHealth maps model_exited and service_unavailable to actionable messages', async () => {
  const controllerExited = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({
        error: {
          type: 'model_exited',
          message: 'The model server process exited with code 1.',
        },
      }),
    }),
  });
  const healthExited = await controllerExited.checkHealth();
  assert.equal(healthExited.status, 'error');
  assert.equal(healthExited.ready, false);
  assert.equal(
    healthExited.message,
    'Model stopped: the model server process exited. Restart python -m harness.app_server to relaunch it.'
  );

  const controllerUnavailable = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({
        error: {
          type: 'service_unavailable',
          message: 'Upstream model server unavailable',
        },
      }),
    }),
  });
  const healthUnavailable = await controllerUnavailable.checkHealth();
  assert.equal(healthUnavailable.status, 'error');
  assert.equal(healthUnavailable.ready, false);
  assert.equal(
    healthUnavailable.message,
    'Model service unavailable: the model server is not running or is still starting. This page is ready; it checks again every 10 seconds, or use Retry Health.'
  );

  const controllerJsonError = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => {
        throw new SyntaxError('bad');
      },
    }),
  });
  const healthJsonError = await controllerJsonError.checkHealth();
  assert.equal(healthJsonError.status, 'error');
  assert.equal(healthJsonError.ready, false);
  assert.match(healthJsonError.message, /503/);
});

test('ready health shows checkpoint identity or not reported', async () => {
  const sha = 'ab'.repeat(32);
  const controllerWithCkpt = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        model: 'flybrain-untrained',
        note: 'TEMPORARY, untrained',
        checkpoint: {
          name: 'scratch.pt',
          sha256: sha,
        },
      }),
    }),
  });
  const health1 = await controllerWithCkpt.checkHealth();
  assert.equal(health1.status, 'ready');
  assert.equal(health1.ready, true);
  assert.deepEqual(health1.checkpoint, { name: 'scratch.pt', sha256: sha });
  assert.equal(
    health1.message,
    'Model ready: flybrain-untrained (TEMPORARY, untrained) · checkpoint scratch.pt sha256:abababababab'
  );

  const controllerNoCkpt = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        model: 'flybrain-untrained',
        note: 'TEMPORARY, untrained',
      }),
    }),
  });
  const health2 = await controllerNoCkpt.checkHealth();
  assert.equal(health2.status, 'ready');
  assert.equal(health2.ready, true);
  assert.equal(health2.checkpoint, null);
  assert.equal(
    health2.message,
    'Model ready: flybrain-untrained (TEMPORARY, untrained) · checkpoint not reported'
  );

  const controllerMalformedCkpt = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        model: 'flybrain-untrained',
        note: 'TEMPORARY, untrained',
        checkpoint: {
          name: 'x.pt',
          sha256: 'nothex',
        },
      }),
    }),
  });
  const health3 = await controllerMalformedCkpt.checkHealth();
  assert.equal(health3.status, 'ready');
  assert.equal(health3.ready, true);
  assert.equal(health3.checkpoint, null);
  assert.equal(
    health3.message,
    'Model ready: flybrain-untrained (TEMPORARY, untrained) · checkpoint not reported'
  );
});

test('sanitizeSafeMessage redacts Windows and POSIX paths, bearer tokens and api keys', async () => {
  const controller = new GenerationController({
    fetch: async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({
        error: {
          message:
            'Load failed for C:\\Users\\tai\\ckpt\\model.pt, /home/tai/ckpt/model.pt and \\\\fileserver\\share\\model.pt; Authorization: Bearer sk-live-abc123; api_key=XYZ987',
        },
      }),
    }),
  });

  const result = await controller.submit({ prompt: 'p', maxTokens: 4, temperature: 1, topK: 50 });
  assert.equal(result.success, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(!result.error.includes('C:\\Users'));
  assert.ok(!result.error.includes('/home/tai'));
  assert.ok(!result.error.includes('fileserver'));
  assert.ok(!result.error.includes('sk-live-abc123'));
  assert.ok(!result.error.includes('XYZ987'));
  assert.ok(result.error.includes('[path]'));
  assert.ok(result.error.includes('[secret]'));
  assert.ok(result.error.includes('Load failed for'));
});

function buildLongCompletion({ tokens = 128, sliceBytes = 11 } = {}) {
  const pieces = [];
  const events = [];
  for (let i = 0; i < tokens; i++) {
    const piece = `token-${String(i).padStart(3, '0')} café lorem ipsum dolor sit\n`;
    pieces.push(piece);
    events.push({
      id: 'cmpl-long',
      object: 'text_completion',
      model: 'flybrain-untrained',
      choices: [{ index: 0, text: piece, logprobs: null, finish_reason: null }],
    });
  }
  events.push({
    id: 'cmpl-long',
    object: 'text_completion',
    model: 'flybrain-untrained',
    choices: [{ index: 0, text: '', logprobs: null, finish_reason: 'length' }],
  });
  events.push({
    id: 'cmpl-long',
    object: 'text_completion',
    model: 'flybrain-untrained',
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: tokens, total_tokens: 4 + tokens },
  });

  const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(wire);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += sliceBytes) {
    chunks.push(bytes.slice(offset, offset + sliceBytes));
  }
  const text = pieces.join('');
  return { text, chunks };
}

test('GenerationController streams 128 fragmented tokens into multi-thousand character output', async () => {
  const { text, chunks } = buildLongCompletion();
  const controller = new GenerationController({
    fetch: async () => new Response(createMockReadableStream(chunks), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });

  const snapshots = [];
  controller.subscribe(s => snapshots.push(s));

  try {
    const result = await controller.submit({
      prompt: 'Long output test',
      maxTokens: 128,
      temperature: 1.0,
      topK: 50,
    });

    assert.equal(result.success, true);
    assert.equal(result.text, text);
    assert.ok(text.length > 4000);
    assert.equal(result.finishReason, 'length');
    assert.deepEqual(result.usage, {
      prompt_tokens: 4,
      completion_tokens: 128,
      total_tokens: 132,
    });

    const finalState = controller.getState();
    assert.equal(finalState.state, GENERATION_STATES.COMPLETED);
    assert.equal(finalState.text, text);
    assert.equal(finalState.modelCompletionId, 'cmpl-long');

    assert.ok(snapshots.length > 100);

    for (let i = 1; i < snapshots.length; i++) {
      assert.ok(
        snapshots[i].text.length >= snapshots[i - 1].text.length,
        `Snapshot text length decreased at index ${i}`
      );
    }

    for (const s of snapshots) {
      assert.ok(text.startsWith(s.text));
    }

    assert.ok(new Set(snapshots.map(s => s.text.length)).size >= 129);
  } finally {
    controller.dispose();
  }
});

test('mountPrompt preserves complete output across pages and announces once', async () => {
  const { text, chunks } = buildLongCompletion();
  const controller = new GenerationController({
    fetch: async url => {
      if (url === '/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            model: 'flybrain-untrained',
            note: 'TEMPORARY, untrained',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return new Response(createMockReadableStream(chunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });

  const doc = new MockDocument();
  const root = doc.createElement('div');
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  try {
    await controller.checkHealth();
    assert.equal(controller.getState().health.ready, true);

    const announcement = root.getElementById(PROMPT_DOM_IDS.ANNOUNCEMENT);
    const announcements = [];
    let currentAnnouncement = announcement.textContent;
    Object.defineProperty(announcement, 'textContent', {
      get() {
        return currentAnnouncement;
      },
      set(value) {
        currentAnnouncement = String(value);
        announcements.push(currentAnnouncement);
      },
      configurable: true,
    });

    root.getElementById(PROMPT_DOM_IDS.INPUT).value = 'Long output test';
    root.getElementById(PROMPT_DOM_IDS.MAX_TOKENS).value = '128';

    const finished = new Promise(resolve => {
      const off = controller.subscribe(s => {
        if (s.state === GENERATION_STATES.COMPLETED || s.state === GENERATION_STATES.FAILED) {
          off();
          resolve(s);
        }
      });
    });

    root.getElementById(PROMPT_DOM_IDS.FORM).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );

    const final = await finished;

    assert.equal(final.state, GENERATION_STATES.COMPLETED);

    const output = root.getElementById(PROMPT_DOM_IDS.OUTPUT);
    const previous = root.getElementById(PROMPT_DOM_IDS.PAGER_PREV);
    const latest = root.getElementById(PROMPT_DOM_IDS.PAGER_LATEST);
    const lastPage = output.textContent;
    const pages = [lastPage];
    assert.equal(previous.disabled, false);
    while (!previous.disabled) {
      previous.dispatchEvent(new Event('click'));
      pages.unshift(output.textContent);
    }
    assert.equal(pages.join(''), text, 'Every page preserves the original Unicode and whitespace');
    latest.dispatchEvent(new Event('click'));
    assert.equal(output.textContent, lastPage);

    assert.equal(announcements.length, 1, 'Completion is announced once, not once per token or page');
  } finally {
    dispose();
  }
});
