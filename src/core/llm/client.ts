import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Effort, LlmPurpose, ModelId } from "../../shared/types";
import { costUsd } from "./pricing";

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface StructuredRequest<T> {
  purpose: LlmPurpose;
  model: ModelId;
  effort: Effort;
  maxTokens: number;
  system: { text: string; cache: boolean }[];
  user: Anthropic.ContentBlockParam[] | string;
  schema: z.ZodType<T>;
}

export interface TextRequest {
  purpose: LlmPurpose;
  model: ModelId;
  effort: Effort;
  maxTokens: number;
  system: string;
  user: Anthropic.ContentBlockParam[] | string;
}

export interface LlmClient {
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }>;
}

export class BudgetExceededError extends Error {
  constructor(message = "Monthly LLM budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
  }
}
export class RefusalError extends Error {
  constructor(message = "The model declined to answer") {
    super(message);
    this.name = "RefusalError";
  }
}
export class LlmNotConfiguredError extends Error {
  constructor(message = "Anthropic API key is not configured") {
    super(message);
    this.name = "LlmNotConfiguredError";
  }
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const RATE_LIMIT_WAIT_MS = 20_000;

export interface AnthropicLlmClientOptions {
  getApiKey: () => string | null;
  budget: { monthUsd: () => number; limitUsd: () => number };
  onUsage: (u: LlmUsage & { purpose: LlmPurpose }) => void;
  anthropicFactory?: (apiKey: string) => Anthropic;
  /** Test hook for the rate-limit wait. */
  sleep?: (ms: number) => Promise<void>;
}

interface RawParams {
  model: ModelId;
  effort: Effort;
  maxTokens: number;
  system: Anthropic.TextBlockParam[];
  user: Anthropic.ContentBlockParam[] | string;
  format?: unknown;
}

interface BetaResponse {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: { type: string; text?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export class AnthropicLlmClient implements LlmClient {
  private clients = new Map<string, Anthropic>();
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: AnthropicLlmClientOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const system: Anthropic.TextBlockParam[] = req.system.map((b) => ({
      type: "text",
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const { text, usage } = await this.call(req.purpose, {
      model: req.model,
      effort: req.effort,
      maxTokens: req.maxTokens,
      system,
      user: req.user,
      format: zodOutputFormat(req.schema as never),
    });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Model returned invalid JSON");
    }
    return { data: req.schema.parse(json), usage };
  }

  async text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }> {
    return this.call(req.purpose, {
      model: req.model,
      effort: req.effort,
      maxTokens: req.maxTokens,
      system: [{ type: "text", text: req.system }],
      user: req.user,
    });
  }

  private clientFor(apiKey: string): Anthropic {
    let c = this.clients.get(apiKey);
    if (!c) {
      c = this.opts.anthropicFactory
        ? this.opts.anthropicFactory(apiKey)
        : new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
      this.clients.set(apiKey, c);
    }
    return c;
  }

  private async call(purpose: LlmPurpose, p: RawParams): Promise<{ text: string; usage: LlmUsage }> {
    const apiKey = this.opts.getApiKey();
    if (!apiKey) throw new LlmNotConfiguredError();
    const spent = this.opts.budget.monthUsd();
    const limit = this.opts.budget.limitUsd();
    if (spent >= limit) {
      throw new BudgetExceededError(
        `Monthly budget of $${limit.toFixed(2)} reached ($${spent.toFixed(2)} spent)`,
      );
    }
    const client = this.clientFor(apiKey);

    const outputConfig: Record<string, unknown> = { effort: p.effort };
    if (p.format) outputConfig.format = p.format;
    const params: Record<string, unknown> = {
      model: p.model,
      max_tokens: p.maxTokens,
      system: p.system,
      messages: [{ role: "user", content: p.user }],
      output_config: outputConfig,
    };
    // Opus 5.5 and Sonnet 5.5 support server-side refusal fallback; Haiku 5.5 does not.
    if (p.model !== "claude-haiku-5-5") {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }

    const send = () => client.beta.messages.create(params as never) as unknown as Promise<BetaResponse>;
    let res: BetaResponse;
    try {
      try {
        res = await send();
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError) {
          await this.sleep(RATE_LIMIT_WAIT_MS);
          res = await send();
        } else {
          throw e;
        }
      }
    } catch (e) {
      throw mapError(e);
    }

    const usage = this.makeUsage(p.model, res.usage);
    // Record spend even when the answer is unusable: the tokens were billed.
    this.opts.onUsage({ ...usage, purpose });

    if (res.stop_reason === "refusal") {
      const cat = res.stop_details?.category;
      throw new RefusalError(`The model declined to answer${cat ? ` (${cat})` : ""}`);
    }
    if (res.stop_reason === "max_tokens") throw new Error("response truncated");
    // A declined model's partial text can precede a "fallback" block: only the blocks after the last one count.
    let lastFallback = -1;
    res.content.forEach((b, i) => {
      if (b.type === "fallback") lastFallback = i;
    });
    const text = res.content
      .slice(lastFallback + 1)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (!text) throw new Error("Model returned no text");
    return { text, usage };
  }

  private makeUsage(model: string, u: BetaResponse["usage"]): LlmUsage {
    const inputTokens = u?.input_tokens ?? 0;
    const outputTokens = u?.output_tokens ?? 0;
    const cacheReadTokens = u?.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: costUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
    };
  }
}

function mapError(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new Error("Invalid Anthropic API key");
  if (e instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error (${e.status ?? "?"}): ${e.message}`);
  }
  return e;
}
