import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { tEn, type Translator } from "../../shared/i18n";
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
  /** Translator for user-facing errors, resolved at call time (default English). */
  t?: Translator;
  /**
   * Called when a request whose cacheable prefix was already sent less than CACHE_MISS_WINDOW_MS ago
   * reports zero cache reads, i.e. caching silently stopped working. The caller decides how to surface it.
   */
  onCacheMiss?: (info: { purpose: LlmPurpose; model: string; writeTokens: number }) => void;
  /** Test hook: clock in epoch milliseconds (default Date.now). */
  clock?: () => number;
}

/**
 * Entries are written with the 5-minute TTL, so a second request with the same prefix within 4 minutes
 * (a minute of slack) must read the entry the first one wrote.
 */
export const CACHE_MISS_WINDOW_MS = 240_000;

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
  model?: string | null;
  content: { type: string; text?: string }[];
  usage?: {
    /** Per-sampling-iteration usage; an entry of type "fallback_message" means a fallback model served the turn. */
    iterations?: { type?: string }[] | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    /** Breakdown of the writes by TTL (BetaCacheCreation in the SDK); null/absent on older responses. */
    cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  };
}

export class AnthropicLlmClient implements LlmClient {
  private clients = new Map<string, Anthropic>();
  private sleep: (ms: number) => Promise<void>;
  private clock: () => number;
  /** Start and completion time (ms) of the last completed request per cacheable-prefix hash. */
  private lastPrefix = new Map<string, { startedAt: number; completedAt: number }>();

  private get t(): Translator {
    return this.opts.t ?? tEn;
  }

  constructor(private opts: AnthropicLlmClientOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * SHA-256 of what the cache keys on: model + effort + system blocks + output format schema.
   * Never the per-vacancy messages. Null when the request has no cache_control marker.
   */
  private prefixHash(p: RawParams): string | null {
    if (!p.system.some((b) => (b as { cache_control?: unknown }).cache_control)) return null;
    return createHash("sha256")
      .update(JSON.stringify({ model: p.model, effort: p.effort, system: p.system, format: p.format ?? null }))
      .digest("hex");
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
    if (!apiKey) throw new LlmNotConfiguredError(this.t("llm.notConfigured"));
    const spent = this.opts.budget.monthUsd();
    const limit = this.opts.budget.limitUsd();
    if (spent >= limit) {
      throw new BudgetExceededError(this.t("llm.budget", { limit: `$${limit.toFixed(2)}`, spent: `$${spent.toFixed(2)}` }));
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

    const prefix = this.prefixHash(p);
    const startedAt = this.clock();
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
      throw mapError(e, this.t);
    }

    const usage = this.makeUsage(p.model, res.usage);
    // Record spend even when the answer is unusable: the tokens were billed.
    this.opts.onUsage({ ...usage, purpose });

    // Standing check: the same cacheable prefix, sent again within the TTL, must be read from the cache.
    // Skipped when a fallback model served the turn (its cache is separate), and for overlapping requests
    // (an entry is only readable once the request that writes it has completed).
    if (prefix) {
      const completedAt = this.clock();
      const previous = this.lastPrefix.get(prefix);
      this.lastPrefix.set(prefix, { startedAt, completedAt });
      const fallbackServed =
        (typeof res.model === "string" && res.model !== p.model) ||
        res.content.some((b) => b.type === "fallback") ||
        (res.usage?.iterations ?? []).some((i) => i.type === "fallback_message");
      if (
        previous !== undefined &&
        !fallbackServed &&
        previous.completedAt <= startedAt &&
        startedAt - previous.startedAt < CACHE_MISS_WINDOW_MS &&
        usage.cacheReadTokens === 0
      ) {
        try {
          this.opts.onCacheMiss?.({ purpose, model: p.model, writeTokens: usage.cacheWriteTokens });
        } catch {
          // monitoring must never break a call
        }
      }
    }

    if (res.stop_reason === "refusal") {
      const cat = res.stop_details?.category;
      throw new RefusalError(cat ? this.t("llm.refusedCat", { category: cat }) : this.t("llm.refused"));
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
    // Bill 5-minute and 1-hour writes at their own prices when the breakdown is present; otherwise
    // the total counts as 5-minute (the only TTL this app requests).
    const total = u?.cache_creation_input_tokens ?? 0;
    const bd = u?.cache_creation;
    const write1h = bd ? (bd.ephemeral_1h_input_tokens ?? 0) : 0;
    const write5m = bd ? (bd.ephemeral_5m_input_tokens ?? 0) : total;
    const cacheWriteTokens = bd ? write5m + write1h : total;
    return {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: costUsd(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: write5m, cacheWrite1hTokens: write1h }),
    };
  }
}

function mapError(e: unknown, t: Translator): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new Error(t("llm.invalidKey"));
  if (e instanceof Anthropic.APIError) {
    return new Error(t("llm.apiError", { status: e.status ?? "?", message: e.message }));
  }
  return e;
}
