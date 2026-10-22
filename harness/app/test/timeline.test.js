import assert from 'node:assert/strict';
import test from 'node:test';
import { Timeline, validateTelemetryMessage } from '../timeline.js';

const envelope = { run_id: 'run-one', epoch: 7, seq: 1 };
const lifecycle = (overrides = {}) => ({
  ...envelope, type: 'request_lifecycle', request_id: 'request-one',
  impl: 'vibe2', model_id: 'tiny', ckpt_digest: 'sha256:0123456789ab',
  phase: 'queued', t_start: -1, prompt_raw_tokens: 4, prompt_tokens: 0,
  max_tokens: 2, completion_tokens: 0, finish_reason: 'none',
  server_time_ms: 1729548000123, timestamp_ns: '1729548000123456789', ...overrides,
});
const token = (overrides = {}) => ({
  ...envelope, type: 'token_step', request_id: 'request-one', kind: 'prompt',
  token_index: 0, token_id: 42, token_text: '<script>🌱', token_bytes: 'f09f8cb1',
  step_status: 'stepped_fired', t: 21, step_rel_us: 1200, emit_rel_us: 1200,
  step_ns: '1729548000124656789', emit_ns: '1729548000124656789', ...overrides,
});
const status = (overrides = {}) => ({
  ...envelope, type: 'stream_status', event: 'resync', dropped_steps: 0,
  server_time_ms: 1729548000123, ...overrides,
});

test('wire validation requires all fields, safe integers, exact timestamp strings and valid enums', () => {
  for (const message of [lifecycle(), token(), status()]) {
    assert.equal(validateTelemetryMessage(message), true);
    for (const field of Object.keys(message)) {
      const missing = { ...message };
      delete missing[field];
      assert.equal(validateTelemetryMessage(missing), false, `missing ${message.type}.${field}`);
    }
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
      assert.equal(validateTelemetryMessage({ ...message, seq }), false);
    }
  }
  for (const message of [null, [], 'x', { type: 'memory_summary' }, lifecycle({ timestamp_ns: 1729548000123456789 }),
    lifecycle({ timestamp_ns: '1.5' }), lifecycle({ phase: 'unknown' }),
    token({ token_bytes: '0' }), token({ token_bytes: 'FF' }), token({ kind: 'other' }),
    token({ token_id: -1 }), token({ t: -1 }), token({ step_status: 'other' }),
    status({ event: 'resync', dropped_steps: 1 }), status({ event: 'other' })]) {
    assert.equal(validateTelemetryMessage(message), false);
  }
  assert.equal(validateTelemetryMessage(lifecycle({ future_field: { any: true } })), true);
});

test('terminal reasons and final unprocessed token remain distinct from silent executed steps', () => {
  for (const [phase, finish_reason] of [['completed', 'stop'], ['completed', 'length'],
    ['cancelled', 'cancelled'], ['failed', 'error']]) {
    assert.equal(validateTelemetryMessage(lifecycle({ phase, finish_reason })), true);
  }
  assert.equal(validateTelemetryMessage(lifecycle({ phase: 'completed', finish_reason: 'none' })), false);
  assert.equal(validateTelemetryMessage(lifecycle({ phase: 'decode', finish_reason: 'error' })), false);
  assert.equal(validateTelemetryMessage(token({ step_status: 'stepped_silent' })), true);
  const final = token({ kind: 'completion', step_status: 'unprocessed', t: -1,
    step_ns: '0', step_rel_us: 0, token_text: '', token_bytes: '' });
  assert.equal(validateTelemetryMessage(final), true);
  assert.equal(validateTelemetryMessage({ ...final, kind: 'prompt' }), false);
  assert.equal(validateTelemetryMessage({ ...final, t: 0 }), false);
  assert.equal(validateTelemetryMessage({ ...final, step_ns: '1' }), false);
  assert.equal(validateTelemetryMessage(token({ emit_rel_us: 1300 })), false);
});

test('shared sequence ordering rejects duplicates and regressions without treating normal holes as loss', () => {
  const timeline = new Timeline();
  assert.equal(timeline.accept(status({ seq: 10 })), true);
  assert.equal(timeline.accept(lifecycle({ seq: 20 })), true);
  assert.equal(timeline.accept(token({ seq: 40 })), true);
  assert.equal(timeline.accept(token({ seq: 40, token_index: 1 })), false);
  assert.equal(timeline.accept(status({ seq: 19, event: 'gap', dropped_steps: 4 })), false);
  assert.equal(timeline.accept({ type: 'memory_summary', ...envelope, seq: 41 }), false);
  assert.equal(timeline.accept(token({ seq: 90, token_index: 1 })), true);
  assert.equal(timeline.snapshot.last_seq, 90);
  assert.equal(timeline.snapshot.dropped_messages, 0);
  assert.equal(timeline.snapshot.requests[0].partial, false);
  assert.equal(timeline.snapshot.requests[0].tokens[0].step_ns, '1729548000124656789');
});

test('gap markers report lost messages and partial requests, not fabricated missing token counts', () => {
  const timeline = new Timeline();
  timeline.accept(lifecycle());
  timeline.accept(token({ seq: 2 }));
  assert.equal(timeline.accept(status({ seq: 3, event: 'gap', dropped_steps: 5 })), true);
  timeline.accept(token({ seq: 4, token_index: 3 }));
  timeline.accept(status({ seq: 5, event: 'gap', dropped_steps: 2 }));
  assert.equal(timeline.snapshot.dropped_messages, 7);
  assert.equal(timeline.snapshot.requests[0].partial, true);
  assert.equal(timeline.snapshot.requests[0].omitted_tokens, 0);
  assert.deepEqual(timeline.snapshot.requests[0].tokens.map(item => item.token_index), [0, 3]);
});

test('mid-request attach accepts terminal-only and token-only observations without inventing earlier phases', () => {
  const timeline = new Timeline();
  timeline.accept(status());
  assert.equal(timeline.accept(token({ seq: 2, kind: 'completion', token_index: 6 })), true);
  assert.equal(timeline.snapshot.requests[0].partial, true);
  assert.equal(timeline.snapshot.requests[0].lifecycle, null);
  assert.equal(timeline.accept(lifecycle({ seq: 3, phase: 'completed', finish_reason: 'length', completion_tokens: 7 })), true);
  assert.deepEqual(timeline.snapshot.requests[0].phases.map(item => item.phase), ['completed']);
  assert.equal(timeline.accept(lifecycle({ seq: 4, request_id: 'cancel', phase: 'cancelled', finish_reason: 'cancelled' })), true);
  assert.equal(timeline.accept(lifecycle({ seq: 5, request_id: 'fail', phase: 'failed', finish_reason: 'error' })), true);
});

test('missing lifecycle phases are partial, while later delivery gaps do not alter finished requests', () => {
  const timeline = new Timeline();
  timeline.accept(lifecycle());
  timeline.accept(lifecycle({ seq: 2, phase: 'decode' }));
  assert.equal(timeline.snapshot.requests[0].partial, true);
  timeline.accept(lifecycle({ seq: 3, request_id: 'cancel' }));
  timeline.accept(lifecycle({ seq: 4, request_id: 'cancel', phase: 'cancelled', finish_reason: 'cancelled' }));
  assert.equal(timeline.snapshot.requests[1].partial, false);
  timeline.accept(status({ seq: 5, event: 'gap', dropped_steps: 1 }));
  assert.equal(timeline.snapshot.requests[1].partial, false);
});

test('request phases and each token kind advance independently, preserving Unicode and empty text', () => {
  const timeline = new Timeline();
  timeline.accept(lifecycle());
  timeline.accept(lifecycle({ seq: 2, phase: 'prefill', prompt_tokens: 4, t_start: 21 }));
  timeline.accept(token({ seq: 3 }));
  timeline.accept(lifecycle({ seq: 4, phase: 'decode', prompt_tokens: 4, t_start: 21 }));
  assert.equal(timeline.accept(token({ seq: 5, kind: 'completion', token_text: '' })), true);
  assert.equal(timeline.accept(token({ seq: 6, kind: 'completion' })), false);
  assert.equal(timeline.accept(lifecycle({ seq: 7, phase: 'prefill', prompt_tokens: 4 })), false);
  timeline.accept(lifecycle({ seq: 8, phase: 'completed', finish_reason: 'stop', completion_tokens: 1 }));
  assert.equal(timeline.accept(lifecycle({ seq: 9, phase: 'failed', finish_reason: 'error' })), false);
  assert.equal(timeline.accept(token({ seq: 10, kind: 'completion', token_index: 1 })), false);
  const request = timeline.snapshot.requests[0];
  assert.deepEqual(request.phases.map(item => item.phase), ['queued', 'prefill', 'decode', 'completed']);
  assert.deepEqual(request.tokens.map(item => item.token_text), ['<script>🌱', '']);
});

test('resync, server epoch transition, run transition and explicit reset clear retained state', () => {
  const timeline = new Timeline();
  timeline.accept(lifecycle());
  timeline.accept(status({ seq: 2, event: 'gap', dropped_steps: 3 }));
  assert.equal(timeline.accept(status({ seq: 3, event: 'resync' })), true);
  assert.equal(timeline.snapshot.requests.length, 0);
  assert.equal(timeline.snapshot.dropped_messages, 0);
  timeline.accept(token({ seq: 4 }));
  assert.equal(timeline.accept(status({ seq: 5, epoch: 8, event: 'epoch_reset' })), true);
  assert.equal(timeline.snapshot.epoch, 8);
  assert.equal(timeline.snapshot.requests.length, 0);
  assert.equal(timeline.accept(token({ seq: 6, epoch: 7 })), false);
  assert.equal(timeline.accept(token({ seq: 6, epoch: 8 })), true);
  assert.equal(timeline.accept(lifecycle({ seq: 0, epoch: 0, run_id: 'run-new' })), true);
  assert.equal(timeline.snapshot.run_id, 'run-new');
  assert.equal(timeline.snapshot.epoch, 0);
  assert.equal(timeline.snapshot.requests.length, 1);
  timeline.reset();
  assert.deepEqual(timeline.snapshot, { run_id: null, epoch: null, last_seq: null,
    requests: [], status: null, dropped_messages: 0, omitted_requests: 0 });
});

test('retention stays bounded with honest eviction counts and isolated snapshots', () => {
  const timeline = new Timeline({ maxRequests: 2, maxTokens: 3 });
  timeline.accept(lifecycle());
  for (let index = 0; index < 1000; index++) timeline.accept(token({ seq: index + 2, token_index: index }));
  let request = timeline.snapshot.requests[0];
  assert.equal(request.tokens.length, 3);
  assert.equal(request.omitted_tokens, 997);
  assert.deepEqual(request.tokens.map(item => item.token_index), [997, 998, 999]);
  request.tokens[0].token_text = 'mutated';
  request.phases[0].phase = 'failed';
  assert.equal(timeline.snapshot.requests[0].tokens[0].token_text, '<script>🌱');
  assert.equal(timeline.snapshot.requests[0].phases[0].phase, 'queued');
  timeline.accept(lifecycle({ seq: 1002, request_id: 'second' }));
  timeline.accept(lifecycle({ seq: 1003, request_id: 'third' }));
  assert.deepEqual(timeline.snapshot.requests.map(item => item.request_id), ['second', 'third']);
  assert.equal(timeline.snapshot.omitted_requests, 1);
  for (const options of [{ maxRequests: 0 }, { maxTokens: -1 }, { maxRequests: 1.5 }]) {
    assert.throws(() => new Timeline(options), RangeError);
  }
});
