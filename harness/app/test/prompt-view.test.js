import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationController,
  GENERATION_STATES,
} from '../generation.js';
import {
  mountPrompt,
  PROMPT_DOM_IDS,
} from '../prompt-view.js';

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
