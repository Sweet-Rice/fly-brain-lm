export class LiveSource {
  constructor(receiver, { onEvent = () => {}, onStatus = () => {} } = {}, WebSocketType = globalThis.WebSocket) {
    this.receiver = receiver;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.WebSocketType = WebSocketType;
    this.socket = null;
    this.retryTimer = null;
    this.url = null;
    this.document = globalThis.document;
    this.onVisibilityChange = () => {
      if (!this.url) return;
      if (this.document.hidden) {
        const url = this.url;
        this.disconnect();
        this.url = url;
        this.onStatus({ state: "background", message: "Live source paused while this tab is hidden." });
      } else if (!this.socket && this.retryTimer === null) {
        this.open();
      }
    };
    this.document?.addEventListener?.("visibilitychange", this.onVisibilityChange);
  }

  connect(url) {
    this.disconnect();
    this.url = url;
    this.open();
  }

  open() {
    this.receiver.reset();
    if (this.document?.hidden) {
      this.onStatus({ state: "background", message: "Live source paused while this tab is hidden." });
      return;
    }
    this.onStatus({ state: "connecting", message: `Connecting to ${this.url}` });
    let socket;
    try {
      socket = new this.WebSocketType(this.url);
    } catch (error) {
      this.onStatus({ state: "error", message: error.message });
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.onStatus({ state: "connected", message: `Connected to ${this.url}` });
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      const event = this.receiver.process(data);
      this.onEvent(event);
      if (event.action === "close") {
        this.socket = null;
        this.url = null;
        this.receiver.reset();
        this.onStatus({ state: "unsupported", message: "Unsupported protocol version (protocol close code 1003)" });
        // Browsers only permit sending code 1000 or 3000–4999, so preserve 1003 in the protocol event and use 4001 on the wire.
        socket.close(4001, "Unsupported protocol version");
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) this.onStatus({ state: "error", message: "WebSocket connection failed" });
    };
    socket.onclose = ({ code, reason }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.receiver.reset();
      this.onStatus({ state: "reconnecting", message: `Connection closed (${code}${reason ? `: ${reason}` : ""}); retrying in 1 second` });
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
      }, 1000);
    };
  }

  disconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.url = null;
    const socket = this.socket;
    this.socket = null;
    this.receiver.reset();
    if (socket) socket.close();
    this.onStatus({ state: "disconnected", message: "Disconnected" });
  }

  dispose() {
    this.document?.removeEventListener?.("visibilitychange", this.onVisibilityChange);
    this.disconnect();
  }
}

export async function readRecording(file, receiver, onEvent, { signal, beforeMessage } = {}) {
  const result = { lines: 0, events: 0, aborted: Boolean(signal?.aborted), unsupported: false };
  if (result.aborted) return result;
  receiver.reset();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const consume = async (line) => {
    result.lines++;
    if (!line.trim()) return;
    const waiting = beforeMessage?.();
    if (waiting) await waiting;
    if (signal?.aborted) return;
    const event = receiver.process(line);
    result.events++;
    onEvent(event);
    result.unsupported = event.action === "close";
  };
  try {
    while (!signal?.aborted && !result.unsupported) {
      const { value, done } = await reader.read();
      if (signal?.aborted) break;
      pending += decoder.decode(value, { stream: !done });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        await consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (signal?.aborted || result.unsupported) break;
        if (result.lines % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) break;
      }
      if (signal?.aborted || result.unsupported) break;
      if (done) {
        if (pending.length) await consume(pending);
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  result.aborted = Boolean(signal?.aborted);
  return result;
}
