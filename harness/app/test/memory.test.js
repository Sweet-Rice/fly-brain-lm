import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryInspector, validateMemoryMessage } from '../memory.js';

const envelope = { seq: 1, run_id: 'run-one', request_id: 'request-one', epoch: 7,
  t: 0, scale: 10000, block: 0, prev_rev: 0, rev: 1 };
const summary = (overrides = {}) => ({ ...envelope, type: 'memory_summary', heads: 3,
  head_dim: 2, dtype: 'float32', dopamine_gate: [1200, 4500, 3100],
  dopamine_cap: [9900, 9900, 9900], recovery_half_life: [150000, 120000, 200000],
  recovery_factor: [9548, 9439, 9659], s_norm_before: [0, 0, 0],
  s_norm_after: [12850, 8910, 10790], s_delta_norm: [1420, 950, 1120], ...overrides });
const slice = (overrides = {}) => ({ ...envelope, type: 'memory_slice', lobe: 0, kc_id: 42,
  head: 0, k_activation: 8500, s_before: [0, 0], s_after: [1165, 602],
  read_vector: [2150, -1400], delta_raw: [200, 100], delta_net: [145, 72], ...overrides });
const status = (overrides = {}) => ({ type: 'stream_status', run_id: 'run-one', epoch: 7,
  seq: 1, event: 'resync', dropped_steps: 0, server_time_ms: 1234, ...overrides });

test('memory wire validation requires complete messages and safe integers', () => {
  for (const message of [summary(), slice()]) {
    assert.equal(validateMemoryMessage(message), true);
    for (const field of Object.keys(message)) {
      const missing = { ...message };
      delete missing[field];
      assert.equal(validateMemoryMessage(missing), false, `missing ${message.type}.${field}`);
    }
    for (const field of ['seq', 'epoch', 't', 'block', 'prev_rev']) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
        assert.equal(validateMemoryMessage({ ...message, [field]: value }), false, `${field}=${value}`);
      }
    }
    for (const changes of [{ rev: 2 }, { scale: 0 }, { scale: 1.5 }, { request_id: '' }, { run_id: '' }]) {
      assert.equal(validateMemoryMessage({ ...message, ...changes }), false);
    }
  }
  for (const message of [null, [], false, { type: 'constructor' }, status(), summary({ heads: 2 }),
    summary({ head_dim: 0 }), summary({ dtype: '' }), slice({ lobe: 3 }), slice({ kc_id: -1 }),
    slice({ head: 1.5 }), slice({ k_activation: Infinity })]) {
    assert.equal(validateMemoryMessage(message), false);
  }
  assert.equal(validateMemoryMessage(summary({ extra: { ignored: true } })), true);
});

test('all vectors have exact lengths and retain nonfinite or masked wire sentinels', () => {
  const summaryFields = ['dopamine_gate', 'dopamine_cap', 'recovery_half_life', 'recovery_factor',
    's_norm_before', 's_norm_after', 's_delta_norm'];
  const sliceFields = ['s_before', 's_after', 'read_vector', 'delta_raw', 'delta_net'];
  for (const [message, fields, length] of [[summary(), summaryFields, 3], [slice(), sliceFields, 2]]) {
    for (const field of fields) {
      for (const value of [[], new Array(length), Array(length).fill(null), Array(length).fill(0.1),
        Array(length).fill(Number.MAX_SAFE_INTEGER + 1), Array(length).fill(NaN)]) {
        assert.equal(validateMemoryMessage({ ...message, [field]: value }), false, field);
      }
      for (const special of ['nan', 'inf', '-inf', 'missing', -1, 0]) {
        assert.equal(validateMemoryMessage({ ...message, [field]: Array(length).fill(special) }), true);
      }
    }
  }
  assert.equal(validateMemoryMessage(slice({ read_vector: [1] })), false);
  assert.equal(validateMemoryMessage(summary({ dopamine_gate: [1] })), false);
});

test('summary and slices form the same write with computational head/lobe and shape validation', () => {
  const memory = new MemoryInspector();
  assert.equal(memory.accept(summary()), true);
  assert.equal(memory.accept(slice({ seq: 3 })), true);
  assert.equal(memory.accept(slice({ seq: 4, lobe: 1, head: 1 })), true);
  for (const changes of [{ t: 1 }, { scale: 10 }, { head: 3 }, { head: 1, lobe: 0 },
    { s_before: [1], s_after: [1], read_vector: [1], delta_raw: [1], delta_net: [1] }]) {
    assert.equal(memory.accept(slice({ seq: 5, kc_id: 43, ...changes })), false);
  }
  assert.equal(memory.accept(summary({ seq: 6 })), false);
  assert.equal(memory.accept(slice({ seq: 7 })), false);
  assert.equal(memory.snapshot.last_seq, 4);
  assert.equal(memory.snapshot.writes.length, 1);
  assert.equal(memory.snapshot.writes[0].slices.length, 2);
  assert.equal(memory.snapshot.writes[0].continuity, 'initial');
});

test('independent summary and slice strides permit orphan slices without fabricated metadata', () => {
  const memory = new MemoryInspector();
  assert.equal(memory.accept(slice({ rev: 5, prev_rev: 4, t: 7 })), true);
  let write = memory.snapshot.writes[0];
  assert.equal(write.summary, null);
  assert.equal(write.continuity, 'baseline');
  assert.equal(Object.hasOwn(write, 'dtype'), false);
  assert.equal(memory.accept(slice({ seq: 2, kc_id: 43, rev: 5, prev_rev: 4, t: 7,
    s_before: [1], s_after: [1], read_vector: [1], delta_raw: [1], delta_net: [1] })), false);
  assert.equal(memory.accept(summary({ seq: 3, rev: 5, prev_rev: 4, t: 7, head_dim: 4 })), false);
  assert.equal(memory.accept(summary({ seq: 4, rev: 5, prev_rev: 4, t: 7 })), true);
  write = memory.snapshot.writes[0];
  assert.equal(write.summary.head_dim, 2);
  assert.equal(memory.accept(summary({ seq: 8, rev: 9, prev_rev: 8, t: 11 })), true);
  assert.equal(memory.snapshot.writes[1].continuity, 'gap');
  assert.equal(memory.snapshot.dropped_messages, 0);
  assert.equal(memory.accept(slice({ seq: 10, rev: 10, prev_rev: 9, t: 12 })), true);
  assert.equal(memory.snapshot.writes[2].continuity, 'contiguous');
  assert.equal(memory.accept(slice({ seq: 11, rev: 10, prev_rev: 9, t: 12, block: 1 })), true);
  assert.equal(memory.snapshot.writes[3].continuity, 'baseline');
});

test('late summary head/lobe errors leave orphan writes and sequence unchanged', () => {
  for (const changes of [{ head: 3 }, { head: 1, lobe: 0 }]) {
    const memory = new MemoryInspector();
    assert.equal(memory.accept(slice(changes)), true);
    const before = memory.snapshot;
    assert.equal(memory.accept(summary({ seq: 2 })), false);
    assert.deepEqual(memory.snapshot, before);
  }
});

test('stale sequence, epochs, revisions and reversed model steps are rejected', () => {
  const memory = new MemoryInspector();
  memory.accept(summary({ seq: 20, rev: 5, prev_rev: 4, t: 10 }));
  for (const changes of [{ seq: 20 }, { seq: 19 }, { epoch: 6 }, { rev: 4, prev_rev: 3 },
    { rev: 6, prev_rev: 5, t: 10 }, { rev: 6, prev_rev: 5, t: 9 }]) {
    assert.equal(memory.accept(slice({ seq: 21, rev: 5, prev_rev: 4, t: 10, ...changes })), false);
  }
  assert.equal(memory.accept(slice({ seq: 50, rev: 6, prev_rev: 5, t: 11 })), true);
  assert.equal(memory.snapshot.dropped_messages, 0);
  assert.equal(memory.snapshot.writes[1].continuity, 'contiguous');
});

test('only explicit stream gaps mark delivery loss and reset establishes clean server identity', () => {
  const memory = new MemoryInspector();
  memory.accept(summary());
  assert.equal(memory.accept(status({ seq: 10, event: 'gap', dropped_steps: 5 })), true);
  assert.equal(memory.snapshot.writes[0].partial, true);
  memory.accept(summary({ seq: 15, rev: 2, prev_rev: 1, t: 1 }));
  assert.equal(memory.snapshot.writes[1].continuity, 'gap');
  memory.accept(summary({ seq: 20, rev: 3, prev_rev: 2, t: 2 }));
  assert.equal(memory.snapshot.writes[2].continuity, 'contiguous');
  assert.equal(memory.snapshot.dropped_messages, 5);
  assert.equal(memory.accept(status({ seq: 21, event: 'resync', dropped_steps: 1 })), false);
  assert.equal(memory.accept(status({ seq: 21 })), true);
  assert.equal(memory.snapshot.writes.length, 0);
  assert.equal(memory.snapshot.dropped_messages, 0);
  memory.accept(slice({ seq: 22 }));
  assert.equal(memory.accept(status({ seq: 23, epoch: 8, event: 'epoch_reset' })), true);
  assert.equal(memory.snapshot.writes.length, 0);
  assert.equal(memory.snapshot.epoch, 8);
  memory.accept(slice({ seq: 24, epoch: 8 }));
  assert.equal(memory.accept(summary({ seq: 1, epoch: 0, run_id: 'run-two' })), true);
  assert.equal(memory.snapshot.writes.length, 1);
  assert.equal(memory.snapshot.run_id, 'run-two');
  assert.equal(memory.snapshot.epoch, 0);
  memory.reset();
  assert.equal(memory.snapshot.last_seq, null);
  assert.equal(memory.snapshot.status, null);
  assert.deepEqual(memory.snapshot.writes, []);
});

test('all revision state is bounded and retention loss establishes a baseline', () => {
  const memory = new MemoryInspector({ maxWrites: 2, maxSlices: 2 });
  memory.accept(summary());
  memory.accept(slice({ seq: 2 }));
  memory.accept(slice({ seq: 3, kc_id: 43 }));
  for (let i = 4; i < 100; i++) memory.accept(slice({ seq: i, kc_id: i + 100 }));
  assert.equal(memory.snapshot.writes[0].slices.length, 2);
  assert.equal(memory.snapshot.writes[0].omitted_slices, 96);
  memory.accept(summary({ seq: 100, request_id: 'two' }));
  memory.accept(summary({ seq: 101, request_id: 'three' }));
  assert.equal(memory.snapshot.writes.length, 2);
  assert.equal(memory.snapshot.omitted_writes, 1);
  memory.accept(summary({ seq: 102, rev: 5, prev_rev: 4, t: 5 }));
  assert.equal(memory.snapshot.writes[1].continuity, 'baseline');
  for (let i = 103; i < 1000; i++) memory.accept(summary({ seq: i, request_id: `request-${i}` }));
  assert.equal(memory.writes.length, 2);
  assert.equal(Object.values(memory).some(value => value instanceof Map || value instanceof Set), false);
  for (const option of [{ maxWrites: 0 }, { maxSlices: -1 }, { maxWrites: Infinity }, { maxSlices: 1.5 }]) {
    assert.throws(() => new MemoryInspector(option), RangeError);
  }
});

test('wire projection and snapshots isolate nested arrays and omit unknown fields', () => {
  const memory = new MemoryInspector();
  const input = summary({ unknown: { secret: 'ignored' } });
  memory.accept(input);
  const inputSlice = slice({ seq: 2, extra: [1, 2, 3] });
  memory.accept(inputSlice);
  input.dopamine_gate[0] = -999;
  inputSlice.s_after[0] = -999;
  const snapshot = memory.snapshot;
  assert.equal(snapshot.writes[0].summary.dopamine_gate[0], 1200);
  assert.equal(snapshot.writes[0].slices[0].s_after[0], 1165);
  assert.equal(Object.hasOwn(snapshot.writes[0].summary, 'unknown'), false);
  assert.equal(Object.hasOwn(snapshot.writes[0].slices[0], 'extra'), false);
  snapshot.writes[0].summary.dopamine_gate[0] = -100;
  snapshot.writes[0].slices[0].s_after[0] = -100;
  snapshot.writes.length = 0;
  assert.equal(memory.snapshot.writes.length, 1);
  assert.equal(memory.snapshot.writes[0].summary.dopamine_gate[0], 1200);
  assert.equal(memory.snapshot.writes[0].slices[0].s_after[0], 1165);
});
