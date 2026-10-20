import test from "node:test";
import assert from "node:assert/strict";

test("recording controls reset the graph and switch cleanly between files and live input", async t => {
  class Element extends EventTarget {
    textContent = "";
    value = "";
    files = [];
    children = [];
    style = {};
    disabled = false;
    clientWidth = 800;
    clientHeight = 600;
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; }
  }
  const window = new EventTarget();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    document: { getElementById: element, createElement: () => new Element() },
    window, location: new URL("http://127.0.0.1/app/"),
    navigator: {}, isSecureContext: false, WebSocket: Socket,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    window.dispatchEvent(new Event("pagehide"));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const mapping = JSON.stringify({ type: "mapping", version: 1, groups: [{ id: 0, name: "PN" }], nodes: [{ id: 7, group: 0 }], edges: [[7, 7]] });
  const fire = t => JSON.stringify({ type: "fire", t, pairs: [[7, 7]] });
  const file = new Blob([[mapping, fire(0), fire(100)].join("\n")]);
  file.name = "example.ndjson";
  const events = [];
  for (const type of ["mapping", "fire", "reset"]) element("viewport").addEventListener(type, event => events.push({ type, detail: event.detail }));
  await import("../main.js");
  const click = id => element(id).dispatchEvent(new Event("click"));
  const settle = async predicate => {
    for (let i = 0; i < 20 && !predicate(); i++) await new Promise(setImmediate);
    assert.ok(predicate(), "expected UI state did not arrive");
  };
  element("recording").files = [file];
  element("recording").dispatchEvent(new Event("change"));
  await settle(() => element("fires").textContent === 1);
  assert.equal(element("recording-pause").disabled, false);
  click("recording-pause");
  assert.equal(element("recording-play").disabled, false);
  assert.equal(element("recording-pause").disabled, true);
  assert.match(element("source-status").textContent, /paused/i);
  element("recording-speed").value = "4";
  element("recording-speed").dispatchEvent(new Event("change"));
  const beforeRestart = events.length;
  click("recording-restart");
  await settle(() => events.slice(beforeRestart).some(event => event.type === "fire"));
  const restarted = events.slice(beforeRestart);
  assert.equal(restarted[0].type, "reset");
  assert.deepEqual(restarted.filter(event => event.type === "fire").map(event => event.detail.t), [0]);
  assert.match(element("protocol-status").textContent, /epoch 0/);

  element("endpoint").value = "ws://127.0.0.1:9000/stream";
  element("connection").dispatchEvent(new Event("submit", { cancelable: true }));
  assert.equal(element("recording-restart").disabled, true);
  assert.equal(element("recording-speed").disabled, true);
  assert.equal(element("recording").value, "");
  sockets[0].onmessage({ data: mapping });
  sockets[0].onmessage({ data: fire(7) });
  assert.equal(element("step").textContent, 7);
  click("recording-play");
  await new Promise(setImmediate);
  assert.equal(element("step").textContent, 7, "old playback cannot overwrite live input");
  element("recording").dispatchEvent(new Event("change"));
  assert.equal(sockets[0].closed, true);
  await settle(() => element("step").textContent === 0);
  click("disconnect");
  assert.equal(element("nodes").textContent, 0);
  assert.equal(element("recording-play").disabled, true);
  assert.equal(element("recording-restart").disabled, true);
});
