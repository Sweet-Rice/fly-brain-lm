/**
 * DOM-free Generation Controller and SSE Streaming Client.
 *
 * Provides state machine, SSE chunk decoding with multibyte UTF-8 handling,
 * parameter validation, model health checking, cancellation, and safe error reporting.
 * Reusable directly in React or other UI frameworks.
 */

/**
 * @typedef {import('./inference-contract/v1/types.js').GenerationInput} GenerationInput
 * @typedef {import('./inference-contract/v1/types.js').ValidationErrors} ValidationErrors
 * @typedef {import('./inference-contract/v1/types.js').GenerationState} GenerationState
 * @typedef {import('./inference-contract/v1/types.js').HealthSnapshot} HealthSnapshot
 * @typedef {import('./inference-contract/v1/types.js').GenerationClientSnapshot} GenerationClientSnapshot
 * @typedef {import('./inference-contract/v1/types.js').GenerationClientOptions} GenerationClientOptions
 * @typedef {import('./inference-contract/v1/types.js').GenerationSubmitOptions} GenerationSubmitOptions
 * @typedef {import('./inference-contract/v1/types.js').GenerationResult} GenerationResult
 * @typedef {import('./inference-contract/v1/types.js').TokenUsage} TokenUsage
 * @typedef {import('./inference-contract/v1/types.js').FinishReason} FinishReason
 *
 * Fields consumed from compatible SSE JSON events. Absent metadata remains absent,
 * and error payloads are supported without requiring a successful-completion envelope.
 * @typedef {Partial<import('./inference-contract/v1/types.js').CompletionEnvelope> & {
 *   choices?: import('./inference-contract/v1/types.js').TextChunk['choices'] |
 *     import('./inference-contract/v1/types.js').FinishChunk['choices'] |
 *     import('./inference-contract/v1/types.js').UsageChunk['choices'],
 *   usage?: TokenUsage,
 *   error?: string | {message?: string}
 * }} StreamMessage
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
 * @param {GenerationState} state
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
 * @param {GenerationInput} [params]
 * @returns {{valid: boolean, errors: ValidationErrors}}
 */
export function validateParams(params = {}) {
  /** @type {ValidationErrors} */
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

// Redact credentials and local filesystem paths from server-provided error text.
const SECRET_PATTERN = /(?:bearer\s+[A-Za-z0-9._~+/-]+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]+['"]?)/gi;
const PATH_PATTERN = /(?:\\\\[A-Za-z0-9._-]+\\[^\s:;'"<>)]+|\b[A-Za-z]:[\\/][^\s:;'"<>)]+|\/(?:home|Users|usr|var|tmp|etc|opt|root|mnt|private|workspace)[^\s:;'"<>)]*)/g;

/** @param {unknown} msg */
function sanitizeSafeMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  const trimmed = msg.trim();
  if (trimmed.includes('Traceback (most recent call last)') || /<[a-z][\s\S]*>/i.test(trimmed)) {
    return 'Model server returned an internal error.';
  }
  return trimmed.replace(SECRET_PATTERN, '[secret]').replace(PATH_PATTERN, '[path]');
}

/**
 * Formats user-facing errors without technical stack traces.
 * Offers helpful guidance if static python -m http.server is run without app_server proxy.
 * @param {unknown} error
 * @param {Pick<Response, 'status' | 'statusText'> | null} [response]
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
    if ('name' in error && error.name === 'AbortError') {
      return 'Generation was cancelled.';
    }
    if ('message' in error && typeof error.message === 'string') {
      const msg = error.message;
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('fetch failed')) {
        return 'Network connection failed. Ensure the model server or app_server proxy is running.';
      }
      return sanitizeSafeMessage(msg);
    }
  }

  return 'An unexpected error occurred during generation.';
}

const MODEL_LOADING_MESSAGE =
  'Model loading: the model server is loading its checkpoint. This page is ready; Generate unlocks automatically when the model answers.';
const MODEL_EXITED_MESSAGE =
  'Model stopped: the model server process exited. Restart python -m harness.app_server to relaunch it.';
const SERVICE_UNAVAILABLE_MESSAGE =
  'Model service unavailable: the model server is not running or is still starting. This page is ready; it checks again every 10 seconds, or use Retry Health.';

/**
 * @param {HealthSnapshot} a
 * @param {HealthSnapshot} b
 * @returns {boolean}
 */
function sameHealth(a, b) {
  return (
    a.status === b.status &&
    a.ready === b.ready &&
    a.modelId === b.modelId &&
    a.note === b.note &&
    a.message === b.message &&
    a.checkpoint?.name === b.checkpoint?.name &&
    a.checkpoint?.sha256 === b.checkpoint?.sha256
  );
}

/**
 * Low-level SSE Line and Event Parser.
 * Buffers partial chunks, handles UTF-8 multi-byte sequences across chunk boundaries,
 * supports both CRLF and LF delimiters, and ignores SSE comments.
 */
export class SSELineParser {
  /** @param {{onEvent?: (data: string) => unknown}} [options] */
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8');
    /** @type {string[]} */
    this.currentData = [];
  }

  /** @param {string | Uint8Array | null} chunk */
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

  /** @param {string} str @param {boolean} isDone */
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

  /** @param {string} line */
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
 * @param {ReadableStream<Uint8Array | string> | null} stream
 * @param {{onEvent?: (data: string) => {done?: boolean} | void, signal?: AbortSignal | null}} [options]
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
  /** @param {GenerationClientOptions} [options] */
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

    /** @type {GenerationState} */
    this.state = GENERATION_STATES.IDLE;
    /** @type {string | null} */
    this.currentRunId = null;
    /** @type {string | null} */
    this.modelCompletionId = null;
    this.text = '';
    /** @type {FinishReason | null} */
    this.finishReason = null;
    /** @type {TokenUsage | null} */
    this.usage = null;
    /** @type {string | null} */
    this.error = null;
    /** @type {ValidationErrors} */
    this.validationErrors = {};

    /** @type {HealthSnapshot} */
    this.health = {
      status: 'unknown',
      modelId: null,
      note: null,
      message: 'Model status unknown',
      ready: false,
      checkpoint: null,
    };

    /** @type {Set<(snapshot: GenerationClientSnapshot) => void>} */
    this.listeners = new Set();
    this.notificationRevision = 0;
    /** @type {AbortController | null} */
    this.abortController = null;
    /** @type {AbortController | null} */
    this.healthAbortController = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.healthTimer = null;
    this.healthRequestId = 0;
    this.disposed = false;
  }

  /** @returns {GenerationClientSnapshot} */
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
      health: {
        ...this.health,
        checkpoint: this.health.checkpoint ? { ...this.health.checkpoint } : null,
      },
    };
  }

  /** @param {(snapshot: GenerationClientSnapshot) => void} listener */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const revision = ++this.notificationRevision;
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      // Re-entrant notification makes this snapshot obsolete for remaining listeners.
      if (revision !== this.notificationRevision) break;
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

  /** @param {string | null | undefined} key */
  setApiKey(key) {
    this.apiKey = typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
  }

  getApiKey() {
    return this.apiKey;
  }

  /** @returns {Promise<HealthSnapshot>} */
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
        message: 'Checking whether the model service is ready…',
      };
      this.notify();
    }

    try {
      /** @type {Record<string, string>} */
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
        let errorType = null;
        try {
          const body = await res.json();
          errorType = body?.error?.type;
        } catch {
          /* non-JSON error body: fall back to HTTP status guidance */
        }

        if (this.disposed || this.healthRequestId !== requestId) {
          return this.health;
        }

        /** @type {HealthSnapshot['status']} */
        let status = 'error';
        let message;
        if (errorType === 'model_loading') {
          status = 'loading';
          message = MODEL_LOADING_MESSAGE;
        } else if (errorType === 'model_exited') {
          message = MODEL_EXITED_MESSAGE;
        } else if (errorType === 'service_unavailable') {
          message = SERVICE_UNAVAILABLE_MESSAGE;
        } else {
          message = formatSafeError(null, res);
        }

        return this.applyHealth({
          status,
          modelId: null,
          note: null,
          message,
          ready: false,
          checkpoint: null,
        });
      }

      const data = await res.json();
      if (this.disposed || this.healthRequestId !== requestId) {
        return this.health;
      }

      const modelId = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : null;
      const note = typeof data.note === 'string' && data.note.trim() ? data.note.trim() : null;
      const isReady = data.status === 'ok';

      /** @type {{ name: string; sha256: string } | null} */
      let checkpoint = null;
      if (
        isReady &&
        data.checkpoint &&
        typeof data.checkpoint === 'object' &&
        typeof data.checkpoint.name === 'string' &&
        data.checkpoint.name.trim().length > 0 &&
        typeof data.checkpoint.sha256 === 'string' &&
        /^[0-9a-f]{64}$/i.test(data.checkpoint.sha256)
      ) {
        checkpoint = {
          name: data.checkpoint.name.trim(),
          sha256: data.checkpoint.sha256.toLowerCase(),
        };
      }

      let message;
      if (isReady) {
        message = `Model ready: ${modelId ?? 'label not reported'}${note ? ` (${note})` : ''} · checkpoint ${checkpoint ? `${checkpoint.name} sha256:${checkpoint.sha256.slice(0, 12)}` : 'not reported'}`;
      } else {
        message = data.status ? `Model reported status: ${data.status}` : 'Model status unavailable';
      }

      return this.applyHealth({
        status: isReady ? 'ready' : 'error',
        modelId,
        note,
        message,
        ready: isReady,
        checkpoint,
      });
    } catch (err) {
      if (this.disposed || this.healthRequestId !== requestId) {
        return this.health;
      }
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') return this.health;
      const message = formatSafeError(err);
      return this.applyHealth({
        status: 'error',
        modelId: null,
        note: null,
        message,
        ready: false,
        checkpoint: null,
      });
    }
  }

  /**
   * Stores a health snapshot, notifying subscribers only when it changed (no polling churn).
   * @param {HealthSnapshot} next
   * @returns {HealthSnapshot}
   */
  applyHealth(next) {
    const changed = !sameHealth(this.health, next);
    this.health = next;
    if (changed) {
      this.notify();
    }
    return next;
  }

  /** @param {{intervalMs?: number}} [options] */
  startHealthPolling({ intervalMs = 10000 } = {}) {
    if (this.disposed) throw new Error('Cannot poll health after disposal');
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

  /**
   * @param {GenerationInput} [params]
   * @param {GenerationSubmitOptions} [options]
   * @returns {Promise<GenerationResult>}
   */
  async submit(params = {}, { onGenerate = null } = {}) {
    if (this.disposed) throw new Error('Cannot submit after disposal');
    if (this.isActive()) {
      throw new Error(`Cannot submit: generation already in progress (state: ${this.state})`);
    }

    // A validation subscriber may cancel, dispose, or replace this attempt synchronously.
    const abortController = new AbortController();
    this.abortController = abortController;
    // The captured signal owns cancellation even if a subscriber starts a newer run.
    // Attempt identity also rejects stale work when failed validation retains the previous run id.
    const signal = abortController.signal;

    this.state = GENERATION_STATES.VALIDATING;
    this.validationErrors = {};
    this.error = null;
    this.notify();

    if (this.abortController !== abortController) return { success: false, aborted: true };
    if (signal.aborted) return { success: false, cancelled: true };

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

    const prompt = /** @type {string} */ (params.prompt); // validateParams rejected missing or non-string prompts.
    const maxTokens = Number(params.maxTokens ?? params.max_tokens);
    const temperature = Number(params.temperature);
    const topK = Number(params.topK ?? params.top_k);

    this.state = GENERATION_STATES.SUBMITTING;
    this.notify();

    if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
    if (signal.aborted) return { success: false, cancelled: true };

    if (typeof onGenerate === 'function') {
      try {
        await onGenerate({ prompt, maxTokens, temperature, topK, runId });
      } catch (cbErr) {
        if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
        if (signal.aborted) return { success: false, cancelled: true };
        this.state = GENERATION_STATES.FAILED;
        const error = formatSafeError(cbErr);
        this.error = error;
        this.notify();
        return { success: false, error };
      }
    }

    if (this.abortController !== abortController || this.currentRunId !== runId) {
      return { success: false, aborted: true };
    }
    if (signal.aborted) {
      return { success: false, cancelled: true };
    }

    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    /** @type {import('./inference-contract/v1/types.js').StreamingCompletionRequest} */
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
      if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true };
      }
      this.state = GENERATION_STATES.FAILED;
      const error = formatSafeError(netErr);
      this.error = error;
      this.notify();
      return { success: false, error };
    }

    if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
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

      if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true };
      }

      this.state = GENERATION_STATES.FAILED;
      const error = formatSafeError(errMsg || `HTTP ${response.status}: ${response.statusText}`, response);
      this.error = error;
      this.notify();
      return { success: false, error };
    }
    this.state = GENERATION_STATES.STREAMING;
    this.notify();

    let receivedDone = false;
    let accumulatedText = '';

    try {
      await parseSSEStream(response.body, {
        signal,
        onEvent: (rawData) => {
          if (this.abortController !== abortController || this.currentRunId !== runId || signal.aborted) return { done: true };

          if (rawData === '[DONE]') {
            receivedDone = true;
            return { done: true };
          }

          /** @type {StreamMessage} */
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

      if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };
      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true, text: accumulatedText };
      }

      if (!receivedDone) {
        throw new Error('Stream truncated: connection closed before [DONE]');
      }

      this.state = GENERATION_STATES.COMPLETED;
      // Subscribers may synchronously start another run; capture this result first.
      /** @type {GenerationResult} */
      const result = {
        success: true,
        text: this.text,
        runId,
        usage: this.usage,
        finishReason: this.finishReason,
      };
      this.notify();
      return result;
    } catch (streamErr) {
      if (this.abortController !== abortController || this.currentRunId !== runId) return { success: false, aborted: true };

      if (signal.aborted) {
        this.state = GENERATION_STATES.CANCELLED;
        this.notify();
        return { success: false, cancelled: true, text: accumulatedText };
      }

      this.state = GENERATION_STATES.FAILED;
      const error = formatSafeError(streamErr);
      this.error = error;
      this.notify();
      return { success: false, error, text: accumulatedText };
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
