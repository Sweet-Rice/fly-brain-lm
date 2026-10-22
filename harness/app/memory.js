import { validateTelemetryMessage } from './timeline.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isPositive = value => Number.isSafeInteger(value) && value > 0;
const isText = value => typeof value === 'string' && value.length > 0;
const isQuantized = value => Number.isSafeInteger(value) || ['nan', 'inf', '-inf', 'missing'].includes(value);
const summaryVectors = ['dopamine_gate', 'dopamine_cap', 'recovery_half_life', 'recovery_factor',
  's_norm_before', 's_norm_after', 's_delta_norm'];
const sliceVectors = ['s_before', 's_after', 'read_vector', 'delta_raw', 'delta_net'];
const common = ['type', 'seq', 'run_id', 'request_id', 'epoch', 't', 'scale', 'block', 'prev_rev', 'rev'];
const vectorOf = (value, length) => Array.isArray(value) && value.length === length
  && Array.from(value).every(isQuantized);

export function validateMemoryMessage(message) {
  if (!isObject(message) || !['memory_summary', 'memory_slice'].includes(message.type)
      || !isText(message.run_id) || !isText(message.request_id)
      || !['seq', 'epoch', 't', 'block', 'prev_rev'].every(key => isCount(message[key]))
      || !isPositive(message.scale) || !isPositive(message.rev)
      || message.rev !== message.prev_rev + 1) return false;
  if (message.type === 'memory_summary') {
    return isPositive(message.heads) && message.heads % 3 === 0 && isPositive(message.head_dim)
      && isText(message.dtype) && summaryVectors.every(key => vectorOf(message[key], message.heads));
  }
  return ['lobe', 'kc_id', 'head'].every(key => isCount(message[key])) && message.lobe <= 2
    && isQuantized(message.k_activation) && Array.isArray(message.s_before)
    && message.s_before.length > 0
    && sliceVectors.every(key => vectorOf(message[key], message.s_before.length));
}

function copyMessage(message) {
  const vectors = message.type === 'memory_summary' ? summaryVectors : sliceVectors;
  const extra = message.type === 'memory_summary' ? ['heads', 'head_dim', 'dtype']
    : ['lobe', 'kc_id', 'head', 'k_activation'];
  return Object.fromEntries([...common, ...extra, ...vectors].map(key =>
    [key, vectors.includes(key) ? [...message[key]] : message[key]]));
}

const sliceMatches = (slice, summary) => slice.s_before.length === summary.head_dim
  && slice.head < summary.heads && slice.lobe === Math.floor(slice.head / (summary.heads / 3));
const sameSlice = (a, b) => a.kc_id === b.kc_id && a.head === b.head && a.lobe === b.lobe;
const addCount = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

export class MemoryInspector {
  constructor({ maxWrites = 16, maxSlices = 32 } = {}) {
    if (!isPositive(maxWrites) || !isPositive(maxSlices)) {
      throw new RangeError('Memory retention limits must be positive safe integers');
    }
    this.maxWrites = maxWrites;
    this.maxSlices = maxSlices;
    this.reset();
  }

  reset() {
    this.run_id = null;
    this.epoch = null;
    this.last_seq = null;
    this.last_gap_seq = null;
    this.dropped_messages = 0;
    this.omitted_writes = 0;
    this.status = null;
    this.writes = [];
  }

  accept(message) {
    const status = message?.type === 'stream_status' && validateTelemetryMessage(message);
    if (!status && !validateMemoryMessage(message)) return false;
    const sameRun = this.run_id === message.run_id;
    if (sameRun && (message.seq <= this.last_seq || message.epoch < this.epoch)) return false;
    if (!sameRun || message.epoch !== this.epoch || (status && message.event !== 'gap')) {
      this.reset();
      this.run_id = message.run_id;
      this.epoch = message.epoch;
    }
    if (status) {
      this.last_seq = message.seq;
      this.status = Object.fromEntries(['type', 'run_id', 'seq', 'epoch', 'event', 'dropped_steps',
        'server_time_ms'].map(key => [key, message[key]]));
      this.dropped_messages = addCount(this.dropped_messages, message.dropped_steps);
      if (message.event === 'gap') {
        this.last_gap_seq = message.seq;
        for (const write of this.writes) write.partial = true;
      }
      return true;
    }
    const latest = this.writes.findLast(write => write.request_id === message.request_id
      && write.block === message.block);
    if (latest && (message.rev < latest.rev || (message.rev > latest.rev && message.t <= latest.t))) return false;
    let write = latest?.rev === message.rev ? latest : null;
    if (write) {
      if (message.t !== write.t || message.scale !== write.scale || message.prev_rev !== write.prev_rev) return false;
      if (message.type === 'memory_summary') {
        if (write.summary || !write.slices.every(slice => sliceMatches(slice, message))) return false;
      } else if ((write.summary && !sliceMatches(message, write.summary))
          || (write.slices.length && message.s_before.length !== write.slices[0].s_before.length)
          || write.slices.some(slice => sameSlice(slice, message))) return false;
    }
    this.last_seq = message.seq;
    if (!write) {
      // Independent telemetry strides can skip revisions; every wire value is its own baseline.
      const afterGap = this.last_gap_seq !== null && (!latest || latest.last_seq < this.last_gap_seq);
      const continuity = afterGap ? 'gap' : latest
        ? message.prev_rev === latest.rev ? 'contiguous' : 'gap'
        : message.rev === 1 ? 'initial' : 'baseline';
      write = { request_id: message.request_id, block: message.block, rev: message.rev,
        prev_rev: message.prev_rev, t: message.t, scale: message.scale, continuity,
        partial: afterGap, summary: null, slices: [], omitted_slices: 0, last_seq: message.seq };
      this.writes.push(write);
      if (this.writes.length > this.maxWrites) {
        this.writes.shift();
        this.omitted_writes = addCount(this.omitted_writes, 1);
      }
    }
    write.last_seq = message.seq;
    if (message.type === 'memory_summary') write.summary = copyMessage(message);
    else if (write.slices.length < this.maxSlices) write.slices.push(copyMessage(message));
    else write.omitted_slices = addCount(write.omitted_slices, 1);
    return true;
  }

  get snapshot() {
    return {
      run_id: this.run_id, epoch: this.epoch, last_seq: this.last_seq,
      dropped_messages: this.dropped_messages, omitted_writes: this.omitted_writes,
      status: this.status && { ...this.status },
      writes: this.writes.map(({ last_seq, ...write }) => ({
        ...write, summary: write.summary && copyMessage(write.summary),
        slices: write.slices.map(copyMessage),
      })),
    };
  }
}
