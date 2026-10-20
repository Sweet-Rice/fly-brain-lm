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
