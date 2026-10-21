export class Camera {
  constructor(width = 1, height = 1) {
    this.centerX = 0;
    this.centerY = 0;
    this.scale = 1;
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = Number.isFinite(width) ? Math.max(1, width) : 1;
    this.height = Number.isFinite(height) ? Math.max(1, height) : 1;
  }

  fit(bounds) {
    if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
      || bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
      this.centerX = this.centerY = 0;
      this.scale = 1;
      return;
    }
    this.centerX = bounds.minX / 2 + bounds.maxX / 2;
    this.centerY = bounds.minY / 2 + bounds.maxY / 2;
    const halfWidth = Math.max(0.5, bounds.maxX / 2 - bounds.minX / 2);
    const halfHeight = Math.max(0.5, bounds.maxY / 2 - bounds.minY / 2);
    // Fit can go below the normal zoom limit so large graphs remain fully visible.
    this.scale = Math.min(100,
      Math.max(this.width - 64, this.width * 0.1) / halfWidth / 2,
      Math.max(this.height - 64, this.height * 0.1) / halfHeight / 2);
  }

  pan(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const x = this.centerX - dx / this.scale;
    const y = this.centerY - dy / this.scale;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.centerX = x;
      this.centerY = y;
    }
  }

  zoom(factor, anchorX = this.width / 2, anchorY = this.height / 2) {
    if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;
    const scale = Math.min(100, Math.max(Math.min(0.02, this.scale), this.scale * factor));
    const x = this.centerX + (anchorX - this.width / 2) * (1 / this.scale - 1 / scale);
    const y = this.centerY + (anchorY - this.height / 2) * (1 / this.scale - 1 / scale);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.centerX = x;
      this.centerY = y;
      this.scale = scale;
    }
  }

  worldToScreen(x, y) {
    return { x: (x - this.centerX) * this.scale + this.width / 2,
      y: (y - this.centerY) * this.scale + this.height / 2 };
  }
}
