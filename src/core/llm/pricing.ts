import type { ModelId } from "../../shared/types";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens (list prices, Oct 2026). */
export const PRICES: Record<ModelId, Price> = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cost in USD. Unknown models are priced like Opus (conservative). */
export function costUsd(model: string, usage: TokenUsage): number {
  const p = PRICES[model as ModelId] ?? PRICES["claude-opus-5-5"];
  const total =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    (usage.cacheReadTokens ?? 0) * p.cacheRead +
    (usage.cacheWriteTokens ?? 0) * p.cacheWrite;
  return total / 1_000_000;
}
