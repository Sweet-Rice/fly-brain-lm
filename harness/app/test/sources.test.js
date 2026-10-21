import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ProtocolReceiver } from "../protocol.js";
import { LiveSource, readRecording } from "../sources.js";

const mapping = JSON.stringify({ type: "mapping", version: 1, groups: [{ id: 0, name: "PN" }], nodes: [{ id: 7, group: 0 }], edges: [[7, 7]] });
const fire = t => JSON.stringify({ type: "fire", t, pairs: [[7, 7]] });

function liveHarness() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.closes = [];
      sockets.push(this);
    }
    close(code = 1000, reason = "") {
      this.closes.push({ code, reason });
      this.onclose?.({ code, reason });
    }
    message(data) { this.onmessage({ data }); }
  }
  const receiver = new ProtocolReceiver();
  const events = [];
  const statuses = [];
  const source = new LiveSource(receiver, { onEvent: event => events.push(event), onStatus: status => statuses.push(status) }, FakeSocket);
  return { source, receiver, events, statuses, sockets };
}

test("live frames share the receiver and recover after malformed and binary frames", () => {
  const { source, receiver, sockets, events, statuses } = liveHarness();
  source.connect("ws://localhost:9000/custom");
  const socket = sockets[0];
  assert.equal(socket.url, "ws://localhost:9000/custom");
  socket.onopen();
  assert.equal(statuses.at(-1).state, "connected");
  socket.message("{");
  socket.message(new Blob([mapping]));
  socket.message(fire(0));
  socket.message(mapping);
  socket.message(fire(0));
  assert.deepEqual(events.map(event => event.action), ["drop_message", "drop_message", "drop_message", "replace_mapping", "accept_fire"]);
  assert.equal(receiver.lastT, 0);
  source.disconnect();
  assert.equal(receiver.mapping, null);
  assert.equal(receiver.lastT, null);
  assert.equal(receiver.epoch, -1);
  assert.equal(receiver.closed, false);
});

test("one reconnect timer discards all state and ignores callbacks from old sockets", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { source, receiver, sockets, events, statuses } = liveHarness();
  source.connect("ws://localhost/stream");
  const first = sockets[0];
  first.message(mapping);
  first.message(fire(12));
  first.onerror();
  assert.equal(statuses.at(-1).state, "error");
  first.onclose({ code: 1006, reason: "server stopped" });
  first.onclose({ code: 1006, reason: "duplicate callback" });
  assert.equal(receiver.mapping, null);
  assert.equal(receiver.lastT, null);
  assert.equal(receiver.epoch, -1);
  assert.equal(statuses.at(-1).state, "reconnecting");
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  const count = events.length;
  first.message(mapping);
  first.onopen();
  first.onerror();
  assert.equal(events.length, count);
  assert.equal(statuses.at(-1).state, "connecting");
  sockets[1].message(fire(13));
  assert.equal(events.at(-1).action, "drop_message");
  sockets[1].message(mapping);
  sockets[1].message(fire(0));
  assert.equal(receiver.epoch, 0);
  assert.equal(receiver.lastT, 0);
  source.disconnect();
});

test("manual disconnect cancels retries and changing endpoint ignores old connections", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { source, receiver, sockets } = liveHarness();
  source.connect("ws://localhost/first");
  sockets[0].onclose({ code: 1006 });
  source.disconnect();
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 1);
  source.connect("ws://localhost/second");
  source.connect("ws://localhost/third");
  sockets[1].message(mapping);
  assert.equal(receiver.mapping, null);
  assert.equal(sockets[2].url, "ws://localhost/third");
  source.disconnect();
});

test("unsupported versions report 1003, send browser-legal 4001, and never retry", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { source, receiver, sockets, statuses, events } = liveHarness();
  source.connect("ws://localhost/stream");
  sockets[0].message(mapping);
  sockets[0].message('{"type":"mapping","version":2}');
  assert.deepEqual(events.at(-1), { action: "close", code: 1003 });
  assert.equal(sockets[0].closes[0].code, 4001);
  assert.equal(statuses.at(-1).state, "unsupported");
  assert.equal(receiver.mapping, null);
  sockets[0].message(mapping);
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 1);
  assert.equal(events.at(-1).action, "close");
});

test("a constructor failure is visible and leaves a clean receiver", () => {
  const receiver = new ProtocolReceiver();
  receiver.process(mapping);
  const statuses = [];
  const source = new LiveSource(receiver, { onStatus: status => statuses.push(status) }, class {
    constructor() { throw new Error("Invalid WebSocket URL"); }
  });
  source.connect("invalid");
  assert.equal(statuses.at(-1).state, "error");
  assert.match(statuses.at(-1).message, /Invalid WebSocket URL/);
  assert.equal(receiver.mapping, null);
});

function visibilityDocument(t, hidden = false) {
  const document = new EventTarget();
  document.hidden = hidden;
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });
  return visible => {
    document.hidden = !visible;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

test("hidden live tabs disconnect and resume with a fresh mapping, ignoring stale callbacks", t => {
  const visibility = visibilityDocument(t);
  const { source, receiver, sockets, events, statuses } = liveHarness();
  source.connect("ws://localhost/stream");
  const old = sockets[0];
  old.message(mapping);
  old.message(fire(99));
  visibility(false);
  assert.equal(old.closes.length, 1);
  assert.equal(source.url, "ws://localhost/stream");
  assert.equal(source.socket, null);
  assert.equal(receiver.mapping, null);
  assert.equal(statuses.at(-1).state, "background");
  const count = events.length;
  old.message(mapping);
  old.onopen();
  old.onerror();
  old.onclose({ code: 1006 });
  assert.equal(events.length, count);
  assert.equal(statuses.at(-1).state, "background");
  visibility(true);
  assert.equal(sockets.length, 2);
  sockets[1].message(fire(100));
  assert.equal(events.at(-1).action, "drop_message");
  sockets[1].message(mapping);
  sockets[1].message(fire(0));
  assert.equal(receiver.lastT, 0);
  source.dispose();
});

test("connecting while hidden waits for visibility and manual disconnect cancels resumption", t => {
  const visibility = visibilityDocument(t, true);
  const { source, sockets, statuses } = liveHarness();
  source.connect("ws://localhost/stream");
  assert.equal(sockets.length, 0);
  assert.equal(statuses.at(-1).state, "background");
  visibility(true);
  assert.equal(sockets.length, 1);
  visibility(false);
  source.disconnect();
  visibility(true);
  assert.equal(sockets.length, 1);
  source.dispose();
});

test("hiding cancels pending retries and disposal removes the visibility listener", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = visibilityDocument(t);
  const { source, sockets } = liveHarness();
  source.connect("ws://localhost/stream");
  sockets[0].onclose({ code: 1006 });
  visibility(false);
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 1);
  visibility(true);
  assert.equal(sockets.length, 2);
  source.dispose();
  const url = "ws://localhost/unused";
  source.url = url;
  visibility(false);
  visibility(true);
  assert.equal(sockets.length, 2);
  assert.equal(source.url, url);
});

test("the checked-in recording produces the same receiver events from live and file inputs", async () => {
  const content = await readFile(new URL("../../protocol/v1/fixtures/reference.ndjson", import.meta.url), "utf8");
  const expected = JSON.parse(await readFile(new URL("../../protocol/v1/fixtures/reference.expected.json", import.meta.url), "utf8"));
  const recordedEvents = [];
  const receiver = new ProtocolReceiver();
  receiver.process(mapping);
  receiver.process(fire(99));
  const result = await readRecording(new Blob([content]), receiver, event => recordedEvents.push(event));
  assert.deepEqual(recordedEvents, expected.events);
  assert.equal(result.unsupported, false);
  assert.equal(result.aborted, false);
  const { source, sockets, events } = liveHarness();
  source.connect("ws://localhost/stream");
  for (const line of content.trim().split("\n")) sockets[0].message(line);
  assert.deepEqual(events, recordedEvents);
  source.disconnect();
});

test("file reading spans UTF-8 chunks, CRLF and a final line without newline, recovering after malformed lines", async () => {
  const unicodeMapping = mapping.replace("PN", "神経");
  const bytes = new TextEncoder().encode(`${unicodeMapping}\r\n{\n\n${fire(0)}`);
  const split = bytes.indexOf(0xe7) + 1;
  const file = { stream: () => new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split, split + 1));
      controller.enqueue(bytes.slice(split + 1));
      controller.close();
    },
  }) };
  const receiver = new ProtocolReceiver();
  const events = [];
  const result = await readRecording(file, receiver, event => events.push(event));
  assert.equal(receiver.mapping.groups[0].name, "神経");
  assert.deepEqual(events.map(event => event.action), ["replace_mapping", "drop_message", "accept_fire"]);
  assert.equal(result.lines, 4);
  assert.equal(result.events, 3);
});

test("file reading stops at unsupported versions", async () => {
  const receiver = new ProtocolReceiver();
  const events = [];
  const result = await readRecording(new Blob([`${mapping}\n{"type":"mapping","version":2}\n${fire(0)}\n`]), receiver, event => events.push(event));
  assert.equal(result.unsupported, true);
  assert.equal(result.events, 2);
  assert.equal(receiver.closed, true);
  assert.deepEqual(events.at(-1), { action: "close", code: 1003 });
});

test("aborting a pending file read cancels it without resetting the new source state", async () => {
  let cancelled = false;
  const file = { stream: () => new ReadableStream({ cancel() { cancelled = true; } }) };
  const receiver = new ProtocolReceiver();
  const controller = new AbortController();
  const events = [];
  const read = readRecording(file, receiver, event => events.push(event), { signal: controller.signal });
  controller.abort();
  receiver.reset();
  receiver.process(mapping);
  receiver.process(fire(9));
  const result = await read;
  assert.equal(cancelled, true);
  assert.equal(result.aborted, true);
  assert.equal(receiver.lastT, 9);
  assert.deepEqual(events, []);
});

test("aborting while processing a chunk prevents remaining events", async () => {
  const receiver = new ProtocolReceiver();
  const controller = new AbortController();
  const events = [];
  const result = await readRecording(new Blob([`${mapping}\n${fire(0)}\n${fire(1)}`]), receiver, event => {
    events.push(event);
    controller.abort();
  }, { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(events.length, 1);
});

test("large recordings yield so cancellation from the UI can run", async () => {
  const receiver = new ProtocolReceiver();
  const controller = new AbortController();
  const events = [];
  const content = [mapping, ...Array.from({ length: 1000 }, (_, t) => fire(t))].join("\n");
  const result = await readRecording(new Blob([content]), receiver, event => {
    events.push(event);
    if (events.length === 1) setTimeout(() => controller.abort(), 0);
  }, { signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(events.length, 500);
});

test("an already cancelled recording does not disturb an active receiver", async () => {
  const receiver = new ProtocolReceiver();
  receiver.process(mapping);
  receiver.process(fire(4));
  const result = await readRecording(new Blob([mapping]), receiver, () => assert.fail("unexpected event"), { signal: AbortSignal.abort() });
  assert.equal(result.aborted, true);
  assert.equal(receiver.lastT, 4);
});

test("file I/O errors propagate so the UI can report them", async () => {
  const file = { stream: () => new ReadableStream({ start(controller) { controller.error(new Error("Read failed")); } }) };
  await assert.rejects(readRecording(file, new ProtocolReceiver(), () => {}), /Read failed/);
});
