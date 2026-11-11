import type { ModelId } from "../../shared/types";

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write (1.25x input). */
  cacheWrite: number;
  /** 1-hour cache write (2x input). */
  cacheWrite1h: number;
}

/** USD per million tokens (list prices, Nov 2026). */
export const PRICES: Record<ModelId, Price> = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0, cacheWrite1h: 8.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4.0 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
};

/** Unknown models are priced like Opus (conservative). */
export function priceFor(model: string): Price {
  return PRICES[model as ModelId] ?? PRICES["claude-opus-5-5"];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Tokens written with the default 5-minute TTL. */
  cacheWriteTokens?: number;
  /** Tokens written with the 1-hour TTL (billed at 2x input instead of 1.25x). */
  cacheWrite1hTokens?: number;
}

/** Cost in USD. */
export function costUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const total =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    (usage.cacheReadTokens ?? 0) * p.cacheRead +
    (usage.cacheWriteTokens ?? 0) * p.cacheWrite +
    (usage.cacheWrite1hTokens ?? 0) * p.cacheWrite1h;
  return total / 1_000_000;
}
