export const ACTIVITY_DURATION = 600;

export class EdgeActivity {
  constructor(edges = [], nodes = []) {
    const edgeList = edges ?? [];
    const edgeCount = edgeList.length;
    this.indices = new Map();
    edgeList.forEach(([source, destination], index) => {
      if (!this.indices.has(source)) this.indices.set(source, new Map());
      this.indices.get(source).set(destination, index);
    });

    this.nodeIndices = new Map();
    let nodeSlot = 0;
    if (nodes) {
      if (typeof nodes === 'number') {
        for (let i = 0; i < nodes; i++) {
          this.nodeIndices.set(i, edgeCount + i);
        }
      } else if (nodes instanceof Map) {
        for (const [id, slot] of nodes) {
          const index = typeof slot === 'number' ? edgeCount + slot : edgeCount + nodeSlot++;
          this.nodeIndices.set(id, index);
        }
      } else if (typeof nodes[Symbol.iterator] === 'function') {
        for (const node of nodes) {
          const id = (typeof node === 'object' && node !== null) ? node.id : node;
          if (typeof id === 'number' && !this.nodeIndices.has(id)) {
            this.nodeIndices.set(id, edgeCount + nodeSlot++);
          }
        }
      }
    }

    const totalSlots = edgeCount + this.nodeIndices.size;
    this.starts = new Float32Array(Math.max(1, totalSlots)).fill(-1);
    this.edgeCount = edgeCount;
    this.nodeCount = this.nodeIndices.size;
    this.deadline = -Infinity;
    this.origin = 0;
    this.version = 0;
  }

  fire(pairs, now) {
    const time = this.time(now);
    let changed = false;
    for (const [source, destination] of pairs) {
      const index = this.indices.get(source)?.get(destination);
      if (index === undefined) continue;
      this.starts[index] = time;
      if (this.nodeIndices.size > 0) {
        const srcNode = this.nodeIndices.get(source);
        if (srcNode !== undefined) this.starts[srcNode] = time;
        const dstNode = this.nodeIndices.get(destination);
        if (dstNode !== undefined) this.starts[dstNode] = time;
      }
      changed = true;
    }
    if (changed) {
      this.deadline = Math.max(this.deadline, now + ACTIVITY_DURATION);
      this.version++;
    }
    return changed;
  }

  time(now) {
    if (now - this.origin > 60000) {
      // Keep shader timestamps precise after days of operation, retaining only recent activity.
      const origin = now - ACTIVITY_DURATION;
      const shift = origin - this.origin;
      for (let index = 0; index < this.starts.length; index++) {
        this.starts[index] = this.starts[index] >= shift ? this.starts[index] - shift : -1;
      }
      this.origin = origin;
      this.version++;
    }
    return now - this.origin;
  }

  active(now) {
    return now < this.deadline;
  }
}
