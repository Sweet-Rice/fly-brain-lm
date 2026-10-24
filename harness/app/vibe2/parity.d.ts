export function runVibe2Parity(baseUrl: string): Promise<{
  tokenizerFailures: string[];
  greedyMatch: boolean;
  firstGreedyMismatch: number | null;
  maxTopLogitDiff: number;
  kcMismatchSteps: number[];
  tokensPerSecond: number;
}>;
