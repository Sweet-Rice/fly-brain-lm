export const ACTIVITY_DURATION = 600;

export class EdgeActivity {
  constructor(edges) {
    this.starts = new Float32Array(Math.max(1, edges.length)).fill(-1);
    this.indices = new Map();
    this.deadline = -Infinity;
    edges.forEach(([source, destination], index) => {
      if (!this.indices.has(source)) this.indices.set(source, new Map());
      this.indices.get(source).set(destination, index);
    });
  }

  fire(pairs, now) {
    let changed = false;
    for (const [source, destination] of pairs) {
      const index = this.indices.get(source)?.get(destination);
      if (index === undefined) continue;
      this.starts[index] = now;
      changed = true;
    }
    if (changed) this.deadline = Math.max(this.deadline, now + ACTIVITY_DURATION);
    return changed;
  }

  active(now) {
    return now < this.deadline;
  }
}
