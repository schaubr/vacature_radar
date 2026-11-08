import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  AnthropicLlmClient,
  BudgetExceededError,
  LlmNotConfiguredError,
  RefusalError,
  type LlmUsage,
} from "../src/core/llm/client";
import { costUsd } from "../src/core/llm/pricing";
import type { LlmPurpose, ModelId } from "../src/shared/types";

type Params = Record<string, any>;

function fakeAnthropic(responses: (object | Error)[]) {
  const calls: Params[] = [];
  const fake = {
    beta: {
      messages: {
        create: async (p: Params) => {
          calls.push(p);
          const r = responses.shift();
          if (!r) throw new Error("no canned response");
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { fake: fake as unknown as Anthropic, calls };
}

function ok(text: string, usage: Params = {}) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text }],
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: null, cache_creation_input_tokens: null, ...usage },
  };
}

function setup(responses: (object | Error)[], opts: { spent?: number; limit?: number; key?: string | null } = {}) {
  const { fake, calls } = fakeAnthropic(responses);
  const usages: (LlmUsage & { purpose: LlmPurpose })[] = [];
  const client = new AnthropicLlmClient({
    getApiKey: () => (opts.key === undefined ? "sk-test" : opts.key),
    budget: { monthUsd: () => opts.spent ?? 0, limitUsd: () => opts.limit ?? 5 },
    onUsage: (u) => usages.push(u),
    anthropicFactory: () => fake,
    sleep: async () => {},
  });
  return { client, calls, usages };
}

const Schema = z.object({ a: z.string(), n: z.number() });

function structuredReq(model: ModelId = "claude-opus-5-5") {
  return {
    purpose: "score" as const,
    model,
    effort: "low" as const,
    maxTokens: 1234,
    system: [
      { text: "stable", cache: false },
      { text: "profile", cache: true },
    ],
    user: "hello",
    schema: Schema,
  };
}

describe("pricing", () => {
  it("computes cost including cache tokens", () => {
    const c = costUsd("claude-opus-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(c).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
    expect(costUsd("claude-haiku-5-5", { inputTokens: 2_000_000, outputTokens: 0 })).toBeCloseTo(0.2, 6);
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 500_000 })).toBeCloseTo(1.1, 6);
  });
});

describe("AnthropicLlmClient", () => {
  it("returns parsed data, usage and cost; records usage", async () => {
    const { client, usages } = setup([
      ok('{"a":"x","n":3}', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 }),
    ]);
    const { data, usage } = await client.structured(structuredReq());
    expect(data).toEqual({ a: "x", n: 3 });
    const expected = (1000 * 4 + 500 * 20 + 2000 * 0.2 + 400 * 5) / 1e6;
    expect(usage.costUsd).toBeCloseTo(expected, 8);
    expect(usage.cacheReadTokens).toBe(2000);
    expect(usage.cacheWriteTokens).toBe(400);
    expect(usages).toHaveLength(1);
    expect(usages[0].purpose).toBe("score");
  });

  it("blocks before the call when the budget is exhausted", async () => {
    const { client, calls } = setup([ok("{}")], { spent: 5, limit: 5 });
    await expect(client.structured(structuredReq())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(0);
  });

  it("throws LlmNotConfiguredError without a key", async () => {
    const { client, calls } = setup([ok("{}")], { key: null });
    await expect(client.text({ purpose: "profile_import", model: "claude-sonnet-5-5", effort: "low", maxTokens: 10, system: "s", user: "u" })).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it("maps refusal to RefusalError with category, still recording usage", async () => {
    const { client, usages } = setup([
      { stop_reason: "refusal", stop_details: { category: "general_harms", explanation: null }, content: [], usage: { input_tokens: 10, output_tokens: 1 } },
    ]);
    const p = client.structured(structuredReq());
    await expect(p).rejects.toBeInstanceOf(RefusalError);
    await expect(
      setup([{ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage: {} }]).client.structured(structuredReq()),
    ).rejects.toThrow(/cyber/);
    expect(usages).toHaveLength(1);
  });

  it("maps max_tokens to a truncation error", async () => {
    const { client } = setup([{ ...ok('{"a":'), stop_reason: "max_tokens" }]);
    await expect(client.structured(structuredReq())).rejects.toThrow("response truncated");
  });

  it("rejects invalid JSON and schema violations", async () => {
    await expect(setup([ok("not json")]).client.structured(structuredReq())).rejects.toThrow(/invalid JSON/);
    await expect(setup([ok('{"a":1}')]).client.structured(structuredReq())).rejects.toThrow();
  });

  it("uses only the text after the last fallback block", async () => {
    const res = {
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "partial declined" },
        { type: "fallback", from: "x" },
        { type: "text", text: '{"a":"x",' },
        { type: "text", text: '"n":2}' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const { data } = await setup([res]).client.structured(structuredReq());
    expect(data).toEqual({ a: "x", n: 2 });
  });

  it("sends beta fallbacks for Opus and Sonnet, not for Haiku", async () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"] as ModelId[]) {
      const { client, calls } = setup([ok('{"a":"x","n":1}')]);
      await client.structured(structuredReq(model));
      expect(calls[0].betas).toEqual(["server-side-fallback-2026-07-01"]);
      expect(calls[0].fallbacks).toBe("default");
      expect(calls[0].model).toBe(model);
    }
    const { client, calls } = setup([ok('{"a":"x","n":1}')]);
    await client.structured(structuredReq("claude-haiku-5-5"));
    expect(calls[0]).not.toHaveProperty("betas");
    expect(calls[0]).not.toHaveProperty("fallbacks");
  });

  it("builds the request: cache_control placement, no thinking, effort and json_schema format", async () => {
    const { client, calls } = setup([ok('{"a":"x","n":1}')]);
    await client.structured(structuredReq());
    const p = calls[0];
    expect(p.max_tokens).toBe(1234);
    expect(p).not.toHaveProperty("thinking");
    expect(JSON.stringify(p)).not.toContain("budget_tokens");
    expect(p.system).toEqual([
      { type: "text", text: "stable" },
      { type: "text", text: "profile", cache_control: { type: "ephemeral" } },
    ]);
    expect(p.output_config.effort).toBe("low");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.output_config.format.schema.properties).toHaveProperty("a");
    expect(p.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("text(): no format, passes effort, system as one block", async () => {
    const { client, calls } = setup([ok("# Markdown")]);
    const r = await client.text({ purpose: "profile_import", model: "claude-sonnet-5-5", effort: "high", maxTokens: 50, system: "sys", user: [{ type: "text", text: "hi" }] });
    expect(r.text).toBe("# Markdown");
    expect(calls[0].output_config).toEqual({ effort: "high" });
    expect(calls[0].system).toEqual([{ type: "text", text: "sys" }]);
    expect(calls[0]).not.toHaveProperty("thinking");
  });

  it("maps authentication errors", async () => {
    const err = new Anthropic.AuthenticationError(401, { error: { message: "bad" } }, "bad", new Headers());
    await expect(setup([err]).client.structured(structuredReq())).rejects.toThrow("Invalid Anthropic API key");
  });

  it("retries once after a rate limit error", async () => {
    const err = new Anthropic.RateLimitError(429, { error: { message: "slow" } }, "slow", new Headers());
    const { client, calls } = setup([err, ok('{"a":"x","n":1}')]);
    const r = await client.structured(structuredReq());
    expect(r.data.a).toBe("x");
    expect(calls).toHaveLength(2);
  });

  it("includes the status for other API errors", async () => {
    const err = new Anthropic.BadRequestError(400, { error: { message: "nope" } }, "nope", new Headers());
    await expect(setup([err]).client.structured(structuredReq())).rejects.toThrow(/400/);
  });
});
