export const ACTIVITY_DURATION = 600;

export class EdgeActivity {
  constructor(edges) {
    this.starts = new Float32Array(Math.max(1, edges.length)).fill(-1);
    this.indices = new Map();
    this.deadline = -Infinity;
    this.origin = 0;
    this.version = 0;
    edges.forEach(([source, destination], index) => {
      if (!this.indices.has(source)) this.indices.set(source, new Map());
      this.indices.get(source).set(destination, index);
    });
  }

  fire(pairs, now) {
    const time = this.time(now);
    let changed = false;
    for (const [source, destination] of pairs) {
      const index = this.indices.get(source)?.get(destination);
      if (index === undefined) continue;
      this.starts[index] = time;
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
