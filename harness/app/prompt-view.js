/**
 * Prompt and Generation View Module.
 *
 * Mounts the minimal prompt form with a single prompt textarea above paginated output,
 * model health indicator, accessible announcements, and action controls into a root container.
 */

import {
  GenerationController,
  GENERATION_STATES,
  isGenerationActive,
} from './generation.js';

export const PROMPT_DOM_IDS = Object.freeze({
  ROOT: 'prompt-root',
  FORM: 'prompt-form',
  HEALTH_STATUS: 'prompt-health-status',
  INPUT: 'prompt-input',
  GENERATE_BTN: 'prompt-generate-btn',
  CANCEL_BTN: 'prompt-cancel-btn',
  COPY_BTN: 'prompt-copy-btn',
  STATUS: 'prompt-status',
  USAGE: 'prompt-usage',
  FINISH_REASON: 'prompt-finish-reason',
  OUTPUT: 'prompt-output',
  OUTPUT_EMPTY: 'prompt-output-empty',
  ANNOUNCEMENT: 'prompt-announcement',
  ERROR_PROMPT: 'prompt-error-prompt',
  ERROR_GENERAL: 'prompt-error-general',
  PAGER: 'prompt-pager',
  PAGER_PREV: 'prompt-pager-prev',
  PAGER_NEXT: 'prompt-pager-next',
  PAGER_LATEST: 'prompt-pager-latest',
  PAGER_STATUS: 'prompt-pager-status',
});

export const PROMPT_CLASSES = Object.freeze({
  CONTAINER: 'prompt-container',
  HEADER: 'prompt-header',
  HEALTH: 'prompt-health-status',
  FORM: 'prompt-form',
  FIELD_GROUP: 'prompt-field-group',
  LABEL: 'prompt-label',
  TEXTAREA: 'prompt-input',
  INLINE_ERROR: 'prompt-inline-error',
  GENERAL_ERROR: 'prompt-general-error',
  ACTIONS: 'prompt-actions',
  BTN: 'prompt-btn',
  BTN_PRIMARY: 'prompt-btn-primary',
  META: 'prompt-meta',
  STATUS_BADGE: 'prompt-status',
  USAGE: 'prompt-usage',
  FINISH_REASON: 'prompt-finish-reason',
  OUTPUT_CONTAINER: 'prompt-output-container',
  OUTPUT: 'prompt-output',
  OUTPUT_EMPTY: 'prompt-output-empty',
  ANNOUNCEMENT: 'prompt-announcement',
  PAGER: 'prompt-pager',
  PAGER_BTN: 'prompt-pager-btn',
  PAGER_PREV: 'prompt-pager-prev',
  PAGER_NEXT: 'prompt-pager-next',
  PAGER_LATEST: 'prompt-pager-latest',
  PAGER_STATUS: 'prompt-pager-status',
});

export const PAGER_LIMITS = Object.freeze({
  MAX_LINES: 6,
  MAX_CODEPOINTS: 240,
});

/**
 * Splits text into bounded pages without splitting surrogate pairs.
 * Concatenating all pages yields the exact original text.
 *
 * @param {string} text - Full text to paginate
 * @param {number} [maxLines=6] - Max logical lines per page
 * @param {number} [maxCodepoints=240] - Max code points per page
 * @param {number} [columns=Infinity] - Conservative visual columns per line
 * @returns {string[]} Array of page text strings
 */
export function paginateText(text, maxLines = PAGER_LIMITS.MAX_LINES, maxCodepoints = PAGER_LIMITS.MAX_CODEPOINTS, columns = Infinity) {
  if (!text) {
    return [''];
  }

  const codepoints = Array.from(text);
  const pages = [];
  let currentPage = [];
  let currentLines = 1;
  let currentColumn = 0;

  for (let i = 0; i < codepoints.length; i++) {
    const cp = codepoints[i];
    const newline = cp === '\n' || cp === '\r';

    if (currentPage.length >= maxCodepoints ||
        (!newline && currentColumn >= columns && currentLines >= maxLines)) {
      pages.push(currentPage.join(''));
      currentPage = [];
      currentLines = 1;
      currentColumn = 0;
    }

    if (!newline && currentColumn >= columns) {
      currentLines++;
      currentColumn = 0;
    }
    currentPage.push(cp);

    if (newline) {
      currentColumn = 0;
      currentLines++;
      if (currentLines > maxLines && i + 1 < codepoints.length) {
        pages.push(currentPage.join(''));
        currentPage = [];
        currentLines = 1;
      }
    }
    else {
      currentColumn++;
    }
  }

  if (currentPage.length > 0) {
    pages.push(currentPage.join(''));
  }

  return pages.length > 0 ? pages : [''];
}

/**
 * Mounts the minimal prompt generation UI into root.
 *
 * @param {HTMLElement} root - Target container
 * @param {Object} options - Configuration options
 * @param {string} [options.endpoint='/v1/completions'] - Model completions endpoint
 * @param {string} [options.healthEndpoint='/health'] - Model health endpoint
 * @param {Function} [options.onGenerate] - Callback invoked before model submission
 * @param {string} [options.defaultPrompt=''] - Initial prompt text
 * @param {number} [options.defaultMaxTokens=64] - Default max tokens (1..128)
 * @param {number} [options.defaultTemperature=1.0] - Default temperature (0..2)
 * @param {number} [options.defaultTopK=50] - Default top_k (1..50257)
 * @param {boolean} [options.pollHealth=true] - Whether to poll health periodically
 * @param {GenerationController} [options.controller] - Custom controller instance
 * @param {Function} [options.subscribeConnection] - Optional function returning unsubscribe to track connection readiness
 * @returns {Function} disposer function to dismantle UI and abort active operations
 */
export function mountPrompt(root, options = {}) {
  if (!root) {
    throw new Error('mountPrompt requires a valid root DOM element');
  }

  const doc = root.ownerDocument || globalThis.document;
  if (!doc) {
    throw new Error('DOM document unavailable for mountPrompt');
  }

  const ownedController = !options.controller;
  const controller = options.controller || new GenerationController({
    endpoint: options.endpoint || '/v1/completions',
    healthEndpoint: options.healthEndpoint || '/health',
    apiKey: options.apiKey || null,
  });

  const defaultPrompt = options.defaultPrompt ?? '';
  const defaultMaxTokens = options.defaultMaxTokens ?? 64;
  const defaultTemperature = options.defaultTemperature ?? 1.0;
  const defaultTopK = options.defaultTopK ?? 50;

  // Build UI Elements
  const container = doc.createElement('div');
  container.id = PROMPT_DOM_IDS.ROOT;
  container.className = PROMPT_CLASSES.CONTAINER;

  // Header: Health status
  const header = doc.createElement('div');
  header.className = PROMPT_CLASSES.HEADER;

  const healthStatus = doc.createElement('div');
  healthStatus.id = PROMPT_DOM_IDS.HEALTH_STATUS;
  healthStatus.className = PROMPT_CLASSES.HEALTH;
  healthStatus.textContent = 'Checking model status...';
  healthStatus.title = 'Checking model status...';
  healthStatus.setAttribute('aria-live', 'polite');

  header.append(healthStatus);

  // Metadata row (state, usage, finish reason)
  const meta = doc.createElement('div');
  meta.className = PROMPT_CLASSES.META;

  const statusBadge = doc.createElement('span');
  statusBadge.id = PROMPT_DOM_IDS.STATUS;
  statusBadge.className = PROMPT_CLASSES.STATUS_BADGE;
  statusBadge.textContent = 'State: idle';

  const usageBadge = doc.createElement('span');
  usageBadge.id = PROMPT_DOM_IDS.USAGE;
  usageBadge.className = PROMPT_CLASSES.USAGE;

  const finishReasonBadge = doc.createElement('span');
  finishReasonBadge.id = PROMPT_DOM_IDS.FINISH_REASON;
  finishReasonBadge.className = PROMPT_CLASSES.FINISH_REASON;

  meta.append(statusBadge, usageBadge, finishReasonBadge);

  // Form container: one prompt textarea above paginated output
  const form = doc.createElement('form');
  form.id = PROMPT_DOM_IDS.FORM;
  form.className = PROMPT_CLASSES.FORM;
  form.noValidate = true;

  // Prompt input section
  const promptGroup = doc.createElement('div');
  promptGroup.className = PROMPT_CLASSES.FIELD_GROUP;

  const promptLabel = doc.createElement('label');
  promptLabel.htmlFor = PROMPT_DOM_IDS.INPUT;
  promptLabel.className = PROMPT_CLASSES.LABEL;
  promptLabel.textContent = 'Prompt (Ctrl+Enter to generate):';

  const promptInput = doc.createElement('textarea');
  promptInput.id = PROMPT_DOM_IDS.INPUT;
  promptInput.className = PROMPT_CLASSES.TEXTAREA;
  promptInput.rows = 3;
  promptInput.value = defaultPrompt;
  promptInput.placeholder = 'Enter prompt here...';
  promptInput.setAttribute('aria-describedby', PROMPT_DOM_IDS.ERROR_PROMPT);

  const promptError = doc.createElement('div');
  promptError.id = PROMPT_DOM_IDS.ERROR_PROMPT;
  promptError.className = PROMPT_CLASSES.INLINE_ERROR;
  promptError.setAttribute('role', 'alert');

  promptGroup.append(promptLabel, promptInput, promptError);

  // Output section with bounded paged view
  const outputContainer = doc.createElement('div');
  outputContainer.className = PROMPT_CLASSES.OUTPUT_CONTAINER;

  const outputLabel = doc.createElement('label');
  outputLabel.htmlFor = PROMPT_DOM_IDS.OUTPUT;
  outputLabel.className = PROMPT_CLASSES.LABEL;
  outputLabel.textContent = 'Generated Output:';

  const outputEmpty = doc.createElement('div');
  outputEmpty.id = PROMPT_DOM_IDS.OUTPUT_EMPTY;
  outputEmpty.className = PROMPT_CLASSES.OUTPUT_EMPTY;
  outputEmpty.textContent = 'No output yet. Enter a prompt and press Generate (or Ctrl+Enter) once the model is ready.';

  const outputPre = doc.createElement('pre');
  outputPre.id = PROMPT_DOM_IDS.OUTPUT;
  outputPre.className = PROMPT_CLASSES.OUTPUT;
  outputPre.tabIndex = 0;
  outputPre.setAttribute('aria-label', 'Model output');

  const pager = doc.createElement('div');
  pager.id = PROMPT_DOM_IDS.PAGER;
  pager.className = PROMPT_CLASSES.PAGER;
  pager.hidden = true;
  pager.style.display = 'none';

  const pagerPrevBtn = doc.createElement('button');
  pagerPrevBtn.id = PROMPT_DOM_IDS.PAGER_PREV;
  pagerPrevBtn.type = 'button';
  pagerPrevBtn.className = `${PROMPT_CLASSES.BTN} ${PROMPT_CLASSES.PAGER_BTN} ${PROMPT_CLASSES.PAGER_PREV}`;
  pagerPrevBtn.textContent = 'Previous';
  pagerPrevBtn.setAttribute('aria-label', 'Previous output page');
  pagerPrevBtn.disabled = true;

  const pagerStatus = doc.createElement('span');
  pagerStatus.id = PROMPT_DOM_IDS.PAGER_STATUS;
  pagerStatus.className = PROMPT_CLASSES.PAGER_STATUS;
  pagerStatus.setAttribute('role', 'status');
  pagerStatus.setAttribute('aria-live', 'polite');
  pagerStatus.textContent = 'Page 1 of 1';

  const pagerNextBtn = doc.createElement('button');
  pagerNextBtn.id = PROMPT_DOM_IDS.PAGER_NEXT;
  pagerNextBtn.type = 'button';
  pagerNextBtn.className = `${PROMPT_CLASSES.BTN} ${PROMPT_CLASSES.PAGER_BTN} ${PROMPT_CLASSES.PAGER_NEXT}`;
  pagerNextBtn.textContent = 'Next';
  pagerNextBtn.setAttribute('aria-label', 'Next output page');
  pagerNextBtn.disabled = true;

  const pagerLatestBtn = doc.createElement('button');
  pagerLatestBtn.id = PROMPT_DOM_IDS.PAGER_LATEST;
  pagerLatestBtn.type = 'button';
  pagerLatestBtn.className = `${PROMPT_CLASSES.BTN} ${PROMPT_CLASSES.PAGER_BTN} ${PROMPT_CLASSES.PAGER_LATEST}`;
  pagerLatestBtn.textContent = 'Latest';
  pagerLatestBtn.setAttribute('aria-label', 'Latest output page');
  pagerLatestBtn.disabled = true;

  pager.append(pagerPrevBtn, pagerStatus, pagerNextBtn, pagerLatestBtn);
  outputContainer.append(outputLabel, outputEmpty, outputPre, pager);

  // General error banner
  const generalError = doc.createElement('div');
  generalError.id = PROMPT_DOM_IDS.ERROR_GENERAL;
  generalError.className = PROMPT_CLASSES.GENERAL_ERROR;
  generalError.setAttribute('role', 'alert');

  // Action buttons: Generate, Stop, Copy
  const actions = doc.createElement('div');
  actions.className = PROMPT_CLASSES.ACTIONS;

  const generateBtn = doc.createElement('button');
  generateBtn.id = PROMPT_DOM_IDS.GENERATE_BTN;
  generateBtn.type = 'submit';
  generateBtn.className = `${PROMPT_CLASSES.BTN} ${PROMPT_CLASSES.BTN_PRIMARY}`;
  generateBtn.textContent = 'Generate';

  const cancelBtn = doc.createElement('button');
  cancelBtn.id = PROMPT_DOM_IDS.CANCEL_BTN;
  cancelBtn.type = 'button';
  cancelBtn.className = PROMPT_CLASSES.BTN;
  cancelBtn.textContent = 'Stop';
  cancelBtn.disabled = true;

  const copyBtn = doc.createElement('button');
  copyBtn.id = PROMPT_DOM_IDS.COPY_BTN;
  copyBtn.type = 'button';
  copyBtn.className = PROMPT_CLASSES.BTN;
  copyBtn.textContent = 'Copy';
  copyBtn.disabled = true;

  actions.append(generateBtn, cancelBtn, copyBtn);
  form.append(promptGroup, outputContainer, generalError, actions);

  // Live announcement region for screen readers
  const announcement = doc.createElement('div');
  announcement.id = PROMPT_DOM_IDS.ANNOUNCEMENT;
  announcement.className = PROMPT_CLASSES.ANNOUNCEMENT;
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');

  container.append(header, meta, form, announcement);

  if (typeof root.replaceChildren === 'function') {
    root.replaceChildren(container);
  } else {
    root.innerHTML = '';
    root.appendChild?.(container);
  }

  // Pager state
  let userNavigatedPage = false;
  let currentPageIndex = 0;
  let cachedPages = [''];

  let measureContext = null;
  let measureFont = '';
  const glyphWidths = new Map();

  function outputPageLimits(text) {
    const defaults = { lines: PAGER_LIMITS.MAX_LINES, columns: Infinity };
    if (!outputPre.clientWidth || !outputPre.clientHeight ||
        typeof globalThis.getComputedStyle !== 'function') return defaults;
    const style = getComputedStyle(outputPre);
    measureContext ??= doc.createElement('canvas').getContext('2d');
    if (!measureContext) return defaults;
    const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if (font !== measureFont) {
      measureFont = font;
      measureContext.font = font;
      glyphWidths.clear();
    }
    let widest = measureContext.measureText('M').width;
    for (const character of text) {
      if (character === '\n' || character === '\r') continue;
      let width = glyphWidths.get(character);
      if (width === undefined) {
        width = measureContext.measureText(character === '\t' ? '  ' : character).width;
        glyphWidths.set(character, width);
      }
      widest = Math.max(widest, width);
    }
    const width = outputPre.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = outputPre.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const lines = Math.max(1, Math.floor(height / parseFloat(style.lineHeight)) - 1);
    return {
      lines: Math.min(PAGER_LIMITS.MAX_LINES, lines),
      columns: Math.max(1, Math.floor(width / widest)),
    };
  }

  function updatePagerDisplay() {
    const totalPages = cachedPages.length;
    if (currentPageIndex >= totalPages) {
      currentPageIndex = Math.max(0, totalPages - 1);
    }
    if (currentPageIndex < 0) {
      currentPageIndex = 0;
    }

    outputPre.textContent = cachedPages[currentPageIndex] || '';
    pagerStatus.textContent = `Page ${currentPageIndex + 1} of ${totalPages}`;
    pagerPrevBtn.disabled = currentPageIndex <= 0;
    pagerNextBtn.disabled = currentPageIndex >= totalPages - 1;
    pagerLatestBtn.disabled = currentPageIndex >= totalPages - 1;
  }

  function handlePagerPrev() {
    if (currentPageIndex > 0) {
      currentPageIndex--;
      userNavigatedPage = true;
      updatePagerDisplay();
    }
  }

  function handlePagerNext() {
    const totalPages = cachedPages.length;
    if (currentPageIndex < totalPages - 1) {
      currentPageIndex++;
      if (currentPageIndex >= totalPages - 1) {
        userNavigatedPage = false;
      } else {
        userNavigatedPage = true;
      }
      updatePagerDisplay();
    }
  }

  function handlePagerLatest() {
    const totalPages = cachedPages.length;
    currentPageIndex = Math.max(0, totalPages - 1);
    userNavigatedPage = false;
    updatePagerDisplay();
  }

  // State synchronization and accessibility updates
  let previousState = controller.getState().state;
  let actionError = null;
  const COPY_DEFAULT_LABEL = 'Copy';
  let copyTimer = null;

  // Connection readiness subscription state
  let connectionState = null;
  let unsubscribeConnection = null;

  function isReadyToGenerate(health) {
    const healthReady = Boolean(health?.ready);
    const connReady = typeof options.subscribeConnection === 'function'
      ? Boolean(connectionState?.ready)
      : true;
    return healthReady && connReady;
  }

  function render(state) {
    statusBadge.textContent = `State: ${state.state}`;
    statusBadge.setAttribute('data-state', state.state);

    const active = isGenerationActive(state.state);
    if (active && !isGenerationActive(previousState)) {
      userNavigatedPage = false;
      currentPageIndex = 0;
    }

    // Output pagination
    const fullText = state.text || '';
    const limits = outputPageLimits(fullText);
    cachedPages = paginateText(fullText, limits.lines, PAGER_LIMITS.MAX_CODEPOINTS, limits.columns);
    const totalPages = cachedPages.length;

    if (!userNavigatedPage) {
      currentPageIndex = Math.max(0, totalPages - 1);
    } else {
      if (currentPageIndex >= totalPages) {
        currentPageIndex = Math.max(0, totalPages - 1);
      }
      if (currentPageIndex < 0) {
        currentPageIndex = 0;
      }
    }

    outputPre.textContent = cachedPages[currentPageIndex] || '';
    outputPre.setAttribute('data-state', state.state);
    outputEmpty.hidden = Boolean(fullText);
    outputEmpty.style.display = fullText ? 'none' : '';

    // Only show output page controls when multiple pages
    const multiPage = totalPages > 1;
    pager.hidden = !multiPage;
    pager.style.display = multiPage ? '' : 'none';

    pagerStatus.textContent = `Page ${currentPageIndex + 1} of ${totalPages}`;
    pagerPrevBtn.disabled = currentPageIndex <= 0;
    pagerNextBtn.disabled = currentPageIndex >= totalPages - 1;
    pagerLatestBtn.disabled = currentPageIndex >= totalPages - 1;

    // Health status display: model identity visible
    const healthMsg = state.health.message || 'Model status unknown';
    healthStatus.textContent = healthMsg;
    healthStatus.title = healthMsg;
    healthStatus.setAttribute('data-status', state.health.status);

    // Validation and error presentation
    const hasValidationErrors = Object.keys(state.validationErrors || {}).length > 0;

    if (hasValidationErrors) {
      promptError.textContent = state.validationErrors?.prompt || '';
      promptInput.setAttribute('aria-invalid', state.validationErrors?.prompt ? 'true' : 'false');
      const otherErrors = Object.entries(state.validationErrors)
        .filter(([k]) => k !== 'prompt')
        .map(([, v]) => v);
      generalError.textContent = otherErrors.join(', ');
      usageBadge.textContent = '';
      finishReasonBadge.textContent = '';
    } else {
      promptError.textContent = '';
      promptInput.setAttribute('aria-invalid', 'false');
      generalError.textContent = state.error || actionError || '';

      if (state.usage) {
        usageBadge.textContent = `Tokens: ${state.usage.prompt_tokens} prompt + ${state.usage.completion_tokens} completion = ${state.usage.total_tokens} total`;
      } else {
        usageBadge.textContent = '';
      }

      if (state.finishReason) {
        finishReasonBadge.textContent = `Finish reason: ${state.finishReason}`;
      } else {
        finishReasonBadge.textContent = '';
      }
    }

    const ready = isReadyToGenerate(state.health);
    generateBtn.disabled = active || !ready;
    cancelBtn.disabled = !active;
    copyBtn.disabled = !state.text;

    // Accessible announcements on key lifecycle transitions (never per-token or per-health poll)
    if (previousState !== state.state) {
      if (state.state === GENERATION_STATES.COMPLETED) {
        const codepoints = [...(state.text || '')].length;
        announcement.textContent = `Generation completed. Length: ${codepoints} characters.${state.usage ? ` (${state.usage.completion_tokens} tokens)` : ''}`;
      } else if (state.state === GENERATION_STATES.CANCELLED) {
        const codepoints = [...(state.text || '')].length;
        announcement.textContent = `Generation cancelled. Preserved ${codepoints} characters.`;
      } else if (state.state === GENERATION_STATES.FAILED) {
        announcement.textContent = `Generation failed: ${state.error || 'Check input or network'}`;
      }
      previousState = state.state;
    }
  }

  // Subscribe to connection readiness if provided
  if (typeof options.subscribeConnection === 'function') {
    unsubscribeConnection = options.subscribeConnection((snapshot) => {
      connectionState = snapshot;
      render(controller.getState());
    });
  }

  const unsubscribe = controller.subscribe(render);
  render(controller.getState());

  const outputResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (outputPre.clientWidth && outputPre.clientHeight) render(controller.getState());
    })
    : null;
  outputResizeObserver?.observe(outputPre);

  // Form submission handler
  async function handleSubmit(event) {
    if (event) {
      event.preventDefault();
    }
    actionError = null;
    const currentState = controller.getState();
    if (controller.isActive() || !isReadyToGenerate(currentState.health)) return;

    const params = {
      prompt: promptInput.value,
      maxTokens: defaultMaxTokens,
      temperature: defaultTemperature,
      topK: defaultTopK,
    };

    await controller.submit(params, { onGenerate: options.onGenerate });
  }

  // Ctrl/Cmd + Enter submission without swallowing ordinary newlines, repeat, or IME composition
  function handleKeyDown(event) {
    if (event.isComposing || event.repeat) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
    }
  }

  // Copy full output (Unicode whitespace preserved across all pages)
  async function handleCopy() {
    const text = controller.getState().text || '';
    if (!text) return;

    try {
      if (globalThis.navigator?.clipboard?.writeText) {
        await globalThis.navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts
        const tempArea = doc.createElement('textarea');
        tempArea.value = text;
        tempArea.style.position = 'fixed';
        tempArea.style.left = '-9999px';
        doc.body.appendChild(tempArea);
        tempArea.select();
        doc.execCommand('copy');
        doc.body.removeChild(tempArea);
      }

      copyBtn.textContent = 'Copied!';
      announcement.textContent = 'Generated text copied to clipboard.';
      actionError = null;
      if (!controller.getState().error) {
        generalError.textContent = '';
      }

      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBtn.textContent = COPY_DEFAULT_LABEL;
        copyTimer = null;
      }, 1500);
    } catch {
      actionError = 'Unable to copy to clipboard.';
      generalError.textContent = actionError;
    }
  }

  function handleCancel() {
    controller.cancel();
  }

  form.addEventListener('submit', handleSubmit);
  promptInput.addEventListener('keydown', handleKeyDown);
  cancelBtn.addEventListener('click', handleCancel);
  copyBtn.addEventListener('click', handleCopy);

  pagerPrevBtn.addEventListener('click', handlePagerPrev);
  pagerNextBtn.addEventListener('click', handlePagerNext);
  pagerLatestBtn.addEventListener('click', handlePagerLatest);

  // Initialize health check
  if (options.pollHealth !== false) {
    controller.startHealthPolling();
  } else {
    controller.checkHealth();
  }

  // Disposer function
  function dispose() {
    outputResizeObserver?.disconnect();
    unsubscribe();
    if (typeof unsubscribeConnection === 'function') {
      unsubscribeConnection();
      unsubscribeConnection = null;
    }
    form.removeEventListener('submit', handleSubmit);
    promptInput.removeEventListener('keydown', handleKeyDown);
    cancelBtn.removeEventListener('click', handleCancel);
    copyBtn.removeEventListener('click', handleCopy);

    pagerPrevBtn.removeEventListener('click', handlePagerPrev);
    pagerNextBtn.removeEventListener('click', handlePagerNext);
    pagerLatestBtn.removeEventListener('click', handlePagerLatest);

    clearTimeout(copyTimer);
    copyTimer = null;

    if (ownedController) {
      controller.dispose();
    } else if (options.pollHealth !== false) {
      controller.stopHealthPolling();
    }

    if (typeof root.replaceChildren === 'function') {
      root.replaceChildren();
    } else {
      root.innerHTML = '';
    }
  }

  return dispose;
}
