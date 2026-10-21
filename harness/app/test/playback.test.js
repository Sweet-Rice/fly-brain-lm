import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RecordingSource } from "../playback.js";
import { ProtocolReceiver } from "../protocol.js";
import { LiveSource } from "../sources.js";

const mapping = JSON.stringify({ type: "mapping", version: 1, groups: [{ id: 0, name: "PN" }], nodes: [{ id: 7, group: 0 }], edges: [[7, 7]] });
const fire = t => JSON.stringify({ type: "fire", t, pairs: [[7, 7]] });
const recording = (...lines) => new Blob([lines.join("\n")]);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  const receiver = new ProtocolReceiver();
  const events = [];
  const statuses = [];
  const resets = [];
  const source = new RecordingSource(receiver, {
    onEvent: event => events.push(event),
    onStatus: status => statuses.push(status),
    onReset: () => resets.push(receiver.mapping),
  });
  t.after(() => source.disconnect());
  return {
    receiver, source, events, statuses, resets,
    async advance(ms) {
      await flush();
      now += ms;
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}

test("paced reference playback matches live validation, including replacement epochs and gaps in t", async t => {
  const h = harness(t);
  const content = await readFile(new URL("../../protocol/v1/fixtures/reference.ndjson", import.meta.url), "utf8");
  const expected = JSON.parse(await readFile(new URL("../../protocol/v1/fixtures/reference.expected.json", import.meta.url), "utf8"));
  let socket;
  const liveEvents = [];
  const live = new LiveSource(new ProtocolReceiver(), { onEvent: event => liveEvents.push(event) }, class {
    constructor() { socket = this; }
    close() {}
  });
  live.connect("ws://localhost/stream");
  for (const line of content.trim().split("\n")) socket.onmessage({ data: line });
  live.disconnect();
  const done = h.source.load(new Blob([content]));
  await flush();
  assert.deepEqual(h.events, expected.events.slice(0, 2));
  await h.advance(499);
  assert.equal(h.receiver.lastT, 0);
  await h.advance(1);
  assert.equal(h.receiver.lastT, 2);
  await h.advance(500);
  await done;
  assert.deepEqual(h.events, expected.events);
  assert.deepEqual(h.events, liveEvents);
  assert.equal(h.receiver.epoch, 1);
  assert.equal(h.source.state, "finished");
});

test("pausing freezes receiver state and resume preserves the unspent interval", async t => {
  const h = harness(t);
  const done = h.source.load(recording(mapping, fire(0), fire(1000)));
  await flush();
  await h.advance(150);
  h.source.pause();
  assert.equal(h.source.state, "paused");
  await h.advance(2000);
  assert.equal(h.receiver.lastT, 0);
  assert.equal(h.events.length, 2);
  h.source.play();
  await h.advance(349);
  assert.equal(h.receiver.lastT, 0);
  await h.advance(1);
  await done;
  assert.equal(h.receiver.lastT, 1000);
  assert.equal(h.source.state, "finished");
});

test("changing speed reschedules an active wait and also applies while paused", async t => {
  const h = harness(t);
  const done = h.source.load(recording(mapping, fire(0), fire(1), fire(2)));
  await flush();
  assert.equal(h.source.speed, 1);
  await h.advance(100);
  h.source.setSpeed(2);
  await h.advance(199);
  assert.equal(h.receiver.lastT, 0);
  await h.advance(1);
  assert.equal(h.receiver.lastT, 1);
  await h.advance(50);
  h.source.pause();
  h.source.setSpeed(0.5);
  await h.advance(1000);
  assert.equal(h.receiver.lastT, 1);
  h.source.play();
  await h.advance(799);
  assert.equal(h.receiver.lastT, 1);
  await h.advance(1);
  await done;
  assert.equal(h.receiver.lastT, 2);
});

test("pausing a pending read gates its first mapping until playback resumes", async t => {
  const h = harness(t);
  let controller;
  const file = { stream: () => new ReadableStream({ start(value) { controller = value; } }) };
  const done = h.source.load(file);
  h.source.pause();
  controller.enqueue(new TextEncoder().encode(`${mapping}\n${fire(0)}`));
  controller.close();
  await flush();
  assert.equal(h.receiver.mapping, null);
  assert.deepEqual(h.events, []);
  h.source.play();
  await done;
  assert.equal(h.source.state, "finished");
  assert.equal(h.receiver.lastT, 0);
});

test("pausing from a mapping callback stops the next message before validation", async t => {
  const h = harness(t);
  h.source.onEvent = event => {
    h.events.push(event);
    if (event.action === "replace_mapping") h.source.pause();
  };
  const done = h.source.load(recording(mapping, fire(0), fire(1)));
  await flush();
  assert.equal(h.source.state, "paused");
  assert.equal(h.receiver.epoch, 0);
  assert.equal(h.receiver.lastT, null);
  await h.advance(5000);
  assert.deepEqual(h.events.map(event => event.action), ["replace_mapping"]);
  assert.equal(h.receiver.lastT, null);
  h.source.play();
  await flush();
  assert.equal(h.receiver.lastT, 0);
  await h.advance(500);
  await done;
  assert.equal(h.receiver.lastT, 1);
  assert.equal(h.source.state, "finished");
});

test("invalid playback speeds leave the current speed unchanged", t => {
  const h = harness(t);
  h.source.setSpeed(2);
  for (const speed of [0, -1, Infinity, NaN, "2", null]) {
    assert.throws(() => h.source.setSpeed(speed), RangeError);
    assert.equal(h.source.speed, 2);
  }
});

test("restart resets the receiver and graph before replaying from the first mapping", async t => {
  const h = harness(t);
  const file = recording(mapping, fire(0), fire(1));
  const firstRun = h.source.load(file);
  await flush();
  await h.advance(200);
  h.source.pause();
  const resetCount = h.resets.length;
  const restarted = h.source.restart();
  await flush();
  assert.equal(h.source.file, file);
  assert.equal(h.source.state, "playing");
  assert.ok(h.resets.length > resetCount);
  assert.ok(h.resets.every(value => value === null));
  assert.equal(h.receiver.epoch, 0);
  assert.equal(h.receiver.lastT, 0);
  assert.deepEqual(h.events.map(event => event.action), ["replace_mapping", "accept_fire", "replace_mapping", "accept_fire"]);
  await h.advance(500);
  await Promise.all([firstRun, restarted]);
  assert.equal(h.source.state, "finished");
  assert.equal(h.receiver.lastT, 1);
});

test("disconnect cancels a queued fire without disturbing a subsequently connected source", async t => {
  const h = harness(t);
  const done = h.source.load(recording(mapping, fire(0), fire(1)));
  await flush();
  h.source.disconnect();
  assert.equal(h.source.state, "empty");
  assert.equal(h.receiver.mapping, null);
  h.receiver.process(mapping);
  h.receiver.process(fire(99));
  const eventCount = h.events.length;
  await h.advance(2000);
  await done;
  assert.equal(h.receiver.lastT, 99);
  assert.equal(h.events.length, eventCount);
});

test("late reads from rapid restarts cannot advance or finish the newest source", async t => {
  const h = harness(t);
  const reads = [];
  let cancellations = 0;
  const file = { stream: () => ({ getReader() {
    let resolve;
    const read = new Promise(done => { resolve = done; });
    reads.push(resolve);
    return { read: () => read, cancel: async () => { cancellations++; }, releaseLock() {} };
  } }) };
  const first = h.source.load(file);
  await flush();
  const second = h.source.restart();
  await flush();
  const third = h.source.restart();
  await flush();
  assert.equal(reads.length, 3);
  reads[0]({ value: new TextEncoder().encode(`${mapping}\n${fire(80)}\n`), done: false });
  reads[1]({ value: new TextEncoder().encode(`${mapping}\n${fire(90)}\n`), done: false });
  await Promise.all([first, second]);
  assert.equal(h.source.state, "playing");
  assert.equal(h.receiver.mapping, null);
  assert.deepEqual(h.events, []);
  reads[2]({ value: new TextEncoder().encode(`${mapping}\n${fire(0)}`), done: true });
  await third;
  assert.equal(h.source.state, "finished");
  assert.equal(h.receiver.lastT, 0);
  assert.ok(cancellations >= 2);
});

test("loading another recording cancels a pending read and retains the new mapping", async t => {
  const h = harness(t);
  let cancelled = false;
  const waiting = h.source.load({ stream: () => new ReadableStream({ cancel() { cancelled = true; } }) });
  await flush();
  await h.source.load(recording(mapping, fire(12)));
  await waiting;
  assert.equal(cancelled, true);
  assert.equal(h.source.state, "finished");
  assert.equal(h.receiver.lastT, 12);
  await h.advance(1000);
  assert.equal(h.receiver.lastT, 12);
});

test("malformed lines recover through the same validator without delaying valid fire events", async t => {
  const h = harness(t);
  const done = h.source.load(recording("{", fire(99), mapping, fire(0), "{", fire(0), fire(100)));
  await flush();
  assert.equal(h.receiver.lastT, 0);
  await h.advance(500);
  await done;
  assert.deepEqual(h.events.map(event => event.action), ["drop_message", "drop_message", "replace_mapping", "accept_fire", "drop_message", "drop_message", "accept_fire"]);
  assert.equal(h.receiver.lastT, 100);
  assert.equal(h.source.state, "finished");
});

test("empty or unusable recordings report an error and clear the receiver", async t => {
  const h = harness(t);
  for (const file of [recording(), recording("{", fire(0)), recording('{"type":"future"}')]) {
    await h.source.load(file);
    assert.equal(h.source.state, "error");
    assert.equal(h.receiver.mapping, null);
    assert.equal(h.receiver.lastT, null);
    assert.ok(h.statuses.at(-1).message.length > 0);
  }
});

test("a valid mapping without fire events remains a usable finished recording", async t => {
  const h = harness(t);
  await h.source.load(recording(mapping));
  assert.equal(h.source.state, "finished");
  assert.equal(h.receiver.epoch, 0);
  assert.equal(h.receiver.lastT, null);
  assert.deepEqual(h.events.map(event => event.action), ["replace_mapping"]);
});

test("an unsupported replacement stops playback and clears the graph", async t => {
  const h = harness(t);
  const done = h.source.load(recording(mapping, fire(0), '{"type":"mapping","version":2}', mapping, fire(1)));
  await flush();
  const resetCount = h.resets.length;
  await h.advance(500);
  await done;
  assert.equal(h.source.state, "unsupported");
  assert.deepEqual(h.events.at(-1), { action: "close", code: 1003 });
  assert.equal(h.receiver.mapping, null);
  assert.ok(h.resets.length > resetCount);
  await h.advance(1000);
  assert.equal(h.events.at(-1).action, "close");
});

test("read failures after a mapping are visible and clear graph state", async t => {
  const h = harness(t);
  let controller;
  const file = { stream: () => new ReadableStream({ start(value) { controller = value; } }) };
  const done = h.source.load(file);
  controller.enqueue(new TextEncoder().encode(`${mapping}\n${fire(0)}\n`));
  await flush();
  assert.equal(h.receiver.lastT, 0);
  controller.error(new Error("Read failed"));
  await done;
  assert.equal(h.source.state, "error");
  assert.match(h.statuses.at(-1).message, /Read failed/);
  assert.equal(h.receiver.mapping, null);
});
