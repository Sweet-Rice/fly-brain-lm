/**
 * Prompt and Generation View Module.
 *
 * Mounts the compact tabbed prompt form, model health indicator, parameter controls,
 * accessible announcements, and bounded paged output into a root container.
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
  HEALTH_RETRY_BTN: 'prompt-health-retry-btn',
  INPUT: 'prompt-input',
  MAX_TOKENS: 'prompt-max-tokens',
  TEMPERATURE: 'prompt-temperature',
  TOP_K: 'prompt-top-k',
  API_KEY: 'prompt-api-key',
  API_KEY_HELP: 'prompt-api-key-help',
  GENERATE_BTN: 'prompt-generate-btn',
  CANCEL_BTN: 'prompt-cancel-btn',
  CLEAR_BTN: 'prompt-clear-btn',
  COPY_BTN: 'prompt-copy-btn',
  STATUS: 'prompt-status',
  RUN_ID: 'prompt-run-id',
  USAGE: 'prompt-usage',
  FINISH_REASON: 'prompt-finish-reason',
  OUTPUT: 'prompt-output',
  OUTPUT_EMPTY: 'prompt-output-empty',
  ANNOUNCEMENT: 'prompt-announcement',
  ERROR_PROMPT: 'prompt-error-prompt',
  ERROR_MAX_TOKENS: 'prompt-error-max-tokens',
  ERROR_TEMPERATURE: 'prompt-error-temperature',
  ERROR_TOP_K: 'prompt-error-top-k',
  ERROR_GENERAL: 'prompt-error-general',
  TABLIST: 'prompt-tablist',
  TAB_COMPOSE: 'prompt-tab-compose',
  TAB_OUTPUT: 'prompt-tab-output',
  TAB_SETTINGS: 'prompt-tab-settings',
  PANEL_COMPOSE: 'prompt-panel-compose',
  PANEL_OUTPUT: 'prompt-panel-output',
  PANEL_SETTINGS: 'prompt-panel-settings',
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
  CONTROLS_GRID: 'prompt-controls-grid',
  LABEL: 'prompt-label',
  TEXTAREA: 'prompt-input',
  INPUT_NUM: 'prompt-input-num',
  INPUT_TEXT: 'prompt-input-text',
  INLINE_ERROR: 'prompt-inline-error',
  GENERAL_ERROR: 'prompt-general-error',
  ACTIONS: 'prompt-actions',
  BTN: 'prompt-btn',
  BTN_PRIMARY: 'prompt-btn-primary',
  META: 'prompt-meta',
  STATUS_BADGE: 'prompt-status',
  RUN_ID: 'prompt-run-id',
  USAGE: 'prompt-usage',
  FINISH_REASON: 'prompt-finish-reason',
  OUTPUT_CONTAINER: 'prompt-output-container',
  OUTPUT: 'prompt-output',
  OUTPUT_EMPTY: 'prompt-output-empty',
  ANNOUNCEMENT: 'prompt-announcement',
  TABS: 'prompt-tabs',
  TAB: 'prompt-tab',
  TAB_ACTIVE: 'prompt-tab-active',
  TABPANEL: 'prompt-tabpanel',
  PANEL_COMPOSE: 'prompt-panel-compose',
  PANEL_OUTPUT: 'prompt-panel-output',
  PANEL_SETTINGS: 'prompt-panel-settings',
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
 * @returns {string[]} Array of page text strings
 */
export function paginateText(text, maxLines = PAGER_LIMITS.MAX_LINES, maxCodepoints = PAGER_LIMITS.MAX_CODEPOINTS) {
  if (!text) {
    return [''];
  }

  const codepoints = Array.from(text);
  const pages = [];
  let currentPage = [];
  let currentLines = 1;

  for (let i = 0; i < codepoints.length; i++) {
    const cp = codepoints[i];

    if (currentPage.length >= maxCodepoints) {
      pages.push(currentPage.join(''));
      currentPage = [];
      currentLines = 1;
    }

    currentPage.push(cp);

    if (cp === '\n') {
      currentLines++;
      if (currentLines > maxLines && i + 1 < codepoints.length) {
        pages.push(currentPage.join(''));
        currentPage = [];
        currentLines = 1;
      }
    }
  }

  if (currentPage.length > 0) {
    pages.push(currentPage.join(''));
  }

  return pages.length > 0 ? pages : [''];
}

/**
 * Mounts the prompt generation UI into root.
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

  // Header: Health status & manual retry
  const header = doc.createElement('div');
  header.className = PROMPT_CLASSES.HEADER;

  const healthStatus = doc.createElement('div');
  healthStatus.id = PROMPT_DOM_IDS.HEALTH_STATUS;
  healthStatus.className = PROMPT_CLASSES.HEALTH;
  healthStatus.textContent = 'Checking model status...';
  healthStatus.title = 'Checking model status...';
  healthStatus.setAttribute('aria-live', 'polite');

  const healthRetryBtn = doc.createElement('button');
  healthRetryBtn.id = PROMPT_DOM_IDS.HEALTH_RETRY_BTN;
  healthRetryBtn.type = 'button';
  healthRetryBtn.className = PROMPT_CLASSES.BTN;
  healthRetryBtn.textContent = 'Retry Health';

  header.append(healthStatus, healthRetryBtn);

  // Metadata / Telemetry row (run ID, state, usage - never claims token/fire alignment)
  const meta = doc.createElement('div');
  meta.className = PROMPT_CLASSES.META;

  const statusBadge = doc.createElement('span');
  statusBadge.id = PROMPT_DOM_IDS.STATUS;
  statusBadge.className = PROMPT_CLASSES.STATUS_BADGE;
  statusBadge.textContent = 'State: idle';

  const runIdBadge = doc.createElement('span');
  runIdBadge.id = PROMPT_DOM_IDS.RUN_ID;
  runIdBadge.className = PROMPT_CLASSES.RUN_ID;
  runIdBadge.textContent = 'Run ID: -';

  const usageBadge = doc.createElement('span');
  usageBadge.id = PROMPT_DOM_IDS.USAGE;
  usageBadge.className = PROMPT_CLASSES.USAGE;

  const finishReasonBadge = doc.createElement('span');
  finishReasonBadge.id = PROMPT_DOM_IDS.FINISH_REASON;
  finishReasonBadge.className = PROMPT_CLASSES.FINISH_REASON;

  meta.append(statusBadge, runIdBadge, usageBadge, finishReasonBadge);

  // Form container
  const form = doc.createElement('form');
  form.id = PROMPT_DOM_IDS.FORM;
  form.className = PROMPT_CLASSES.FORM;
  form.noValidate = true;

  // Tabs navigation
  const tablist = doc.createElement('div');
  tablist.id = PROMPT_DOM_IDS.TABLIST;
  tablist.className = PROMPT_CLASSES.TABS;
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Prompt views');

  const tabCompose = doc.createElement('button');
  tabCompose.id = PROMPT_DOM_IDS.TAB_COMPOSE;
  tabCompose.type = 'button';
  tabCompose.setAttribute('role', 'tab');
  tabCompose.className = `${PROMPT_CLASSES.TAB} ${PROMPT_CLASSES.TAB_ACTIVE}`;
  tabCompose.textContent = 'Compose';
  tabCompose.setAttribute('aria-selected', 'true');
  tabCompose.setAttribute('aria-controls', PROMPT_DOM_IDS.PANEL_COMPOSE);

  const tabOutput = doc.createElement('button');
  tabOutput.id = PROMPT_DOM_IDS.TAB_OUTPUT;
  tabOutput.type = 'button';
  tabOutput.setAttribute('role', 'tab');
  tabOutput.className = PROMPT_CLASSES.TAB;
  tabOutput.textContent = 'Output';
  tabOutput.setAttribute('aria-selected', 'false');
  tabOutput.setAttribute('aria-controls', PROMPT_DOM_IDS.PANEL_OUTPUT);

  const tabSettings = doc.createElement('button');
  tabSettings.id = PROMPT_DOM_IDS.TAB_SETTINGS;
  tabSettings.type = 'button';
  tabSettings.setAttribute('role', 'tab');
  tabSettings.className = PROMPT_CLASSES.TAB;
  tabSettings.textContent = 'Settings';
  tabSettings.setAttribute('aria-selected', 'false');
  tabSettings.setAttribute('aria-controls', PROMPT_DOM_IDS.PANEL_SETTINGS);

  tablist.append(tabCompose, tabOutput, tabSettings);

  // Compose Panel
  const composePanel = doc.createElement('div');
  composePanel.id = PROMPT_DOM_IDS.PANEL_COMPOSE;
  composePanel.className = `${PROMPT_CLASSES.TABPANEL} ${PROMPT_CLASSES.PANEL_COMPOSE}`;
  composePanel.setAttribute('role', 'tabpanel');
  composePanel.setAttribute('aria-labelledby', PROMPT_DOM_IDS.TAB_COMPOSE);

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
  composePanel.append(promptGroup);

  // Output Panel (with bounded paged view)
  const outputPanel = doc.createElement('div');
  outputPanel.id = PROMPT_DOM_IDS.PANEL_OUTPUT;
  outputPanel.className = `${PROMPT_CLASSES.TABPANEL} ${PROMPT_CLASSES.PANEL_OUTPUT}`;
  outputPanel.setAttribute('role', 'tabpanel');
  outputPanel.setAttribute('aria-labelledby', PROMPT_DOM_IDS.TAB_OUTPUT);
  outputPanel.hidden = true;

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
  outputPanel.append(outputContainer);

  // Settings Panel
  const settingsPanel = doc.createElement('div');
  settingsPanel.id = PROMPT_DOM_IDS.PANEL_SETTINGS;
  settingsPanel.className = `${PROMPT_CLASSES.TABPANEL} ${PROMPT_CLASSES.PANEL_SETTINGS}`;
  settingsPanel.setAttribute('role', 'tabpanel');
  settingsPanel.setAttribute('aria-labelledby', PROMPT_DOM_IDS.TAB_SETTINGS);
  settingsPanel.hidden = true;

  const controlsGrid = doc.createElement('div');
  controlsGrid.className = PROMPT_CLASSES.CONTROLS_GRID;

  // Max tokens
  const maxTokensGroup = doc.createElement('div');
  maxTokensGroup.className = PROMPT_CLASSES.FIELD_GROUP;
  const maxTokensLabel = doc.createElement('label');
  maxTokensLabel.htmlFor = PROMPT_DOM_IDS.MAX_TOKENS;
  maxTokensLabel.className = PROMPT_CLASSES.LABEL;
  maxTokensLabel.textContent = 'Max tokens (1..128):';
  const maxTokensInput = doc.createElement('input');
  maxTokensInput.id = PROMPT_DOM_IDS.MAX_TOKENS;
  maxTokensInput.type = 'number';
  maxTokensInput.className = PROMPT_CLASSES.INPUT_NUM;
  maxTokensInput.min = '1';
  maxTokensInput.max = '128';
  maxTokensInput.value = String(defaultMaxTokens);
  maxTokensInput.setAttribute('aria-describedby', PROMPT_DOM_IDS.ERROR_MAX_TOKENS);
  const maxTokensError = doc.createElement('div');
  maxTokensError.id = PROMPT_DOM_IDS.ERROR_MAX_TOKENS;
  maxTokensError.className = PROMPT_CLASSES.INLINE_ERROR;
  maxTokensError.setAttribute('role', 'alert');
  maxTokensGroup.append(maxTokensLabel, maxTokensInput, maxTokensError);

  // Temperature
  const tempGroup = doc.createElement('div');
  tempGroup.className = PROMPT_CLASSES.FIELD_GROUP;
  const tempLabel = doc.createElement('label');
  tempLabel.htmlFor = PROMPT_DOM_IDS.TEMPERATURE;
  tempLabel.className = PROMPT_CLASSES.LABEL;
  tempLabel.textContent = 'Temperature (0..2):';
  const tempInput = doc.createElement('input');
  tempInput.id = PROMPT_DOM_IDS.TEMPERATURE;
  tempInput.type = 'number';
  tempInput.className = PROMPT_CLASSES.INPUT_NUM;
  tempInput.min = '0';
  tempInput.max = '2';
  tempInput.step = '0.1';
  tempInput.value = String(defaultTemperature);
  tempInput.setAttribute('aria-describedby', PROMPT_DOM_IDS.ERROR_TEMPERATURE);
  const tempError = doc.createElement('div');
  tempError.id = PROMPT_DOM_IDS.ERROR_TEMPERATURE;
  tempError.className = PROMPT_CLASSES.INLINE_ERROR;
  tempError.setAttribute('role', 'alert');
  tempGroup.append(tempLabel, tempInput, tempError);

  // Top K
  const topKGroup = doc.createElement('div');
  topKGroup.className = PROMPT_CLASSES.FIELD_GROUP;
  const topKLabel = doc.createElement('label');
  topKLabel.htmlFor = PROMPT_DOM_IDS.TOP_K;
  topKLabel.className = PROMPT_CLASSES.LABEL;
  topKLabel.textContent = 'Top-K (1..50257):';
  const topKInput = doc.createElement('input');
  topKInput.id = PROMPT_DOM_IDS.TOP_K;
  topKInput.type = 'number';
  topKInput.className = PROMPT_CLASSES.INPUT_NUM;
  topKInput.min = '1';
  topKInput.max = '50257';
  topKInput.value = String(defaultTopK);
  topKInput.setAttribute('aria-describedby', PROMPT_DOM_IDS.ERROR_TOP_K);
  const topKError = doc.createElement('div');
  topKError.id = PROMPT_DOM_IDS.ERROR_TOP_K;
  topKError.className = PROMPT_CLASSES.INLINE_ERROR;
  topKError.setAttribute('role', 'alert');
  topKGroup.append(topKLabel, topKInput, topKError);

  // Optional memory-only API key (no persistence)
  const apiKeyGroup = doc.createElement('div');
  apiKeyGroup.className = PROMPT_CLASSES.FIELD_GROUP;
  const apiKeyLabel = doc.createElement('label');
  apiKeyLabel.htmlFor = PROMPT_DOM_IDS.API_KEY;
  apiKeyLabel.className = PROMPT_CLASSES.LABEL;
  apiKeyLabel.textContent = 'API Key (optional, in-memory):';
  const apiKeyInput = doc.createElement('input');
  apiKeyInput.id = PROMPT_DOM_IDS.API_KEY;
  apiKeyInput.type = 'password';
  apiKeyInput.className = PROMPT_CLASSES.INPUT_TEXT;
  apiKeyInput.placeholder = 'Optional bearer token';
  apiKeyInput.autocomplete = 'off';
  apiKeyInput.setAttribute('aria-describedby', PROMPT_DOM_IDS.API_KEY_HELP);
  const apiKeyHelp = doc.createElement('div');
  apiKeyHelp.id = PROMPT_DOM_IDS.API_KEY_HELP;
  apiKeyHelp.className = PROMPT_CLASSES.LABEL;
  apiKeyHelp.textContent = 'Optional bearer token. Kept in memory for this tab only.';
  apiKeyGroup.append(apiKeyLabel, apiKeyInput, apiKeyHelp);

  controlsGrid.append(maxTokensGroup, tempGroup, topKGroup, apiKeyGroup);
  settingsPanel.append(controlsGrid);

  // General error banner
  const generalError = doc.createElement('div');
  generalError.id = PROMPT_DOM_IDS.ERROR_GENERAL;
  generalError.className = PROMPT_CLASSES.GENERAL_ERROR;
  generalError.setAttribute('role', 'alert');

  // Action buttons
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
  cancelBtn.textContent = 'Cancel';
  cancelBtn.disabled = true;

  const clearBtn = doc.createElement('button');
  clearBtn.id = PROMPT_DOM_IDS.CLEAR_BTN;
  clearBtn.type = 'button';
  clearBtn.className = PROMPT_CLASSES.BTN;
  clearBtn.textContent = 'Clear';

  const copyBtn = doc.createElement('button');
  copyBtn.id = PROMPT_DOM_IDS.COPY_BTN;
  copyBtn.type = 'button';
  copyBtn.className = PROMPT_CLASSES.BTN;
  copyBtn.textContent = 'Copy Output';
  copyBtn.disabled = true;

  actions.append(generateBtn, cancelBtn, clearBtn, copyBtn);
  form.append(tablist, composePanel, outputPanel, settingsPanel, generalError, actions);

  // Live announcement region for screen readers (announces completions/errors, not every token)
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

  // Tab switching state
  let currentTab = 'compose'; // 'compose' | 'output' | 'settings'

  function switchTab(tab) {
    if (currentTab === tab) return;
    currentTab = tab;

    tabCompose.setAttribute('aria-selected', tab === 'compose' ? 'true' : 'false');
    tabOutput.setAttribute('aria-selected', tab === 'output' ? 'true' : 'false');
    tabSettings.setAttribute('aria-selected', tab === 'settings' ? 'true' : 'false');

    tabCompose.className = tab === 'compose'
      ? `${PROMPT_CLASSES.TAB} ${PROMPT_CLASSES.TAB_ACTIVE}`
      : PROMPT_CLASSES.TAB;
    tabOutput.className = tab === 'output'
      ? `${PROMPT_CLASSES.TAB} ${PROMPT_CLASSES.TAB_ACTIVE}`
      : PROMPT_CLASSES.TAB;
    tabSettings.className = tab === 'settings'
      ? `${PROMPT_CLASSES.TAB} ${PROMPT_CLASSES.TAB_ACTIVE}`
      : PROMPT_CLASSES.TAB;

    composePanel.hidden = tab !== 'compose';
    outputPanel.hidden = tab !== 'output';
    settingsPanel.hidden = tab !== 'settings';
  }

  // Pager state
  let userNavigatedPage = false;
  let currentPageIndex = 0;
  let cachedPages = [''];

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
  const COPY_DEFAULT_LABEL = 'Copy Output';
  let copyTimer = null;

  if (controller.getApiKey()) {
    apiKeyInput.value = controller.getApiKey();
  }

  function handleApiKeySync() {
    controller.setApiKey(apiKeyInput.value);
  }

  function render(state) {
    statusBadge.textContent = `State: ${state.state}`;
    statusBadge.setAttribute('data-state', state.state);

    // Generation start automatically switches to Output tab and resets pager navigation
    const active = isGenerationActive(state.state);
    if (active && !isGenerationActive(previousState)) {
      switchTab('output');
      userNavigatedPage = false;
      currentPageIndex = 0;
    }

    // Output pagination
    const fullText = state.text || '';
    cachedPages = paginateText(fullText);
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

    pagerStatus.textContent = `Page ${currentPageIndex + 1} of ${totalPages}`;
    pagerPrevBtn.disabled = currentPageIndex <= 0;
    pagerNextBtn.disabled = currentPageIndex >= totalPages - 1;
    pagerLatestBtn.disabled = currentPageIndex >= totalPages - 1;

    // Health status display: checkpoint identity only when the launcher reports it
    const healthMsg = state.health.message || 'Model status unknown';
    healthStatus.textContent = healthMsg;
    healthStatus.title = healthMsg;
    healthStatus.setAttribute('data-status', state.health.status);

    // Inline validation error presentation
    promptError.textContent = state.validationErrors?.prompt || '';
    promptInput.setAttribute('aria-invalid', state.validationErrors?.prompt ? 'true' : 'false');

    maxTokensError.textContent = state.validationErrors?.maxTokens || '';
    maxTokensInput.setAttribute('aria-invalid', state.validationErrors?.maxTokens ? 'true' : 'false');

    tempError.textContent = state.validationErrors?.temperature || '';
    tempInput.setAttribute('aria-invalid', state.validationErrors?.temperature ? 'true' : 'false');

    topKError.textContent = state.validationErrors?.topK || '';
    topKInput.setAttribute('aria-invalid', state.validationErrors?.topK ? 'true' : 'false');

    const hasValidationErrors = Object.keys(state.validationErrors || {}).length > 0;

    // Switch view to display relevant validation errors
    if (hasValidationErrors) {
      if (state.validationErrors?.maxTokens || state.validationErrors?.temperature || state.validationErrors?.topK) {
        switchTab('settings');
      } else if (state.validationErrors?.prompt) {
        switchTab('compose');
      }
      generalError.textContent = '';
      runIdBadge.textContent = 'Run ID: -';
      usageBadge.textContent = '';
      finishReasonBadge.textContent = '';
    } else {
      generalError.textContent = state.error || actionError || '';

      if (state.runId) {
        runIdBadge.textContent = state.modelCompletionId
          ? `Run ID: ${state.runId} (${state.modelCompletionId})`
          : `Run ID: ${state.runId}`;
      } else {
        runIdBadge.textContent = 'Run ID: -';
      }

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

    const ready = Boolean(state.health?.ready);
    generateBtn.disabled = active || !ready;
    cancelBtn.disabled = !active;
    clearBtn.disabled = active;
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

  const unsubscribe = controller.subscribe(render);
  render(controller.getState());

  // Form submission handler
  async function handleSubmit(event) {
    if (event) {
      event.preventDefault();
    }
    actionError = null;
    const currentState = controller.getState();
    if (controller.isActive() || !currentState.health?.ready) return;

    controller.setApiKey(apiKeyInput.value);

    const params = {
      prompt: promptInput.value,
      maxTokens: maxTokensInput.value,
      temperature: tempInput.value,
      topK: topKInput.value,
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
      const hasValidationErrors = Object.keys(controller.getState().validationErrors || {}).length > 0;
      if (!hasValidationErrors && !controller.getState().error) {
        generalError.textContent = '';
      }

      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBtn.textContent = COPY_DEFAULT_LABEL;
        copyTimer = null;
      }, 1500);
    } catch {
      actionError = 'Unable to copy to clipboard.';
      const hasValidationErrors = Object.keys(controller.getState().validationErrors || {}).length > 0;
      if (!hasValidationErrors) {
        generalError.textContent = actionError;
      }
    }
  }

  function handleCancel() {
    controller.cancel();
  }

  function handleClear() {
    if (controller.isActive()) return;
    actionError = null;
    promptInput.value = '';
    userNavigatedPage = false;
    currentPageIndex = 0;
    cachedPages = [''];
    controller.clear();
    switchTab('compose');
    announcement.textContent = 'Prompt and output cleared.';
  }

  function handleRetryHealth() {
    controller.setApiKey(apiKeyInput.value);
    controller.checkHealth();
  }

  function handleTabComposeClick() {
    switchTab('compose');
  }

  function handleTabOutputClick() {
    switchTab('output');
  }

  function handleTabSettingsClick() {
    switchTab('settings');
  }

  form.addEventListener('submit', handleSubmit);
  promptInput.addEventListener('keydown', handleKeyDown);
  apiKeyInput.addEventListener('input', handleApiKeySync);
  apiKeyInput.addEventListener('change', handleApiKeySync);
  cancelBtn.addEventListener('click', handleCancel);
  clearBtn.addEventListener('click', handleClear);
  copyBtn.addEventListener('click', handleCopy);
  healthRetryBtn.addEventListener('click', handleRetryHealth);

  tabCompose.addEventListener('click', handleTabComposeClick);
  tabOutput.addEventListener('click', handleTabOutputClick);
  tabSettings.addEventListener('click', handleTabSettingsClick);

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
    unsubscribe();
    form.removeEventListener('submit', handleSubmit);
    promptInput.removeEventListener('keydown', handleKeyDown);
    apiKeyInput.removeEventListener('input', handleApiKeySync);
    apiKeyInput.removeEventListener('change', handleApiKeySync);
    cancelBtn.removeEventListener('click', handleCancel);
    clearBtn.removeEventListener('click', handleClear);
    copyBtn.removeEventListener('click', handleCopy);
    healthRetryBtn.removeEventListener('click', handleRetryHealth);

    tabCompose.removeEventListener('click', handleTabComposeClick);
    tabOutput.removeEventListener('click', handleTabOutputClick);
    tabSettings.removeEventListener('click', handleTabSettingsClick);

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
