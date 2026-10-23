import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_DURATION, EdgeActivity } from '../activity.js';

test('activity keeps direction, sparse ids, and self loops, filtering undeclared pairs', () => {
  const activity = new EdgeActivity([[6, 90001], [90001, 6], [2, 2]]);
  assert.deepEqual([...activity.starts], [-1, -1, -1]);
  assert.equal(activity.active(0), false);
  assert.equal(activity.fire([[6, 90001], [2, 2], [90001, 2]], 0), true);
  assert.deepEqual([...activity.starts], [0, -1, 0]);
  assert.equal(activity.active(ACTIVITY_DURATION - 1), true);
  assert.equal(activity.active(ACTIVITY_DURATION), false);
  assert.equal(activity.fire([[90001, 2]], ACTIVITY_DURATION), false);
  assert.equal(activity.active(ACTIVITY_DURATION), false);
});

test('declared synapses light both endpoint nodes without lighting isolated or undeclared endpoints', () => {
  const activity = new EdgeActivity(
    [[90001, 6], [6, 2]],
    [{ id: 2 }, { id: 90001 }, { id: 6 }, { id: 88 }],
  );
  activity.fire([[90001, 6], [88, 90001]], 100);
  assert.deepEqual([...activity.starts], [100, -1, -1, 100, 100, -1]);
  assert.equal(activity.active(100 + ACTIVITY_DURATION - 1), true);
  assert.equal(activity.active(100 + ACTIVITY_DURATION), false);
});

test('repeated activity restarts its duration using arrival time without filling gaps', () => {
  const activity = new EdgeActivity([[1, 2], [2, 1]]);
  const starts = activity.starts;
  activity.fire([[1, 2]], 10);
  activity.fire([[1, 2]], 200);
  assert.strictEqual(activity.starts, starts);
  assert.deepEqual([...starts], [200, -1]);
  assert.equal(activity.active(10 + ACTIVITY_DURATION), true);
  assert.equal(activity.active(200 + ACTIVITY_DURATION), false);
  assert.equal(activity.active(10000), false);
  activity.fire([[2, 1]], 10000);
  assert.deepEqual([...starts], [200, 10000]);
  assert.equal(activity.active(10001), true);
});

test('a large burst reuses one timestamp buffer and mapping replacement starts inactive', () => {
  const pairs = Array.from({ length: 20000 }, (_, index) => [index, index + 1]);
  const activity = new EdgeActivity(pairs);
  const starts = activity.starts;
  activity.fire(pairs, 25);
  assert.strictEqual(activity.starts, starts);
  assert.ok(starts.every(value => value === 25));
  const replacement = new EdgeActivity([[20001, 20002]]);
  assert.equal(replacement.active(25), false);
  assert.equal(replacement.fire([[0, 1]], 25), false);
  assert.deepEqual([...replacement.starts], [-1]);
  const empty = new EdgeActivity([]);
  assert.equal(empty.starts.length, 1);
  assert.equal(empty.fire([], 25), false);
  assert.equal(empty.active(25), false);
});

test('shader timestamps retain sub-millisecond accuracy after days without growing buffers', () => {
  const activity = new EdgeActivity([[1, 2], [2, 1]]);
  const starts = activity.starts;
  for (const day of [1, 30, 365]) {
    const now = day * 86400000 + 0.25;
    activity.fire([[1, 2]], now);
    assert.equal(activity.starts, starts);
    assert.equal(activity.time(now + 0.5) - starts[0], 0.5);
    assert.equal(activity.active(now + 599.5), true);
    assert.equal(activity.active(now + 600), false);
    assert.equal(activity.time(now + 600) - starts[0], 600);
    assert.equal(starts[1], -1);
  }
});

test('clock rebase retains recent highlights and clears expired timestamps', () => {
  const activity = new EdgeActivity([[1, 2], [2, 1]]);
  activity.fire([[1, 2]], 59800);
  activity.fire([[2, 1]], 59000);
  const version = activity.version;
  const time = activity.time(60100);
  assert.equal(time - activity.starts[0], 300);
  assert.equal(activity.starts[1], -1);
  assert.equal(activity.version, version + 1);
  assert.equal(activity.active(60399), true);
  assert.equal(activity.active(60400), false);
});
