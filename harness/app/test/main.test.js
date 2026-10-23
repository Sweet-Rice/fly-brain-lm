import test from "node:test";
import assert from "node:assert/strict";

test("a bare app entry auto-connects its configured stream and gates requests on a mapping", async t => {
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

  let completionRequests = 0;
  const stubFetch = async input => {
    const url = String(input);
    if (url === "/app-config") {
      return Response.json({ stream_url: "/stream" });
    }
    if (url === "/health") return Response.json({ status: "ok", model: "vibe2" });
    if (url === "/v1/completions") {
      completionRequests++;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Hello fly"}],"model":"vibe2"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected app request: ${url}`);
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
  await import("../main.js");
  const settle = async predicate => {
    for (let i = 0; i < 30 && !predicate(); i++) await new Promise(setImmediate);
    assert.ok(predicate(), "expected UI state did not arrive");
  };
  await settle(() => sockets.length === 1);
  const socket = sockets[0];
  assert.equal(element("prompt-generate-btn").disabled, true, "API health alone cannot enable generation");
  element("prompt-input").value = "Analyze fly connectome";
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise(setImmediate);
  assert.equal(completionRequests, 0, "no generation before a graph mapping is accepted");

  socket.onopen();
  socket.onmessage({ data: mapping });
  await settle(() => element("prompt-generate-btn").disabled === false);
  socket.onmessage({ data: fire(7) });
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await settle(() => completionRequests === 1 && !element("prompt-generate-btn").disabled);
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await settle(() => completionRequests === 2 && !element("prompt-generate-btn").disabled);
  assert.equal(sockets.length, 1, "repeated generation preserves the live connection");
  assert.equal(element("step").textContent, 7, "generation does not reset accepted graph activity");

  socket.onclose({ code: 1006, reason: "" });
  assert.equal(element("prompt-generate-btn").disabled, true);
  assert.equal(element("nodes").textContent, 0);
  element("prompt-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise(setImmediate);
  assert.equal(completionRequests, 2, "disconnection blocks new model requests");
});
