import type { GenerationClientSnapshot } from "./inference-contract/v1/types.js";

export interface LiveAtlasGroup {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly placement: string;
  readonly count: number;
}

export interface LiveAtlasSnapshot {
  readonly connectionState: string;
  readonly connectionMessage: string;
  readonly gpuMessage: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly groups: readonly LiveAtlasGroup[];
  readonly lastStep: number | null;
  readonly acceptedFires: number;
  readonly droppedMessages: number;
  readonly droppedPairs: number;
}

export interface LiveAtlasOptions {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  inspector: HTMLElement;
  readout?: HTMLElement;
  connectionStyle?: 'lines' | 'dots';
  onState: (snapshot: LiveAtlasSnapshot) => void;
  endpoint?: string;
  WebSocketType?: { new (url: string | URL, protocols?: string | string[]): WebSocket };
}

export interface LiveAtlasHandle {
  ensureConnected(): void;
  connect(): void;
  disconnect(): void;
  fit(): void;
  zoom(factor: number): void;
  setGeneration(state: GenerationClientSnapshot): void;
  dispose(): void;
}

export function mountLiveAtlas(options: LiveAtlasOptions): LiveAtlasHandle;
