const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isStep = value => Number.isSafeInteger(value) && value >= -1;
const isTime = value => typeof value === 'string' && /^[0-9]+$/.test(value);
const phases = ['queued', 'prefill', 'decode', 'completed', 'cancelled', 'failed'];
const terminal = phase => ['completed', 'cancelled', 'failed'].includes(phase);
const fields = {
  request_lifecycle: ['impl', 'model_id', 'ckpt_digest', 'phase', 't_start',
    'prompt_raw_tokens', 'prompt_tokens', 'max_tokens', 'completion_tokens',
    'finish_reason', 'server_time_ms', 'timestamp_ns'],
  token_step: ['kind', 'token_index', 'token_id', 'token_text', 'token_bytes',
    'step_status', 't', 'step_rel_us', 'emit_rel_us', 'step_ns', 'emit_ns'],
  stream_status: ['event', 'dropped_steps', 'server_time_ms'],
};

export function validateTelemetryMessage(message) {
  if (!isObject(message) || !Object.hasOwn(fields, message.type)
      || typeof message.run_id !== 'string' || !isCount(message.seq)
      || !isCount(message.epoch)) return false;
  if (message.type === 'stream_status') {
    return ['gap', 'resync', 'epoch_reset'].includes(message.event)
      && isCount(message.dropped_steps) && isCount(message.server_time_ms)
      && (message.event === 'gap' || message.dropped_steps === 0);
  }
  if (typeof message.request_id !== 'string') return false;
  if (message.type === 'request_lifecycle') {
    return ['impl', 'model_id', 'ckpt_digest'].every(key => typeof message[key] === 'string')
      && phases.includes(message.phase) && isStep(message.t_start)
      && ['prompt_raw_tokens', 'prompt_tokens', 'max_tokens', 'completion_tokens', 'server_time_ms']
        .every(key => isCount(message[key])) && isTime(message.timestamp_ns)
      && (message.phase !== 'queued' || (message.prompt_tokens === 0 && message.t_start === -1))
      && (message.phase === 'completed' ? ['stop', 'length'].includes(message.finish_reason)
        : message.phase === 'cancelled' ? message.finish_reason === 'cancelled'
          : message.phase === 'failed' ? message.finish_reason === 'error'
            : message.finish_reason === 'none');
  }
  const unprocessed = message.step_status === 'unprocessed';
  return ['prompt', 'completion'].includes(message.kind)
    && ['token_index', 'token_id', 'step_rel_us', 'emit_rel_us'].every(key => isCount(message[key]))
    && typeof message.token_text === 'string' && typeof message.token_bytes === 'string'
    && /^(?:[0-9a-f]{2})*$/.test(message.token_bytes)
    && ['stepped_fired', 'stepped_silent', 'unprocessed'].includes(message.step_status)
    && isStep(message.t) && isTime(message.step_ns) && isTime(message.emit_ns)
    && (unprocessed ? message.kind === 'completion' && message.t === -1
      && message.step_rel_us === 0 && message.step_ns === '0' : message.t >= 0)
    && (message.kind !== 'prompt' || (message.step_rel_us === message.emit_rel_us
      && message.step_ns === message.emit_ns));
}

function copyMessage(message) {
  const keys = ['type', 'run_id', 'seq', 'epoch', ...fields[message.type]];
  if (message.type !== 'stream_status') keys.push('request_id');
  return Object.fromEntries(keys.map(key => [key, message[key]]));
}

export class Timeline {
  constructor({ maxRequests = 8, maxTokens = 256 } = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1
        || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new RangeError('Timeline retention limits must be positive safe integers');
    }
    this.maxRequests = maxRequests;
    this.maxTokens = maxTokens;
    this.reset();
  }

  reset() {
    this.run_id = null;
    this.epoch = null;
    this.last_seq = null;
    this.requests = new Map();
    this.dropped_messages = 0;
    this.omitted_requests = 0;
    this.status = null;
  }

  accept(message) {
    if (!validateTelemetryMessage(message)) return false;
    const sameRun = this.run_id === message.run_id;
    if (sameRun && (message.seq <= this.last_seq || message.epoch < this.epoch)) return false;
    if (!sameRun || message.epoch !== this.epoch
        || (message.type === 'stream_status' && message.event !== 'gap')) {
      this.reset();
      this.run_id = message.run_id;
      this.epoch = message.epoch;
    }
    // Extension sequence numbers deliberately have holes; only explicit gap markers report loss.
    this.last_seq = message.seq;
    const wire = copyMessage(message);
    if (message.type === 'stream_status') {
      this.status = wire;
      this.dropped_messages += message.dropped_steps;
      if (message.event === 'gap') {
        for (const request of this.requests.values()) {
          if (!request.lifecycle || !terminal(request.lifecycle.phase)) request.partial = true;
        }
      }
      return true;
    }
    let request = this.requests.get(message.request_id);
    if (!request) {
      request = { request_id: message.request_id,
        partial: message.type !== 'request_lifecycle' || message.phase !== 'queued',
        lifecycle: null, phases: [], tokens: [], omitted_tokens: 0,
        last_token: { prompt: -1, completion: -1 } };
      this.requests.set(message.request_id, request);
      if (this.requests.size > this.maxRequests) {
        this.requests.delete(this.requests.keys().next().value);
        this.omitted_requests++;
      }
    }
    if (message.type === 'request_lifecycle') {
      if (request.lifecycle && (terminal(request.lifecycle.phase)
          || phases.indexOf(message.phase) <= phases.indexOf(request.lifecycle.phase))) return false;
      if (message.phase === 'queued' && request.tokens.length) return false;
      if (request.lifecycle && !['cancelled', 'failed'].includes(message.phase)
          && phases.indexOf(message.phase) > phases.indexOf(request.lifecycle.phase) + 1) {
        request.partial = true;
      }
      request.lifecycle = wire;
      request.phases.push(wire);
    } else {
      if (request.lifecycle && terminal(request.lifecycle.phase)) return false;
      if (message.token_index <= request.last_token[message.kind]) return false;
      if (message.token_index !== request.last_token[message.kind] + 1) request.partial = true;
      request.last_token[message.kind] = message.token_index;
      request.tokens.push(wire);
      if (request.tokens.length > this.maxTokens) {
        request.tokens.shift();
        request.omitted_tokens++;
      }
    }
    return true;
  }

  get snapshot() {
    return {
      run_id: this.run_id, epoch: this.epoch, last_seq: this.last_seq,
      dropped_messages: this.dropped_messages, omitted_requests: this.omitted_requests,
      status: this.status && { ...this.status },
      requests: [...this.requests.values()].map(({ last_token, ...request }) => ({
        ...request, lifecycle: request.lifecycle && { ...request.lifecycle },
        phases: request.phases.map(phase => ({ ...phase })),
        tokens: request.tokens.map(token => ({ ...token })),
      })),
    };
  }
}
