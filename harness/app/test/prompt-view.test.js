import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationController,
  GENERATION_STATES,
} from '../generation.js';
import {
  mountPrompt,
  paginateText,
  PROMPT_DOM_IDS,
} from '../prompt-view.js';

test('output pages respect wrapped lines and preserve astral Unicode and whitespace', () => {
  const text = '🧠界ab🪰cdefghijklmnop\r\n\t末尾';
  const pages = paginateText(text, 2, 7, 2);
  assert.equal(pages[0], '🧠界ab');
  assert.equal(pages.join(''), text);
  assert.ok(pages.every(page => page.isWellFormed() && [...page].length <= 7));
});

class MockElement extends EventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.type = '';
    this.placeholder = '';
    this.autocomplete = '';
    this.noValidate = false;
    this.htmlFor = '';
    this.rows = 0;
    this.min = '';
    this.max = '';
    this.step = '';
    this.tabIndex = 0;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.get(k);
  }

  hasAttribute(k) {
    return this.attributes.has(k);
  }

  removeAttribute(k) {
    this.attributes.delete(k);
  }

  querySelector(selector) {
    const search = el => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (el.className && el.className.split(/\s+/).includes(cls)) return el;
      } else if (selector.startsWith('[')) {
        const match = selector.match(/\[([a-zA-Z0-9_-]+)(?:=['"]?([^'"]+)['"]?)?\]/);
        if (match) {
          const attr = match[1];
          const val = match[2];
          if (val !== undefined ? el.getAttribute(attr) === val : el.hasAttribute(attr)) return el;
        }
      }
      for (const child of el.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this);
  }

  querySelectorAll(selector) {
    const results = [];
    const search = el => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        if (el.className && el.className.split(/\s+/).includes(cls)) results.push(el);
      } else if (selector.startsWith('[')) {
        const match = selector.match(/\[([a-zA-Z0-9_-]+)(?:=['"]?([^'"]+)['"]?)?\]/);
        if (match) {
          const attr = match[1];
          const val = match[2];
          if (val !== undefined ? el.getAttribute(attr) === val : el.hasAttribute(attr)) results.push(el);
        }
      }
      for (const child of el.children) {
        search(child);
      }
    };
    search(this);
    return results;
  }

  append(...children) {
    for (const child of children) {
      if (child) this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = children.filter(Boolean);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    return child;
  }

  select() {}

  click() {
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }

  getElementById(id) {
    const search = el => {
      if (el.id === id) return el;
      for (const child of el.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    };
    return search(this);
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
    this.body.ownerDocument = this;
  }

  createElement(tag) {
    const el = new MockElement(tag);
    el.ownerDocument = this;
    return el;
  }

  execCommand() {
    return true;
  }
}

function createDOM() {
  const doc = new MockDocument();
  const root = doc.createElement('div');
  return { doc, root };
}

function createMockReadableStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const item = chunks[index++];
        controller.enqueue(typeof item === 'string' ? new TextEncoder().encode(item) : item);
      } else {
        controller.close();
      }
    },
  });
}

test('Typed API key reaches health retry and clear removes header', async () => {
  const { root } = createDOM();
  const capturedHealthHeaders = [];

  const mockFetch = async (url, options = {}) => {
    if (url.includes('/health')) {
      capturedHealthHeaders.push({ ...options.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', model: 'test-model' }),
      };
    }
    return {
      ok: true,
      status: 200,
      body: createMockReadableStream(['data: [DONE]\n\n']),
    };
  };

  const controller = new GenerationController({
    fetch: mockFetch,
    endpoint: '/v1/completions',
    healthEndpoint: '/health',
  });

  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const apiKeyInput = root.getElementById(PROMPT_DOM_IDS.API_KEY);
  const retryBtn = root.getElementById(PROMPT_DOM_IDS.HEALTH_RETRY_BTN);

  // Type API key
  apiKeyInput.value = 'my-secret-key-1';
  apiKeyInput.dispatchEvent(new Event('input'));
  apiKeyInput.dispatchEvent(new Event('change'));

  // Click Retry Health
  retryBtn.click();
  await new Promise(r => setTimeout(r, 10));

  assert.ok(capturedHealthHeaders.length > 0);
  const lastHeaders = capturedHealthHeaders.at(-1);
  assert.equal(lastHeaders['Authorization'], 'Bearer my-secret-key-1');

  // Clear API key
  apiKeyInput.value = '';
  apiKeyInput.dispatchEvent(new Event('input'));
  apiKeyInput.dispatchEvent(new Event('change'));

  // Click Retry Health again
  retryBtn.click();
  await new Promise(r => setTimeout(r, 10));

  const afterClearHeaders = capturedHealthHeaders.at(-1);
  assert.equal(afterClearHeaders['Authorization'], undefined);

  dispose();
});

test('Keyboard shortcut ignores repeated keydown and IME composition', async () => {
  const { root } = createDOM();
  let submitCount = 0;

  const controller = new GenerationController({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', model: 'test-model' }),
      body: createMockReadableStream(['data: [DONE]\n\n']),
    }),
  });
  controller.health = { status: 'ready', ready: true, message: 'Model ready' };
  controller.submit = async () => {
    submitCount++;
    return { success: true };
  };

  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const input = root.getElementById(PROMPT_DOM_IDS.INPUT);

  // Repeated Ctrl+Enter
  const repeatEvent = new Event('keydown', { bubbles: true, cancelable: true });
  repeatEvent.key = 'Enter';
  repeatEvent.ctrlKey = true;
  repeatEvent.repeat = true;
  repeatEvent.isComposing = false;
  input.dispatchEvent(repeatEvent);
  assert.equal(submitCount, 0, 'Repeated keydown must not submit');

  // IME composing Ctrl+Enter
  const imeEvent = new Event('keydown', { bubbles: true, cancelable: true });
  imeEvent.key = 'Enter';
  imeEvent.ctrlKey = true;
  imeEvent.repeat = false;
  imeEvent.isComposing = true;
  input.dispatchEvent(imeEvent);
  assert.equal(submitCount, 0, 'IME composing keydown must not submit');

  // Plain Enter
  const plainEnter = new Event('keydown', { bubbles: true, cancelable: true });
  plainEnter.key = 'Enter';
  plainEnter.ctrlKey = false;
  plainEnter.metaKey = false;
  plainEnter.repeat = false;
  plainEnter.isComposing = false;
  input.dispatchEvent(plainEnter);
  assert.equal(submitCount, 0, 'Plain Enter must not submit');

  // Valid Ctrl+Enter
  const ctrlEnter = new Event('keydown', { bubbles: true, cancelable: true });
  ctrlEnter.key = 'Enter';
  ctrlEnter.ctrlKey = true;
  ctrlEnter.repeat = false;
  ctrlEnter.isComposing = false;
  input.dispatchEvent(ctrlEnter);
  assert.equal(submitCount, 1, 'Valid Ctrl+Enter must submit');

  // Valid Cmd+Enter
  const cmdEnter = new Event('keydown', { bubbles: true, cancelable: true });
  cmdEnter.key = 'Enter';
  cmdEnter.metaKey = true;
  cmdEnter.repeat = false;
  cmdEnter.isComposing = false;
  input.dispatchEvent(cmdEnter);
  assert.equal(submitCount, 2, 'Valid Cmd+Enter must submit');

  dispose();
});

test('Copy button rapid repeat feedback resets timer and restores constant label', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root } = createDOM();

  let clipboardText = '';
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: {
      writeText: async text => {
        clipboardText = text;
      },
    },
  } });

  t.after(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  });

  const controller = new GenerationController();
  controller.text = 'Sample output for copying';

  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const copyBtn = root.getElementById(PROMPT_DOM_IDS.COPY_BTN);

  const copyLabel = copyBtn.textContent;
  assert.equal(copyBtn.disabled, false);

  // First click
  copyBtn.click();
  await new Promise(r => setImmediate(r));
  assert.notEqual(copyBtn.textContent, copyLabel);
  assert.equal(clipboardText, 'Sample output for copying');

  // Advance partway
  t.mock.timers.tick(500);

  // Second rapid click before timeout finishes
  copyBtn.click();
  await new Promise(r => setImmediate(r));

  // Advance timer beyond 1500ms
  t.mock.timers.tick(1600);

  // Button reverts to constant label, never stuck at 'Copied!'
  assert.equal(copyBtn.textContent, copyLabel);

  dispose();
});

test('Clear action clears prompt input and output when inactive and is disabled while active', async () => {
  const { root } = createDOM();

  const controller = new GenerationController();
  controller.health = { status: 'ready', ready: true, message: 'Ready' };
  controller.text = 'Some generated text';
  controller.state = GENERATION_STATES.COMPLETED;

  const dispose = mountPrompt(root, {
    controller,
    pollHealth: false,
    defaultPrompt: 'Initial prompt text',
  });

  const promptInput = root.getElementById(PROMPT_DOM_IDS.INPUT);
  const outputPre = root.getElementById(PROMPT_DOM_IDS.OUTPUT);
  const clearBtn = root.getElementById(PROMPT_DOM_IDS.CLEAR_BTN);

  assert.equal(promptInput.value, 'Initial prompt text');
  assert.equal(outputPre.textContent, 'Some generated text');
  assert.equal(clearBtn.disabled, false);

  // Click clear while idle/completed
  clearBtn.click();

  assert.equal(promptInput.value, '', 'Prompt input should be cleared');
  assert.equal(outputPre.textContent, '', 'Output display should be cleared');
  assert.equal(controller.getState().text, '', 'Controller state text should be cleared');

  // When generation is active, clear button must be disabled
  controller.state = GENERATION_STATES.STREAMING;
  controller.notify();
  assert.equal(clearBtn.disabled, true);

  // Attempting to click while active does not change input or state
  promptInput.value = 'Still active prompt';
  clearBtn.click();
  assert.equal(promptInput.value, 'Still active prompt');

  dispose();
});

test('Readiness gates Generate submission and Cancel button controls active run', async () => {
  const { root } = createDOM();
  let submitCalled = false;
  let cancelCalled = false;

  const controller = new GenerationController();
  controller.health = { status: 'error', ready: false, message: 'Unhealthy' };
  controller.submit = async () => {
    submitCalled = true;
    return { success: true };
  };
  controller.cancel = () => {
    cancelCalled = true;
    controller.state = GENERATION_STATES.CANCELLED;
    controller.notify();
  };

  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const generateBtn = root.getElementById(PROMPT_DOM_IDS.GENERATE_BTN);
  const cancelBtn = root.getElementById(PROMPT_DOM_IDS.CANCEL_BTN);
  const form = root.getElementById(PROMPT_DOM_IDS.FORM);

  // Unready: Generate is disabled and submit event is ignored
  assert.equal(generateBtn.disabled, true);
  assert.equal(cancelBtn.disabled, true);

  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(submitCalled, false, 'Should not submit when health is not ready');

  // Update health to ready
  controller.health = { status: 'ready', ready: true, message: 'Ready' };
  controller.notify();

  assert.equal(generateBtn.disabled, false, 'Generate button enabled when ready');

  // Simulate active run
  controller.state = GENERATION_STATES.STREAMING;
  controller.notify();

  assert.equal(generateBtn.disabled, true, 'Generate disabled during active run');
  assert.equal(cancelBtn.disabled, false, 'Cancel enabled during active run');

  // Click Cancel
  cancelBtn.click();
  assert.equal(cancelCalled, true);
  assert.equal(cancelBtn.disabled, true);
  assert.equal(generateBtn.disabled, false);

  dispose();
});

test('Injected controller is not disposed by mountPrompt disposer', () => {
  const { root } = createDOM();

  const callerController = new GenerationController({
    healthEndpoint: '/health',
  });

  let callerListenerNotified = false;
  callerController.subscribe(() => {
    callerListenerNotified = true;
  });

  const dispose = mountPrompt(root, {
    controller: callerController,
    pollHealth: false,
  });

  assert.equal(callerController.disposed, false);

  dispose();

  assert.equal(callerController.disposed, false, 'Caller controller should not be disposed');
  callerController.notify();
  assert.equal(callerListenerNotified, true, 'Caller listeners should remain intact');
});

test('Preserve action result through unrelated health updates', async t => {
  const { root } = createDOM();

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: {
      writeText: async () => {
        throw new Error('Clipboard denied');
      },
    },
  } });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  });

  const controller = new GenerationController();
  controller.text = 'Some copyable text';

  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const copyBtn = root.getElementById(PROMPT_DOM_IDS.COPY_BTN);
  const generalError = root.getElementById(PROMPT_DOM_IDS.ERROR_GENERAL);

  copyBtn.click();
  await new Promise(r => setImmediate(r));

  const clipboardFeedback = generalError.textContent;

  // Trigger unrelated health update
  controller.health = { status: 'ready', ready: true, message: 'Model healthy' };
  controller.notify();

  // General error should STILL be preserved
  assert.equal(generalError.textContent, clipboardFeedback);

  dispose();
});

test('Validation failure hides generic banner and clears stale run metadata', () => {
  const { root } = createDOM();

  const controller = new GenerationController();
  // Prior successful run metadata in controller state
  controller.currentRunId = 'run-old-999';
  controller.modelCompletionId = 'cmpl-old-abc';
  controller.usage = { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 };
  controller.finishReason = 'stop';
  controller.state = GENERATION_STATES.COMPLETED;

  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const runIdBadge = root.getElementById(PROMPT_DOM_IDS.RUN_ID);
  const usageBadge = root.getElementById(PROMPT_DOM_IDS.USAGE);
  const finishReasonBadge = root.getElementById(PROMPT_DOM_IDS.FINISH_REASON);
  const generalError = root.getElementById(PROMPT_DOM_IDS.ERROR_GENERAL);
  const promptError = root.getElementById(PROMPT_DOM_IDS.ERROR_PROMPT);

  assert.ok(runIdBadge.textContent.includes('run-old-999'));
  assert.ok(usageBadge.textContent.includes('40 total'));
  assert.ok(finishReasonBadge.textContent.includes('stop'));

  // Trigger a validation failure
  controller.state = GENERATION_STATES.FAILED;
  controller.error = 'Validation failed';
  controller.validationErrors = { prompt: 'Prompt cannot be blank' };
  controller.notify();

  assert.equal(promptError.textContent, 'Prompt cannot be blank');
  assert.equal(generalError.textContent, '', 'Generic banner must be hidden when field errors exist');
  assert.equal(runIdBadge.textContent, 'Run ID: -', 'Stale run ID must not be displayed');
  assert.equal(usageBadge.textContent, '', 'Stale usage must not be displayed');
  assert.equal(finishReasonBadge.textContent, '', 'Stale finish reason must not be displayed');

  dispose();
});

test('Terminal announcement counts Unicode codepoints accurately and ignores health polls', () => {
  const { root } = createDOM();

  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const announcement = root.getElementById(PROMPT_DOM_IDS.ANNOUNCEMENT);

  // Health poll notification does not announce
  controller.health = { status: 'checking', message: 'Checking...' };
  controller.notify();
  assert.equal(announcement.textContent, '');

  // Astral character text: "Fly 🪰🚀" -> 4 ASCII + 2 emojis = 6 codepoints
  controller.text = 'Fly 🪰🚀';
  controller.state = GENERATION_STATES.COMPLETED;
  controller.notify();

  assert.ok(announcement.textContent.includes('Length: 6 characters'));

  dispose();
});

test('empty state is visible initially, hidden with output, visible after clear', () => {
  const { root } = createDOM();
  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const empty = root.getElementById(PROMPT_DOM_IDS.OUTPUT_EMPTY);
  assert.ok(empty);
  assert.equal(empty.hidden, false);
  assert.equal(
    empty.textContent,
    'No output yet. Enter a prompt and press Generate (or Ctrl+Enter) once the model is ready.'
  );

  controller.text = 'Fly output';
  controller.state = GENERATION_STATES.COMPLETED;
  controller.notify();
  assert.equal(empty.hidden, true);

  const clearBtn = root.getElementById(PROMPT_DOM_IDS.CLEAR_BTN);
  clearBtn.click();
  assert.equal(empty.hidden, false);

  dispose();
});

test('cancelled and failed set distinct data-state on status and output', () => {
  const { root } = createDOM();
  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const statusBadge = root.getElementById(PROMPT_DOM_IDS.STATUS);
  const outputPre = root.getElementById(PROMPT_DOM_IDS.OUTPUT);

  controller.text = 'partial';
  controller.state = GENERATION_STATES.CANCELLED;
  controller.notify();

  assert.equal(statusBadge.getAttribute('data-state'), 'cancelled');
  assert.equal(outputPre.getAttribute('data-state'), 'cancelled');
  assert.equal(statusBadge.textContent, 'State: cancelled');

  controller.state = GENERATION_STATES.FAILED;
  controller.error = 'Stream truncated: connection closed before [DONE]';
  controller.notify();

  assert.equal(statusBadge.getAttribute('data-state'), 'failed');
  assert.equal(outputPre.getAttribute('data-state'), 'failed');
  assert.equal(statusBadge.textContent, 'State: failed');
  assert.equal(outputPre.textContent, 'partial');

  dispose();
});

test('health status exposes data-status for loading', () => {
  const { root } = createDOM();
  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const healthStatus = root.getElementById(PROMPT_DOM_IDS.HEALTH_STATUS);
  const generateBtn = root.getElementById(PROMPT_DOM_IDS.GENERATE_BTN);

  controller.health = {
    status: 'loading',
    ready: false,
    modelId: null,
    note: null,
    checkpoint: null,
    message:
      'Model loading: the model server is loading its checkpoint. This page is ready; Generate unlocks automatically when the model answers.',
  };
  controller.notify();

  assert.equal(healthStatus.getAttribute('data-status'), 'loading');
  assert.ok(healthStatus.textContent.startsWith('Model loading:'));
  assert.equal(generateBtn.disabled, true);

  controller.health = {
    status: 'ready',
    ready: true,
    modelId: 'm',
    note: null,
    checkpoint: null,
    message: 'Model ready: m · checkpoint not reported',
  };
  controller.notify();

  assert.equal(healthStatus.getAttribute('data-status'), 'ready');
  assert.equal(generateBtn.disabled, false);

  dispose();
});

test('API key input has an accessible description', () => {
  const { root } = createDOM();

  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });
  const apiKeyInput = root.getElementById(PROMPT_DOM_IDS.API_KEY);
  const apiKeyHelp = root.getElementById(PROMPT_DOM_IDS.API_KEY_HELP);

  assert.equal(PROMPT_DOM_IDS.API_KEY_HELP, 'prompt-api-key-help');
  assert.equal(apiKeyInput.getAttribute('aria-describedby'), 'prompt-api-key-help');
  assert.ok(apiKeyHelp, 'API key help element must be rendered');
  assert.equal(apiKeyHelp.textContent, 'Optional bearer token. Kept in memory for this tab only.');

  dispose();
});

const NATIVE_FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT']);

// Browser defaults: only native controls are tabbable unless tabIndex is set explicitly.
class FocusOrderDocument extends MockDocument {
  createElement(tag) {
    const el = super.createElement(tag);
    el.tabIndex = NATIVE_FOCUSABLE_TAGS.has(el.tagName) ? 0 : -1;
    return el;
  }
}


async function waitFor(predicate, message) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(r => setImmediate(r));
  }
  assert.fail(message);
}

function ctrlEnterKeydown() {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  event.key = 'Enter';
  event.ctrlKey = true;
  event.metaKey = false;
  event.repeat = false;
  event.isComposing = false;
  return event;
}

test('keyboard-only workflow: Ctrl+Enter generates, Cancel, Clear and Copy are reachable and work', async t => {
  let clipboardText = null;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: async text => {
          clipboardText = text;
        },
      },
    },
  });

  t.after(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  });

  let firstStream;
  const finalText = 'Second run:\tkeyboard  output ✓\n';
  const streams = [
    new ReadableStream({
      start(c) {
        firstStream = c;
      },
    }),
    createMockReadableStream([
      `data: ${JSON.stringify({ choices: [{ text: 'Second run:\tkeyboard ' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ text: ' output ✓\n', finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  ];
  const requests = [];

  const controller = new GenerationController({
    fetch: async (url, options = {}) => {
      if (url === '/health') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            model: 'flybrain-untrained',
            note: 'TEMPORARY, untrained',
          }),
        };
      }
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, body: streams.shift() };
    },
  });

  const doc = new FocusOrderDocument();
  const root = doc.createElement('div');
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  try {
    const promptInput = root.getElementById(PROMPT_DOM_IDS.INPUT);
    const generateBtn = root.getElementById(PROMPT_DOM_IDS.GENERATE_BTN);
    const cancelBtn = root.getElementById(PROMPT_DOM_IDS.CANCEL_BTN);
    const clearBtn = root.getElementById(PROMPT_DOM_IDS.CLEAR_BTN);
    const copyBtn = root.getElementById(PROMPT_DOM_IDS.COPY_BTN);
    const output = root.getElementById(PROMPT_DOM_IDS.OUTPUT);
    const status = root.getElementById(PROMPT_DOM_IDS.STATUS);
    const announcement = root.getElementById(PROMPT_DOM_IDS.ANNOUNCEMENT);


    await waitFor(() => controller.getState().health.ready, 'health never became ready');
    assert.equal(generateBtn.disabled, false);
    assert.equal(cancelBtn.disabled, true);
    assert.equal(copyBtn.disabled, true);

    promptInput.value = 'Keyboard prompt';
    const submitKey = ctrlEnterKeydown();
    promptInput.dispatchEvent(submitKey);
    assert.equal(submitKey.defaultPrevented, true);
    await waitFor(() => controller.getState().state === GENERATION_STATES.STREAMING, 'first run never started streaming');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt, 'Keyboard prompt');
    assert.equal(generateBtn.disabled, true);
    assert.equal(cancelBtn.disabled, false);
    assert.equal(clearBtn.disabled, true);

    firstStream.enqueue(new TextEncoder().encode('data: {"choices":[{"text":"Partial keyboard "}]}\n\n'));
    await waitFor(() => output.textContent === 'Partial keyboard ', 'partial output never rendered');

    cancelBtn.click();
    await waitFor(() => controller.getState().state === GENERATION_STATES.CANCELLED, 'cancel did not settle');
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    assert.equal(controller.getState().state, GENERATION_STATES.CANCELLED);
    assert.equal(output.textContent, 'Partial keyboard ');
    assert.equal(status.textContent, 'State: cancelled');
    assert.equal(announcement.textContent, 'Generation cancelled. Preserved 17 characters.');
    assert.equal(cancelBtn.disabled, true);
    assert.equal(clearBtn.disabled, false);
    assert.equal(generateBtn.disabled, false);
    assert.equal(copyBtn.disabled, false);

    clearBtn.click();
    assert.equal(promptInput.value, '');
    assert.equal(output.textContent, '');
    assert.equal(controller.getState().state, GENERATION_STATES.IDLE);
    assert.equal(copyBtn.disabled, true);

    promptInput.value = 'Second keyboard prompt';
    promptInput.dispatchEvent(ctrlEnterKeydown());
    await waitFor(() => controller.getState().state === GENERATION_STATES.COMPLETED, 'second run never completed');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].prompt, 'Second keyboard prompt');
    assert.equal(output.textContent, finalText);
    assert.equal(copyBtn.disabled, false);

    copyBtn.click();
    await waitFor(() => clipboardText !== null, 'clipboard was never written');
    assert.equal(clipboardText, finalText);
    assert.equal(copyBtn.textContent, 'Copied!');
  } finally {
    dispose();
  }
});

test('compact settings validation routes to first affected page and communicates other-page errors', () => {
  const { root } = createDOM();
  const controller = new GenerationController();
  const dispose = mountPrompt(root, { controller, pollHealth: false });

  const settingsPanel = root.getElementById(PROMPT_DOM_IDS.PANEL_SETTINGS);
  const prevBtn = root.getElementById(PROMPT_DOM_IDS.SETTINGS_PREV);
  const nextBtn = root.getElementById(PROMPT_DOM_IDS.SETTINGS_NEXT);
  const pageStatus = root.getElementById(PROMPT_DOM_IDS.SETTINGS_PAGE);

  // Scenario 1: Only topK is invalid (page 1)
  controller.state = GENERATION_STATES.FAILED;
  controller.error = 'Validation failed';
  controller.validationErrors = { topK: 'Top-K must be an integer between 1 and 50257.' };
  controller.notify();

  // Must route to page 1 directly
  assert.equal(settingsPanel.getAttribute('data-page'), '1');
  assert.equal(prevBtn.disabled, false);
  assert.equal(nextBtn.disabled, true);

  // Scenario 2: All 3 numeric fields invalid (reproduced 320x568 overflow scenario)
  controller.validationErrors = {
    maxTokens: 'Max tokens must be an integer between 1 and 128.',
    temperature: 'Temperature must be a finite number between 0 and 2.',
    topK: 'Top-K must be an integer between 1 and 50257.',
  };
  controller.notify();

  // Must route to FIRST affected page (page 0)
  assert.equal(settingsPanel.getAttribute('data-page'), '0');
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, false);
  assert.equal(nextBtn.getAttribute('data-has-errors'), 'true');

  // User navigates to page 1 to address topK
  nextBtn.click();
  assert.equal(settingsPanel.getAttribute('data-page'), '1');
  assert.equal(prevBtn.disabled, false);
  assert.equal(nextBtn.disabled, true);
  assert.equal(prevBtn.getAttribute('data-has-errors'), 'true');

  // Health check update occurs while user is on page 1
  controller.health = { status: 'ready', ready: true, message: 'Model ready' };
  controller.notify();

  // Crucial: Must NOT kick user back to page 0 on health poll
  assert.equal(settingsPanel.getAttribute('data-page'), '1', 'Health poll must preserve user navigation to page 1');
  assert.equal(prevBtn.disabled, false);
  assert.equal(nextBtn.disabled, true);

  // Clear action resets settings page to 0
  const clearBtn = root.getElementById(PROMPT_DOM_IDS.CLEAR_BTN);
  clearBtn.click();
  assert.equal(settingsPanel.getAttribute('data-page'), '0', 'Clear must reset settings page to 0');
  assert.equal(prevBtn.disabled, true);
  assert.equal(nextBtn.disabled, false);

  dispose();
});
