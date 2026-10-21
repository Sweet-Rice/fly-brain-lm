/**
 * DOM-free Generation Controller and SSE Streaming Client.
 *
 * Provides state machine, SSE chunk decoding with multibyte UTF-8 handling,
 * parameter validation, model health checking, cancellation, and safe error reporting.
 * Reusable directly in React or other UI frameworks.
 */

export const GENERATION_STATES = Object.freeze({
  IDLE: 'idle',
  VALIDATING: 'validating',
  SUBMITTING: 'submitting',
  STREAMING: 'streaming',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

/**
 * Returns true if the generation controller is in an active, non-terminal state.
 */
export function isGenerationActive(state) {
  return (
    state === GENERATION_STATES.VALIDATING ||
    state === GENERATION_STATES.SUBMITTING ||
    state === GENERATION_STATES.STREAMING ||
    state === GENERATION_STATES.CANCELLING
  );
}

/**
 * Validates prompt and sampling parameters.
 * Produces specific inline error messages for accessible display.
 */
export function validateParams(params = {}) {
  const errors = {};

  const prompt = params.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    errors.prompt = 'Prompt cannot be blank.';
  }

  const rawMaxTokens = params.maxTokens ?? params.max_tokens;
  const maxTokens = (rawMaxTokens === '' || rawMaxTokens === null || rawMaxTokens === undefined)
    ? NaN
    : Number(rawMaxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128) {
    errors.maxTokens = 'Max tokens must be an integer between 1 and 128.';
  }

  const rawTemperature = params.temperature;
  const temperature = (rawTemperature === '' || rawTemperature === null || rawTemperature === undefined)
    ? NaN
    : Number(rawTemperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    errors.temperature = 'Temperature must be a finite number between 0 and 2.';
  }

  const rawTopK = params.topK ?? params.top_k;
  const topK = (rawTopK === '' || rawTopK === null || rawTopK === undefined)
    ? NaN
    : Number(rawTopK);
  if (!Number.isInteger(topK) || topK < 1 || topK > 50257) {
    errors.topK = 'Top-K must be an integer between 1 and 50257.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

function sanitizeSafeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  const trimmed = msg.trim();
  if (trimmed.includes('Traceback (most recent call last)') || /<[a-z][\s\S]*>/i.test(trimmed)) {
    return 'Model server returned an internal error.';
  }
  return trimmed;
}

/**
 * Formats user-facing errors without technical stack traces.
 * Offers helpful guidance if static python -m http.server is run without app_server proxy.
 */
function formatSafeError(error, response = null) {
  const proxyInstruction = 'In static http.server mode, run python -m harness.app_server to proxy /health and /v1/completions.';
  if (response) {
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      const desc = response.statusText ? ` ${response.statusText}` : (response.status === 404 ? ' Not Found' : '');
      return `Model endpoint returned ${response.status}${desc}. ${proxyInstruction}`;
    }
    if (response.status === 401) {
      return 'Authentication failed: invalid API key.';
    }
    if (response.status === 403) {
      return 'Access forbidden by model server.';
    }
    if (typeof error === 'string' && error.trim().length > 0 && !error.startsWith('HTTP ')) {
      return sanitizeSafeMessage(error);
    }
    if (response.status >= 500) {
      return `Model server error (${response.status} ${response.statusText || 'Internal Server Error'}). Check that the model API is running, then Retry Health.`;
    }
  }

  if (typeof error === 'string') {
    return sanitizeSafeMessage(error);
  }

  if (error && typeof error === 'object') {
    if (error.name === 'AbortError') {
      return 'Generation was cancelled.';
    }
    if (error.message) {
      const msg = error.message;
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('fetch failed')) {
        return 'Network connection failed. Ensure the model server or app_server proxy is running.';
      }
      return sanitizeSafeMessage(msg);
    }
  }

  return 'An unexpected error occurred during generation.';
}

/**
 * Low-level SSE Line and Event Parser.
 * Buffers partial chunks, handles UTF-8 multi-byte sequences across chunk boundaries,
 * supports both CRLF and LF delimiters, and ignores SSE comments.
 */
export class SSELineParser {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8');
    this.currentData = [];
  }

  feed(chunk, isDone = false) {
    if (chunk) {
      if (typeof chunk === 'string') {
        this.buffer += chunk;
      } else {
        this.buffer += this.decoder.decode(chunk, { stream: !isDone });
      }
    }
    if (isDone) {
      this.buffer += this.decoder.decode();
    }

    while (this.buffer.length > 0) {
      const nl = this.findNewline(this.buffer, isDone);
      if (!nl) break;

      const line = this.buffer.slice(0, nl.index);
      this.buffer = this.buffer.slice(nl.index + nl.length);
      this.processLine(line);
    }

    if (isDone) {
      if (this.buffer.length > 0) {
        this.processLine(this.buffer);
        this.buffer = '';
      }
      this.flushEvent();
    }
  }

  findNewline(str, isDone) {
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (char === '\n') {
        return { index: i, length: 1 };
      }
      if (char === '\r') {
        if (i === str.length - 1) {
          if (!isDone) return null; // wait for next byte to see if \n follows
          return { index: i, length: 1 };
        }
        if (str[i + 1] === '\n') {
          return { index: i, length: 2 };
        }
        return { index: i, length: 1 };
      }
    }
    return null;
  }

  processLine(line) {
    if (line === '') {
      this.flushEvent();
      return;
    }
    if (line.startsWith(':')) {
      // SSE comment
      return;
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      this.currentData.push(value);
    }
  }

  flushEvent() {
    if (this.currentData.length === 0) return;
    const rawData = this.currentData.join('\n');
    this.currentData = [];
    this.onEvent(rawData);
  }
}

/**
 * Consumes a ReadableStream of byte chunks or strings and invokes onEvent for SSE payloads.
 */
async function parseSSEStream(stream, { onEvent = () => {}, signal = null } = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error('Invalid stream source provided to parseSSEStream');
  }

  let shouldStop = false;
  const parser = new SSELineParser({
    onEvent: (rawData) => {
      const res = onEvent(rawData);
      if (res?.done) {
        shouldStop = true;
      }
    },
  });

  const reader = stream.getReader();
  let onAbort;
  try {
    if (signal) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException('Aborted', 'AbortError');
      }
      onAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    while (!shouldStop) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (done) {
        parser.feed(null, true);
        break;
      }
      parser.feed(value, false);
      if (shouldStop) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    if (onAbort && signal) {
      signal.removeEventListener('abort', onAbort);
    }
    try {
      reader.releaseLock?.();
    } catch {
      // already released
    }
  }
}

/**
 * DOM-free Generation Controller.
 * Manages model readiness, input submission, SSE parsing, cancellation, and telemetry state.
 */
export class GenerationController {
  constructor({
    endpoint = '/v1/completions',
    healthEndpoint = '/health',
    fetch = globalThis.fetch?.bind(globalThis),
    apiKey = null,
  } = {}) {
    this.endpoint = endpoint;
    this.healthEndpoint = healthEndpoint;
    this.fetch = fetch || globalThis.fetch?.bind(globalThis);
    this.apiKey = typeof apiKey === 'string' && apiKey.trim().length > 0 ? apiKey.trim() : null;

    this.state = GENERATION_STATES.IDLE;
    this.currentRunId = null;
    this.modelCompletionId = null;
    this.text = '';
    this.finishReason = null;
    this.usage = null;
    this.error = null;
    this.validationErrors = {};

    this.health = {
      status: 'unknown',
      modelId: null,
      note: null,
      message: 'Model status unknown',
      ready: false,
    };

    this.listeners = new Set();
    this.abortController = null;
    this.healthAbortController = null;
    this.healthTimer = null;
    this.healthRequestId = 0;
    this.disposed = false;
  }

  getState() {
    return {
      state: this.state,
      runId: this.currentRunId,
      modelCompletionId: this.modelCompletionId,
      text: this.text,
      finishReason: this.finishReason,
      usage: this.usage ? { ...this.usage } : null,
      error: this.error,
      validationErrors: { ...this.validationErrors },
      health: { ...this.health },
    };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        // Prevent subscriber error from breaking state loop
        console.error('Subscriber error in GenerationController:', err);
      }
    }
  }

  isActive() {
    return isGenerationActive(this.state);
  }

  setApiKey(key) {
    this.apiKey = typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
  }

  getApiKey() {
    return this.apiKey;
  }

  async checkHealth() {
    if (this.disposed) return this.health;

    this.healthAbortController?.abort();
    this.healthAbortController = new AbortController();
    const requestId = ++this.healthRequestId;

    // Only set checking message and notify if status is currently unknown to avoid polling churn
    if (this.health.status === 'unknown') {
      this.health = {
        ...this.health,
        status: 'checking',
        message: 'Checking model status...',
      };
      this.notify();
    }

    try {
      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await this.fetch(this.healthEndpoint, {
        method: 'GET',
        headers,
        signal: this.healthAbortController.signal,
      });

      if (this.disposed || this.healthRequestId !== requestId) {
        return this.health;
      }

      if (!res.ok) {
        const message = formatSafeError(null, res);
        const hasChanged = this.health.status !== 'error' ||
          this.health.ready !== false ||
          this.health.message !== message;
        this.health = {
          status: 'error',
          modelId: null,
          note: null,
          message,
          ready: false,
        };
        if (hasChanged) {
          this.notify();
        }
        return this.health;
      }

      const data = await res.json();
      if (this.disposed || this.healthRequestId !== requestId) {
        return this.health;
      }

      const modelId = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null;
      const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : null;
      const isReady = data.status === 'ok';

      let message;
      if (isReady) {
        if (modelId && note) {
          message = `Model: ${modelId} (${note})`;
        } else if (modelId) {
          message = `Model: ${modelId}`;
        } else {
          message = 'Model ready (metadata unavailable)';
        }
      } else {
        message = data.status ? `Model reported status: ${data.status}` : 'Model status unavailable';
      }

      const nextStatus = isReady ? 'ready' : 'error';
      const hasChanged = this.health.status !== nextStatus ||
        this.health.ready !== isReady ||
        this.health.modelId !== modelId ||
        this.health.note !== note ||
        this.health.message !== message;

      this.health = {
        status: nextStatus,
        modelId,
        note,
        message,
        ready: isReady,
      };

      if (hasChanged) {
        this.notify();
      }
      return this.health;
    } catch (err) {
      if (this.disposed || this.healthRequestId !== requestId) {
        return this.health;
      }
      if (err.name === 'AbortError') return this.health;
      const message = formatSafeError(err);
      const hasChanged = this.health.status !== 'error' ||
        this.health.ready !== false ||
        this.health.message !== message;
      this.health = {
        status: 'error',
        modelId: null,
        note: null,
        message,
        ready: false,
      };
      if (hasChanged) {
        this.notify();
      }
      return this.health;
    }
  }

  startHealthPolling({ intervalMs = 10000 } = {}) {
    this.stopHealthPolling();
    this.checkHealth();
    this.healthTimer = setInterval(() => {
      this.checkHealth();
    }, intervalMs);
  }
  stopHealthPolling() {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async submit(params = {}, { onGenerate = null } = {}) {
    if (this.isActive()) {
      throw new Error(`Cannot submit: generation already in progress (state: ${this.state})`);
    }

    this.state = GENERATION_STATES.VALIDATING;
    this.validationErrors = {};
    this.error = null;
    this.notify();

    // Validate inputs prior to callback and network call
    const validation = validateParams(params);
    if (!validation.valid) {
      this.state = GENERATION_STATES.FAILED;
      this.validationErrors = validation.errors;
      this.error = 'Validation failed';
      this.notify();
      return { success: false, errors: validation.errors };
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.currentRunId = runId;
    this.text = '';
    this.usage = null;
    this.finishReason = null;
    this.modelCompletionId = null;

    const abortController = new AbortController();
    this.abortController = abortController;
    const signal = abortController.signal;

    const prompt = params.prompt;
    const maxTokens = Number(params.maxTokens ?? params.max_tokens);
    const temperature = Number(params.temperature);
    const topK = Number(params.topK ?? params.top_k);

    this.state = GENERATION_STATES.SUBMITTING;
    this.notify();

    if (typeof onGenerate === 'function') {
      try {
        await onGenerate({ prompt, maxTokens, temperature, topK, runId });
      } catch (cbErr) {
        if (this.currentRunId !== runId) return { success: false, aborted: true };
        this.state = GENERATION_STATES.FAILED;
        this.error = formatSafeError(cbErr);
        this.notify();
        return { success: false, error: this.error };
      }
    }

    if (this.currentRunId !== runId) {
      return { success: false, aborted: true };
    }
    if (signal.aborted || this.state === GENERATION_STATES.CANCELLED) {
      return { success: false, cancelled: true };
    }

    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const payload = {
      prompt,
      max_tokens: maxTokens,
      temperature,
      top_k: topK,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    };

    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
    } catch (netErr) {
      if (this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted || this.state === GENERATION_STATES.CANCELLING) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true };
      }
      this.state = GENERATION_STATES.FAILED;
      this.error = formatSafeError(netErr);
      this.notify();
      return { success: false, error: this.error };
    }

    if (this.currentRunId !== runId) return { success: false, aborted: true };
    if (signal.aborted) {
      this.state = GENERATION_STATES.CANCELLED;
      this.notify();
      return { success: false, cancelled: true };
    }

    if (!response.ok) {
      let errMsg;
      try {
        const errData = await response.json();
        errMsg = errData?.error?.message || errData?.message;
      } catch {
        // non-JSON error
      }

      if (this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true };
      }

      this.state = GENERATION_STATES.FAILED;
      this.error = formatSafeError(errMsg || `HTTP ${response.status}: ${response.statusText}`, response);
      this.notify();
      return { success: false, error: this.error };
    }
    this.state = GENERATION_STATES.STREAMING;
    this.notify();

    let receivedDone = false;
    let accumulatedText = '';

    try {
      await parseSSEStream(response.body, {
        signal,
        onEvent: (rawData) => {
          if (this.currentRunId !== runId || signal.aborted) return { done: true };

          if (rawData === '[DONE]') {
            receivedDone = true;
            return { done: true };
          }

          let chunkObj;
          try {
            chunkObj = JSON.parse(rawData);
          } catch {
            throw new Error('Malformed stream: invalid event payload');
          }

          if (chunkObj.error) {
            const msg = typeof chunkObj.error === 'string'
              ? chunkObj.error
              : (chunkObj.error.message || 'Stream error from model server');
            throw new Error(msg);
          }

          if (chunkObj.id) {
            this.modelCompletionId = chunkObj.id;
          }

          if (chunkObj.usage) {
            this.usage = chunkObj.usage;
          }

          if (Array.isArray(chunkObj.choices)) {
            for (const choice of chunkObj.choices) {
              if (typeof choice.text === 'string') {
                accumulatedText += choice.text;
                this.text = accumulatedText;
              }
              if (choice.finish_reason) {
                this.finishReason = choice.finish_reason;
              }
            }
          }
          this.notify();
        },
      });

      if (this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true, text: this.text };
      }

      if (!receivedDone) {
        throw new Error('Stream truncated: connection closed before [DONE]');
      }

      this.state = GENERATION_STATES.COMPLETED;
      this.notify();
      return {
        success: true,
        text: this.text,
        runId: this.currentRunId,
        usage: this.usage,
        finishReason: this.finishReason,
      };
    } catch (streamErr) {
      if (this.currentRunId !== runId) return { success: false, aborted: true };

      if (signal.aborted || this.state === GENERATION_STATES.CANCELLING) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true, text: this.text };
      }

      this.state = GENERATION_STATES.FAILED;
      this.error = formatSafeError(streamErr);
      this.notify();
      return { success: false, error: this.error, text: this.text };
    }
  }

  cancel() {
    if (!this.isActive()) return;
    this.state = GENERATION_STATES.CANCELLING;
    this.notify();
    this.abortController?.abort();
    this.state = GENERATION_STATES.CANCELLED;
    this.notify();
  }

  clear() {
    if (this.isActive()) {
      throw new Error(`Cannot clear while generation is active (state: ${this.state})`);
    }
    this.text = '';
    this.usage = null;
    this.finishReason = null;
    this.error = null;
    this.validationErrors = {};
    this.modelCompletionId = null;
    this.currentRunId = null;
    this.state = GENERATION_STATES.IDLE;
    this.notify();
  }

  dispose() {
    this.disposed = true;
    this.stopHealthPolling();
    this.healthAbortController?.abort();
    this.cancel();
    this.listeners.clear();
  }
}
