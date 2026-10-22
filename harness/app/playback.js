import { readRecording } from "./sources.js";

export class RecordingSource {
  constructor(receiver, { onEvent = () => {}, onStatus = () => {}, onReset = () => {} } = {}) {
    this.receiver = receiver;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onReset = onReset;
    this.state = "empty";
    this.file = null;
    this.speed = 1;
    this.controller = null;
    this.timer = null;
    this.wake = null;
    this.remaining = 0;
  }

  status(state, message) {
    this.state = state;
    this.onStatus({ state, message });
  }

  interruptWait() {
    if (this.timer !== null) {
      this.remaining = Math.max(0, this.remaining - (performance.now() - this.startedAt) * this.timerSpeed);
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resumeWait() {
    if (!this.wake || this.state === "paused" || this.timer !== null) return;
    if (this.remaining <= 0) {
      const wake = this.wake;
      this.wake = null;
      wake();
      return;
    }
    this.startedAt = performance.now();
    this.timerSpeed = this.speed;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.remaining = 0;
      const wake = this.wake;
      this.wake = null;
      wake();
    }, this.remaining / this.speed);
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
    this.interruptWait();
    const wake = this.wake;
    this.wake = null;
    wake?.();
    this.remaining = 0;
  }

  load(file) {
    this.file = file;
    return this.restart();
  }

  async restart() {
    if (!this.file) return;
    this.cancel();
    const file = this.file;
    const controller = new AbortController();
    this.controller = controller;
    this.receiver.reset();
    this.onReset();
    this.status("playing", `Playing ${file.name ?? "recording"}.`);
    let usable = false;
    try {
      const result = await readRecording(file, this.receiver, (event, raw) => {
        if (event.action === "replace_mapping") usable = true;
        this.onEvent(event, raw);
        if (event.action === "accept_fire" && this.controller === controller) this.remaining = 500;
      }, { signal: controller.signal, beforeMessage: () => this.wait(controller) });
      if (this.controller !== controller) return;
      if (result.unsupported || !usable) {
        this.receiver.reset();
        this.onReset();
        this.status(result.unsupported ? "unsupported" : "error", result.unsupported
          ? `Stopped ${file.name ?? "recording"}: unsupported protocol version.`
          : "Cannot play recording: no valid mapping found.");
      } else {
        this.status("finished", `Finished ${file.name ?? "recording"}. ${result.lines} lines processed.`);
      }
    } catch (error) {
      if (this.controller !== controller) return;
      this.receiver.reset();
      this.onReset();
      this.status("error", `Cannot read recording: ${error.message}`);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.interruptWait();
        this.remaining = 0;
      }
    }
  }

  wait(controller) {
    if (controller.signal.aborted || this.controller !== controller) return;
    if (this.state !== "paused" && this.remaining <= 0) return;
    return new Promise((resolve) => {
      this.wake = resolve;
      this.resumeWait();
    });
  }

  play() {
    if (this.state !== "paused") return;
    this.status("playing", `Playing ${this.file.name ?? "recording"}.`);
    this.resumeWait();
  }

  pause() {
    if (this.state !== "playing") return;
    this.status("paused", `Paused ${this.file.name ?? "recording"}.`);
    this.interruptWait();
  }

  setSpeed(speed) {
    if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Playback speed must be a positive number.");
    this.interruptWait();
    this.speed = speed;
    this.resumeWait();
  }

  disconnect() {
    this.cancel();
    this.file = null;
    this.receiver.reset();
    this.onReset();
    this.status("empty", "No recording selected.");
  }
}
