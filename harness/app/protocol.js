const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = value => Number.isInteger(value) && value >= 0;
const isPair = value => Array.isArray(value) && value.length === 2 && value.every(isId);
const pairKey = pair => `${pair[0]},${pair[1]}`;

function mappingEdges(message) {
  if (message.version !== 1 || !Array.isArray(message.groups)
      || !Array.isArray(message.nodes) || !Array.isArray(message.edges)) return null;

  const groups = new Set();
  for (const group of message.groups) {
    if (!isObject(group) || !isId(group.id) || typeof group.name !== "string"
        || groups.has(group.id)) return null;
    groups.add(group.id);
  }

  const nodes = new Set();
  for (const node of message.nodes) {
    if (!isObject(node) || !isId(node.id) || !isId(node.group)
        || !groups.has(node.group) || nodes.has(node.id)) return null;
    nodes.add(node.id);
  }

  const edges = new Set();
  for (const edge of message.edges) {
    if (!isPair(edge) || !nodes.has(edge[0]) || !nodes.has(edge[1])) return null;
    const key = pairKey(edge);
    if (edges.has(key)) return null;
    edges.add(key);
  }
  return edges;
}

export class ProtocolReceiver {
  #edges;

  constructor() {
    this.reset();
  }

  reset() {
    this.mapping = null;
    this.lastT = null;
    this.epoch = -1;
    this.closed = false;
    this.#edges = null;
  }

  process(raw) {
    if (this.closed || typeof raw !== "string") return { action: "drop_message" };
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return { action: "drop_message" };
    }
    if (!isObject(message) || typeof message.type !== "string") return { action: "drop_message" };

    if (message.type === "mapping") {
      if (Number.isInteger(message.version) && message.version !== 1) {
        this.closed = true;
        return { action: "close", code: 1003 };
      }
      const edges = mappingEdges(message);
      if (edges === null) return { action: "drop_message" };
      this.mapping = message;
      this.#edges = edges;
      this.lastT = null;
      this.epoch += 1;
      return {
        action: "replace_mapping",
        epoch: this.epoch,
        groups: message.groups.length,
        nodes: message.nodes.length,
        edges: message.edges.length,
      };
    }

    if (message.type !== "fire") return { action: "ignore_message" };
    if (this.mapping === null || !isId(message.t) || !Array.isArray(message.pairs)
        || (this.lastT !== null && message.t <= this.lastT)) return { action: "drop_message" };

    const seen = new Set();
    const pairs = [];
    const droppedPairs = [];
    for (const pair of message.pairs) {
      if (!isPair(pair)) return { action: "drop_message" };
      const key = pairKey(pair);
      if (seen.has(key)) return { action: "drop_message" };
      seen.add(key);
      (this.#edges.has(key) ? pairs : droppedPairs).push(pair);
    }
    this.lastT = message.t;
    return {
      action: "accept_fire",
      epoch: this.epoch,
      t: message.t,
      pairs,
      dropped_pairs: droppedPairs,
    };
  }
}
