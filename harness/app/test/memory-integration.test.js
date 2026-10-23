import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProtocolReceiver } from '../protocol.js';
import { RecordingSource } from '../playback.js';
import { Timeline } from '../timeline.js';
import { MemoryInspector } from '../memory.js';

const fixture = readFileSync(new URL('./fixtures/memory.ndjson', import.meta.url), 'utf8');

test('memory and timeline share recorded telemetry without changing graph time or inventing gaps', async t => {
  const receiver = new ProtocolReceiver();
  const timeline = new Timeline();
  const memory = new MemoryInspector();
  const fires = [];
  const source = new RecordingSource(receiver, {
    onReset() { timeline.reset(); memory.reset(); },
    onEvent(event) {
      if (event.action === 'replace_mapping') { timeline.reset(); memory.reset(); }
      else if (event.action === 'accept_telemetry') {
        timeline.accept(event.message);
        memory.accept(event.message);
      } else if (event.action === 'accept_fire') fires.push(event.t);
      else assert.fail(`Unexpected fixture event: ${event.action}`);
    },
  });
  t.after(() => source.disconnect());
  source.setSpeed(1000);
  await source.load(new Blob([fixture]));
  assert.equal(source.state, 'finished');
  assert.equal(receiver.epoch, 0);
  assert.equal(receiver.lastT, 0);
  assert.deepEqual(fires, [0]);
  assert.equal(memory.snapshot.epoch, 7);
  assert.equal(memory.snapshot.dropped_messages, 0);
  assert.equal(memory.snapshot.writes.length, 1);
  assert.deepEqual(memory.snapshot.writes[0].slices[0].s_after, [1250, 'inf']);
  assert.equal(timeline.snapshot.epoch, 7);
  assert.equal(timeline.snapshot.dropped_messages, 0);
  const request = timeline.snapshot.requests[0];
  assert.equal(request.partial, false);
  assert.deepEqual(request.phases.map(item => item.phase), ['queued', 'prefill', 'decode', 'completed']);
  assert.equal(request.tokens.at(-1).step_status, 'unprocessed');
  assert.equal(request.tokens.at(-1).t, -1);
  await source.restart();
  assert.equal(memory.snapshot.writes.length, 1);
  assert.equal(timeline.snapshot.requests[0].tokens.length, 2);
  source.disconnect();
  assert.equal(memory.snapshot.writes.length, 0);
  assert.equal(timeline.snapshot.requests.length, 0);
});

test('malformed memory frames are dropped without consuming graph steps or closing the stream', () => {
  const receiver = new ProtocolReceiver();
  const frames = fixture.trim().split('\n').map(JSON.parse);
  const summary = frames.find(message => message.type === 'memory_summary');
  const slice = frames.find(message => message.type === 'memory_slice');
  const send = message => receiver.process(JSON.stringify(message));
  assert.equal(send(summary).action, 'drop_message');
  assert.equal(send(slice).action, 'drop_message');
  send(frames[0]);
  for (const message of [{ ...summary, scale: 0 }, { ...slice, s_before: [] },
    { ...summary, rev: 5 }, { ...slice, t: -1 }]) {
    assert.equal(send(message).action, 'drop_message');
    assert.equal(receiver.lastT, null);
  }
  assert.equal(send(summary).action, 'accept_telemetry');
  assert.equal(send(slice).action, 'accept_telemetry');
  assert.equal(send({ type: 'fire', t: 0, pairs: [[7, 7]] }).action, 'accept_fire');
  assert.equal(receiver.closed, false);
});
