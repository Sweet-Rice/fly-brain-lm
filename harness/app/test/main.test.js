import test from "node:test";
import assert from "node:assert/strict";

test("recording controls reset the graph and switch cleanly between files and live input", async t => {
  const elements = new Map();
  class Element extends EventTarget {
    _id = "";
    get id() { return this._id; }
    set id(val) {
      this._id = String(val ?? "");
      if (this._id) elements.set(this._id, this);
    }
    tagName = "DIV";
    className = "";
    textContent = "";
    _value = "";
    get value() { return this._value; }
    set value(v) {
      this._value = String(v ?? "");
      if (this._value === "") this.files = [];
    }
    files = [];
    children = [];
    style = {};
    attributes = new Map();
    dataset = {};
    disabled = false;
    hidden = false;
    type = "";
    rows = 0;
    min = "";
    max = "";
    step = "";
    placeholder = "";
    tabIndex = 0;
    noValidate = false;
    htmlFor = "";
    autocomplete = "";
    clientWidth = 800;
    clientHeight = 600;
    classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
    };

    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }

    append(...children) {
      for (const child of children) {
        if (child) {
          this.children.push(child);
          child.parentElement = this;
        }
      }
    }
    appendChild(child) {
      if (child) {
        this.children.push(child);
        child.parentElement = this;
      }
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentElement = null;
      }
      return child;
    }
    replaceChildren(...children) {
      this.children = children.filter(Boolean);
      for (const child of this.children) {
        child.parentElement = this;
      }
    }
    focus() {}
    blur() {}
    select() {}
    get form() {
      let curr = this.parentElement;
      while (curr) {
        if (curr.tagName === "FORM") return curr;
        curr = curr.parentElement;
      }
      return null;
    }
    click() {
      this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
      if (this.type === "submit" && this.form) {
        this.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }
    getElementById(id) {
      const search = el => {
        if (el.id === id) return el;
        for (const child of el.children || []) {
          const found = search(child);
          if (found) return found;
        }
        return null;
      };
      return search(this);
    }
  }

  const element = id => {
    if (!elements.has(id)) {
      const el = new Element();
      el.id = id;
    }
    return elements.get(id);
  };

  const sockets = [];
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.closed = false;
      sockets.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }

  let apiAvailable = false;
  const stubFetch = async (input) => {
    const url = String(input);
    if (url.includes("/health")) {
      if (!apiAvailable) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: h => h.toLowerCase() === "content-type" ? "application/json" : null },
          json: async () => ({ status: "unavailable" }),
          text: async () => JSON.stringify({ status: "unavailable" }),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: h => h.toLowerCase() === "content-type" ? "application/json" : null },
        json: async () => ({ status: "ok", model: "vibe2" }),
        text: async () => JSON.stringify({ status: "ok", model: "vibe2" }),
      };
    }
    if (url.includes("/v1/completions")) {
      if (!apiAvailable) {
        return {
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: { get: h => h.toLowerCase() === "content-type" ? "application/json" : null },
          json: async () => ({ error: { message: "Model unavailable" } }),
          text: async () => JSON.stringify({ error: { message: "Model unavailable" } }),
        };
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"text\":\"Hello fly\"}],\"model\":\"vibe2\"}\n\ndata: [DONE]\n\n"));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: h => h.toLowerCase() === "content-type" ? "text/event-stream" : null },
        body: stream,
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "",
    };
  };

  const docBody = new Element();
  docBody.tagName = "BODY";
  const doc = {
    body: docBody,
    getElementById: element,
    createElement: (tag = "div") => {
      const el = new Element();
      el.tagName = tag.toUpperCase();
      el.ownerDocument = doc;
      return el;
    },
    createElementNS: (namespace, tag) => {
      const el = doc.createElement(tag);
      el.namespaceURI = namespace;
      return el;
    },
    execCommand: () => true,
  };
  docBody.ownerDocument = doc;

  const window = new EventTarget();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    document: doc,
    window,
    location: new URL("http://127.0.0.1/app/"),
    navigator: {},
    isSecureContext: false,
    WebSocket: Socket,
    fetch: stubFetch,
    requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  t.after(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await new Promise(setImmediate);
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
  element("recording").files = [file];
  element("recording").dispatchEvent(new Event("change"));
  assert.equal(sockets[0].closed, true);
  await settle(() => element("step").textContent === 0);
  click("disconnect");
  assert.equal(element("nodes").textContent, 0);
  assert.equal(element("recording-play").disabled, true);
  assert.equal(element("recording-restart").disabled, true);
  // Integration regression: generate from recorded mode cannot leave old file modifying live graph
  element("recording").files = [file];
  element("recording").dispatchEvent(new Event("change"));
  await settle(() => element("fires").textContent === 1);
  assert.equal(element("recording-pause").disabled, false);

  apiAvailable = true;
  click("prompt-health-retry-btn");
  await settle(() => element("prompt-generate-btn").disabled === false);

  element("prompt-input").value = "Analyze fly connectome";
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise(setImmediate);

  // File recording controls are cleared and playback stopped
  assert.equal(element("recording").value, "");
  assert.equal(element("recording-play").disabled, true);
  assert.equal(element("recording-restart").disabled, true);
  assert.equal(element("recording-speed").disabled, true);

  // Old file playback cannot modify the graph after generation switch
  click("recording-play");
  await new Promise(setImmediate);
  assert.equal(element("step").textContent, "—", "old file playback cannot modify live graph after generate");

  // New live endpoint receives updates
  const activeLiveSocket = sockets.at(-1);
  assert.equal(activeLiveSocket.url, "ws://127.0.0.1:9000/stream");
  activeLiveSocket.onmessage({ data: mapping });
  activeLiveSocket.onmessage({ data: fire(88) });
  await settle(() => element("step").textContent === 88);
  assert.equal(element("step").textContent, 88);

  // Another generation while already connected to the same live endpoint does not reset live graph
  const socketCount = sockets.length;
  element("prompt-input").value = "Second query";
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise(setImmediate);
  assert.equal(sockets.length, socketCount, "no new socket created when live already connected to same endpoint");
  assert.equal(element("step").textContent, 88, "live graph not reset when prompt generated on same live connection");

  await settle(() => element("prompt-output").textContent.includes("Hello fly"));
  assert.ok(element("prompt-output").textContent.includes("Hello fly"));
});
