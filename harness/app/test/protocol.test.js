import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProtocolReceiver } from '../protocol.js';

const fixture = (name) => readFileSync(new URL(`../../protocol/v1/fixtures/${name}`, import.meta.url), 'utf8');
const lines = (text) => text.trim().split(/\r?\n/);
const mapping = {
  type: 'mapping', version: 1,
  groups: [{ id: 17, name: 'Output' }, { id: 4, name: 'Input' }],
  nodes: [{ id: 91, group: 17 }, { id: 3, group: 4 }],
  edges: [[3, 91]],
};
const send = (receiver, message) => receiver.process(JSON.stringify(message));

test('real-model review recording accepts both epochs and every declared fire', () => {
  const recording = new URL('../../recordings/reference.ndjson', import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL(`${recording.href}.metadata.json`), 'utf8'));
  const receiver = new ProtocolReceiver();
  const epochs = [];
  for (const raw of lines(readFileSync(recording, 'utf8'))) {
    const event = receiver.process(raw);
    if (event.action === 'replace_mapping') epochs.push([]);
    else {
      assert.equal(event.action, 'accept_fire');
      assert.deepEqual(event.dropped_pairs, []);
      assert.ok(event.pairs.length > 0);
      epochs.at(-1).push(event.t);
    }
  }
  assert.deepEqual(epochs, [Array.from({ length: 33 }, (_, t) => t), Array.from({ length: 11 }, (_, t) => t)]);
  assert.equal(epochs.length, metadata.epochs);
  assert.equal(epochs.flat().length, metadata.steps);
  assert.equal(receiver.epoch, metadata.epochs - 1);
  assert.equal(receiver.lastT, metadata.last_epoch_steps - 1);
  assert.equal(receiver.mapping.nodes.length, metadata.topology.nodes);
  assert.equal(receiver.mapping.edges.length, metadata.topology.edges);
});

for (const scenario of JSON.parse(fixture('invalid-cases.json')).cases) {
  test(`contract fixture: ${scenario.id}`, () => {
    const receiver = new ProtocolReceiver();
    const outcomes = scenario.frames.map((frame, index) => {
      if (scenario.reconnect_before?.includes(index)) receiver.reset();
      return receiver.process(frame);
    });
    assert.deepEqual(outcomes, scenario.expected, scenario.description);
  });
}

test('reference recording matches every golden event', () => {
  const receiver = new ProtocolReceiver();
  const outcomes = lines(fixture('reference.ndjson')).map((frame) => receiver.process(frame));
  assert.deepEqual(outcomes, JSON.parse(fixture('reference.expected.json')).events);
  assert.equal(receiver.epoch, 1);
  assert.equal(receiver.lastT, 0);
  assert.equal(receiver.mapping.nodes.length, 3);
});

test('bundled real capture accepts its complete topology and every fire frame', () => {
  const receiver = new ProtocolReceiver();
  const frames = lines(readFileSync(new URL('../../example/once_upon_a_time.ndjson', import.meta.url), 'utf8'));
  assert.equal(frames.length, 12);
  assert.deepEqual(receiver.process(frames[0]), {
    action: 'replace_mapping', epoch: 0, groups: 5, nodes: 1958, edges: 19037,
  });
  for (const frame of frames.slice(1)) {
    const message = JSON.parse(frame);
    assert.deepEqual(receiver.process(frame), {
      action: 'accept_fire', epoch: 0, t: message.t, pairs: message.pairs, dropped_pairs: [],
    });
  }
  assert.equal(receiver.lastT, 10);
});

test('sparse, unordered ids work and direction is preserved', () => {
  const receiver = new ProtocolReceiver();
  assert.deepEqual(send(receiver, mapping), {
    action: 'replace_mapping', epoch: 0, groups: 2, nodes: 2, edges: 1,
  });
  assert.deepEqual(send(receiver, { type: 'fire', t: 8, pairs: [[91, 3], [3, 91], [3, 999]] }), {
    action: 'accept_fire', epoch: 0, t: 8, pairs: [[3, 91]], dropped_pairs: [[91, 3], [3, 999]],
  });
  assert.deepEqual(receiver.mapping.groups.map((group) => group.id), [17, 4]);
});

test('invalid replacement retains topology, epoch, and accepted time atomically', () => {
  const receiver = new ProtocolReceiver();
  send(receiver, mapping);
  send(receiver, { type: 'fire', t: 8, pairs: [[3, 91]] });
  const previous = receiver.mapping;
  for (const replacement of [
    { ...mapping, groups: [{ id: 4, name: 'Input' }] },
    { ...mapping, nodes: [{ id: 3, group: 4 }] },
    { ...mapping, edges: [[3, 91], [3, 91]] },
  ]) {
    assert.deepEqual(send(receiver, replacement), { action: 'drop_message' });
    assert.equal(receiver.mapping, previous);
    assert.equal(receiver.epoch, 0);
    assert.equal(receiver.lastT, 8);
  }
  assert.deepEqual(send(receiver, { type: 'fire', t: 8, pairs: [] }), { action: 'drop_message' });
  assert.equal(send(receiver, { type: 'fire', t: 9, pairs: [[3, 91]] }).action, 'accept_fire');
});

test('malformed or repeated pairs never consume the step, even after valid pairs', () => {
  const receiver = new ProtocolReceiver();
  send(receiver, mapping);
  for (const pairs of [
    [[3, 91], [3, 91]], [[3, 91], [3]], [[3, 91], [3, 91, 4]],
    [[3, 91], null], [[3, 91], ['3', 91]], [[3, 91], [-1, 91]],
    [[3, 91], [3.5, 91]], [[999, 91], [999, 91]],
  ]) {
    assert.deepEqual(send(receiver, { type: 'fire', t: 7, pairs }), { action: 'drop_message' });
    assert.equal(receiver.lastT, null);
  }
  assert.deepEqual(send(receiver, { type: 'fire', t: 7, pairs: [] }), {
    action: 'accept_fire', epoch: 0, t: 7, pairs: [], dropped_pairs: [],
  });
  assert.equal(receiver.lastT, 7);
});

test('new mapping discards old edges and accepts empty topology and fire', () => {
  const receiver = new ProtocolReceiver();
  send(receiver, mapping);
  send(receiver, { type: 'fire', t: 90, pairs: [[3, 91]] });
  const replacement = { ...mapping, edges: [[91, 3]] };
  assert.equal(send(receiver, replacement).epoch, 1);
  assert.equal(receiver.lastT, null);
  assert.deepEqual(send(receiver, { type: 'fire', t: 0, pairs: [[3, 91], [91, 3]] }), {
    action: 'accept_fire', epoch: 1, t: 0, pairs: [[91, 3]], dropped_pairs: [[3, 91]],
  });
  assert.deepEqual(send(receiver, { type: 'mapping', version: 1, groups: [], nodes: [], edges: [] }), {
    action: 'replace_mapping', epoch: 2, groups: 0, nodes: 0, edges: 0,
  });
  assert.deepEqual(send(receiver, { type: 'fire', t: 0, pairs: [] }), {
    action: 'accept_fire', epoch: 2, t: 0, pairs: [], dropped_pairs: [],
  });
});

test('bad text, native non-text inputs, and malformed records are dropped without throwing', () => {
  const receiver = new ProtocolReceiver();
  const rawInputs = [
    null, undefined, 1, {}, [], new ArrayBuffer(4), new Uint8Array([123, 125]),
    new Blob(['{}']), '', '{', 'null', 'true', '1', '"mapping"', '[]',
  ];
  for (const raw of rawInputs) assert.deepEqual(receiver.process(raw), { action: 'drop_message' });
  for (const message of [
    { ...mapping, version: null }, { ...mapping, version: true },
    { ...mapping, groups: [null] }, { ...mapping, nodes: [null] },
    { ...mapping, edges: [null] }, { ...mapping, groups: [{ id: 4, name: 1 }] },
    { ...mapping, nodes: [{ id: 3, group: '4' }] },
  ]) assert.deepEqual(send(receiver, message), { action: 'drop_message' });
  assert.equal(send(receiver, mapping).action, 'replace_mapping');
  for (const t of [null, true, '0', -1, 0.5]) {
    assert.deepEqual(send(receiver, { type: 'fire', t, pairs: [] }), { action: 'drop_message' });
  }
  assert.equal(send(receiver, { type: 'fire', t: 0, pairs: [] }).action, 'accept_fire');
});

test('unsupported replacement stops receiving until reconnect resets all state', () => {
  const receiver = new ProtocolReceiver();
  send(receiver, mapping);
  send(receiver, { type: 'fire', t: 4, pairs: [[3, 91]] });
  assert.deepEqual(send(receiver, { ...mapping, version: 2 }), { action: 'close', code: 1003 });
  assert.equal(receiver.closed, true);
  assert.notEqual(send(receiver, mapping).action, 'replace_mapping');
  assert.notEqual(send(receiver, { type: 'fire', t: 5, pairs: [] }).action, 'accept_fire');
  receiver.reset();
  assert.equal(receiver.mapping, null);
  assert.equal(receiver.lastT, null);
  assert.equal(receiver.closed, false);
  assert.deepEqual(send(receiver, { type: 'fire', t: 0, pairs: [] }), { action: 'drop_message' });
  assert.equal(send(receiver, mapping).epoch, 0);
  assert.equal(send(receiver, { type: 'fire', t: 0, pairs: [] }).action, 'accept_fire');
});
