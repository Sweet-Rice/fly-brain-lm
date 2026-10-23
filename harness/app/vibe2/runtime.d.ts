export interface Vibe2RuntimeStatus {
  state: 'loading' | 'ready' | 'error';
  message: string;
  progress: number;
}
export interface Vibe2Runtime {
  readonly status: Vibe2RuntimeStatus;
  fetch: typeof globalThis.fetch;
  subscribeStatus(fn: (status: Vibe2RuntimeStatus) => void): () => void;
  subscribeTelemetry(fn: (message: Record<string, unknown>) => void): () => void;
  retry(this: void): void;
  dispose(): void;
}
export function createVibe2Runtime(options: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  gpu?: unknown;
  createEngine?: (options: { manifest: unknown; weights: Uint8Array; gpu?: unknown }) => Promise<{
    reset(): void;
    step(tokenId: number, options: { logits: boolean }): Promise<{ logits: Float32Array | null; code: Float32Array }>;
    destroy(): void;
    lost?: Promise<unknown>;
  }>;
  random?: () => number;
  now?: () => number;
}): Vibe2Runtime;
