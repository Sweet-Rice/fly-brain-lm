import test from 'node:test';
import assert from 'node:assert/strict';
import { mountReadout } from '../readout-view.js';

function fixture(t) {
  const elements = [];
  class Element extends EventTarget {
    children = [];
    style = {};
    className = '';
    textContent = '';
    attributes = new Map();
    classList = { add: name => { this.className += ` ${name}`; } };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  const createElement = () => { const el = new Element(); elements.push(el); return el; };
  const frames = new Map();
  let nextFrame = 0;
  const globals = {
    document: { createElement, createElementNS: createElement },
    window: new EventTarget(),
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const view = mountReadout(createElement(), new EventTarget());
  t.after(() => {
    view.dispose();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    view,
    el: id => elements.find(el => el.id === `readout-${id}`),
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function token(seq, overrides = {}) {
  return JSON.stringify({
    type: 'token_step', run_id: 'server', request_id: 'request', seq, epoch: 2,
    kind: 'completion', token_index: seq, token_id: seq, token_text: `token${seq}`,
    token_bytes: '61', step_status: 'unprocessed', t: -1,
    step_rel_us: 0, emit_rel_us: 0, step_ns: '0', emit_ns: '0', ...overrides,
  });
}

test('stale epochs and malformed high sequences cannot overwrite or poison current output', t => {
  const { view, el, flush } = fixture(t);
  assert.equal(view.accept(token(1)), true);
  assert.equal(view.accept(token(100, { epoch: 1 })), false);
  assert.equal(view.accept(token(100, { token_id: -1 })), false);
  assert.equal(view.accept(token(2)), true);
  flush();
  assert.equal(JSON.parse(el('text').textContent), 'token2');
  view.accept(JSON.stringify({ type: 'stream_status', run_id: 'server', seq: 3,
    epoch: 2, event: 'gap', dropped_steps: 1, server_time_ms: 0 }));
  flush();
  assert.equal(el('source-badge').getAttribute('data-source'), null);
  assert.equal(el('prev').disabled, true);
});

test('bounded history preserves a retained selection and exposes the oldest retained token', t => {
  const { view, el, flush } = fixture(t);
  for (let seq = 0; seq < 129; seq++) view.accept(token(seq));
  flush();
  el('prev').click();
  assert.equal(JSON.parse(el('text').textContent), 'token127');
  view.accept(token(129));
  flush();
  assert.equal(JSON.parse(el('text').textContent), 'token127');
  for (let clicks = 0; !el('prev').disabled && clicks < 128; clicks++) el('prev').click();
  assert.equal(JSON.parse(el('text').textContent), 'token2');
});

test('long-token piece navigation preserves Unicode and new local runs discard old token identities', t => {
  const { view, el, flush } = fixture(t);
  const text = '\0'.repeat(32) + '🧠'.repeat(64) + ' final text';
  view.accept(token(1, { token_text: text }));
  flush();
  const pieces = [JSON.parse(el('text').textContent)];
  while (!el('prev').disabled) {
    el('prev').click();
    pieces.unshift(JSON.parse(el('text').textContent));
  }
  assert.equal(pieces.join(''), text);
  assert.ok(pieces.every(piece => Array.from(JSON.stringify(piece)).length <= 34));
  view.setGeneration({ runId: 'frontend-only', text: 'local output', state: 'completed' });
  flush();
  assert.equal(el('source-badge').getAttribute('data-source'), 'local_sse');
  assert.equal(el('token-status').getAttribute('data-status'), 'local');
  assert.equal(el('token-id').textContent.includes('#'), false);
});

test('source resets cannot resurrect completed local output during a health poll', t => {
  const { view, el, flush } = fixture(t);
  const completed = { runId: 'finished', text: 'previous source', state: 'completed' };
  view.setGeneration(completed);
  view.reset();
  view.setGeneration(completed);
  flush();
  assert.equal(el('source-badge').getAttribute('data-source'), null);
  view.setGeneration({ runId: 'next', text: '', state: 'submitting' });
  view.reset();
  view.setGeneration({ runId: 'next', text: 'live text', state: 'streaming' });
  flush();
  assert.equal(el('source-badge').getAttribute('data-source'), 'local_sse');
});
