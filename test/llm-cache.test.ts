import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicLlmClient, CACHE_MISS_WINDOW_MS } from "../src/core/llm/client";
import { costUsd, PRICES } from "../src/core/llm/pricing";
import { scoreVacancy } from "../src/core/llm/score";
import { ScoreSchema } from "../src/core/llm/schemas";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS, type LlmPurpose, type Profile } from "../src/shared/types";

type Params = Record<string, any>;

function harness(usages: Params[] | null, text = '{"a":"x"}', extra: (n: number) => Params = () => ({}), onCall?: (n: number) => void) {
  const calls: Params[] = [];
  const queue = usages ? [...usages] : null;
  const fake = {
    beta: {
      messages: {
        create: async (p: Params) => {
          calls.push(p);
          onCall?.(calls.length);
          await Promise.resolve(); // latency: completion happens after concurrent starts
          latency();
          const u = queue ? queue.shift() : {};
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text }],
            usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u },
            ...extra(calls.length),
          };
        },
      },
    },
  } as unknown as Anthropic;
  let now = 1_000_000;
  const latency = () => (now += 10);
  const misses: { purpose: LlmPurpose; model: string; writeTokens: number }[] = [];
  const client = new AnthropicLlmClient({
    getApiKey: () => "sk",
    budget: { monthUsd: () => 0, limitUsd: () => 100 },
    onUsage: () => {},
    anthropicFactory: () => fake,
    sleep: async () => {},
    clock: () => now,
    onCacheMiss: (i) => misses.push(i),
  });
  return { client, calls, misses, advance: (ms: number) => (now += ms) };
}

const Schema = z.object({ a: z.string() });
const req = (over: Params = {}) => ({
  purpose: "score" as const,
  model: "claude-sonnet-5-5" as const,
  effort: "low" as const,
  maxTokens: 100,
  system: [
    { text: "role", cache: false },
    { text: "profile", cache: true },
  ],
  user: "vacancy 1",
  schema: Schema,
  ...over,
});

describe("cache determinism (real scoring request)", () => {
  const profile: Profile = {
    markdown: "# Jane\nMaatschappelijk werker",
    preferences: { ...DEFAULT_PREFERENCES, homeLocation: "Gent", dealBreakers: "nachtwerk" },
    version: 1,
    importedFrom: "manual",
    updatedAt: null,
    homeGeo: null,
    homeGeoError: null,
  };
  const scoreJson = JSON.stringify({
    summary: "s", organization: "o", location: "l", sector: "x", is_social_sector: true, hours: "", contract: "",
    diploma_required: "", experience_required: "", pay_scale: "", deadline: "", score: 60, bucket: "possible",
    subscores: { diploma: 1, experience: 1, skills: 1, preferences: 1 }, reasons: [], gaps: [], knockout_reason: "", confidence: "high",
  });
  ScoreSchema.parse(JSON.parse(scoreJson));

  it("builds byte-identical system blocks for different vacancies; vacancy and feedback only in messages", async () => {
    const h = harness(null, scoreJson);
    const vac = (n: number) => ({ title: `Title ${n}`, organization: `Org ${n}`, location: "Gent", sourceName: "S", url: `https://x.test/${n}`, description: `Unique description ${n}` });
    const fb = [{ feedback: "up" as const, title: "Liked job", organization: "Liked Org", note: "nice" }];
    await scoreVacancy(h.client, DEFAULT_SETTINGS, profile, vac(1), fb);
    await scoreVacancy(h.client, DEFAULT_SETTINGS, profile, vac(2), []);
    const [a, b] = h.calls;
    expect(a.system).toEqual(b.system);
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    const marked = (a.system as Params[]).filter((s) => s.cache_control);
    expect(marked).toHaveLength(1);
    expect((a.system as Params[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    const systemText = (a.system as Params[]).map((s) => s.text).join("\n");
    expect(systemText).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(systemText).not.toMatch(/\d{1,2}:\d{2}/);
    expect(systemText).not.toMatch(/\b20\d\d\b/);
    for (const needle of ["Unique description", "Title 1", "Liked job", "Liked Org"]) expect(systemText).not.toContain(needle);
    const m1 = JSON.stringify(a.messages);
    expect(m1).toContain("Unique description 1");
    expect(m1).toContain("Liked job");
    expect(JSON.stringify(b.messages)).toContain("Unique description 2");
  });
});

describe("cache miss detector", () => {
  it("does not fire on a first call", async () => {
    const h = harness([{ cache_creation_input_tokens: 500 }]);
    await h.client.structured(req());
    expect(h.misses).toEqual([]);
  });

  it("fires on a zero-read second call within 240 s, with details", async () => {
    const h = harness([{ cache_creation_input_tokens: 500 }, { cache_creation_input_tokens: 500 }]);
    await h.client.structured(req());
    h.advance(CACHE_MISS_WINDOW_MS - 100);
    await h.client.structured(req({ user: "vacancy 2" }));
    expect(h.misses).toEqual([{ purpose: "score", model: "claude-sonnet-5-5", writeTokens: 500 }]);
  });

  it("does not fire at or after 240 s, nor when reads > 0", async () => {
    const h = harness([{}, {}, { cache_read_input_tokens: 500 }]);
    await h.client.structured(req());
    h.advance(CACHE_MISS_WINDOW_MS);
    await h.client.structured(req());
    expect(h.misses).toEqual([]);
    h.advance(1000);
    await h.client.structured(req());
    expect(h.misses).toEqual([]);
  });

  it("ignores requests without a cache_control marker and keys on the prefix, not the messages", async () => {
    const h = harness([{}, {}, {}, {}]);
    const plain = req({ system: [{ text: "role", cache: false }] });
    await h.client.structured(plain);
    await h.client.structured(plain);
    expect(h.misses).toEqual([]);
    // a different cacheable prefix (other model) is a first call, not a miss
    await h.client.structured(req());
    h.advance(1000);
    await h.client.structured(req({ model: "claude-opus-5-5" }));
    expect(h.misses).toEqual([]);
  });

  it("never fires for overlapping requests, still fires for sequential ones", async () => {
    // B starts (clock +1000) while A is still running; A completes (clock +1000 more) before B does.
    let n = 0;
    const h = harness([{}, {}, {}, {}], '{"a":"x"}', () => ({}), () => {
      n++;
    });
    const a = h.client.structured(req());
    h.advance(1000);
    const b = h.client.structured(req({ user: "vacancy 2" }));
    await Promise.all([a, b]);
    expect(h.misses).toEqual([]);
    h.advance(1000);
    await h.client.structured(req({ user: "vacancy 3" }));
    expect(h.misses).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("skips the check when a fallback model served the turn", async () => {
    for (const extra of [
      () => ({ model: "claude-haiku-5-5" }),
      () => ({ content: [{ type: "fallback" }, { type: "text", text: '{"a":"x"}' }] }),
      () => ({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, iterations: [{ type: "fallback_message" }] } }),
    ]) {
      const h = harness([{}, {}], '{"a":"x"}', (n) => (n === 2 ? extra() : {}));
      await h.client.structured(req());
      h.advance(1000);
      await h.client.structured(req());
      expect(h.misses).toEqual([]);
    }
  });

  it("is reported by the client on every miss (the once-per-hour throttle lives in main)", async () => {
    const h = harness([{}, {}, {}]);
    await h.client.structured(req());
    await h.client.structured(req());
    await h.client.structured(req());
    expect(h.misses).toHaveLength(2);
  });
});

describe("pricing with TTL breakdown", () => {
  it("has the Nov 2026 table", () => {
    expect(PRICES["claude-sonnet-5-5"].cacheRead).toBe(0.1);
    expect(PRICES["claude-opus-5-5"].cacheWrite1h).toBe(8);
    expect(PRICES["claude-sonnet-5-5"].cacheWrite1h).toBe(4);
    expect(PRICES["claude-haiku-5-5"].cacheWrite1h).toBe(0.2);
  });

  it("bills 5m and 1h writes at their own prices", () => {
    const c = costUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 });
    expect(c).toBeCloseTo(5 + 8, 6);
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1, 6);
  });

  it("client uses cache_creation breakdown when present, falls back to the total as 5m", async () => {
    const withBreakdown = harness([
      { cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } },
    ]);
    const r1 = await withBreakdown.client.structured(req({ model: "claude-opus-5-5" }));
    expect(r1.usage.cacheWriteTokens).toBe(3000);
    expect(r1.usage.costUsd).toBeCloseTo((100 * 4 + 10 * 20 + 1000 * 5 + 2000 * 8) / 1e6, 9);
    const without = harness([{ cache_creation_input_tokens: 3000, cache_creation: null }]);
    const r2 = await without.client.structured(req({ model: "claude-opus-5-5" }));
    expect(r2.usage.costUsd).toBeCloseTo((100 * 4 + 10 * 20 + 3000 * 5) / 1e6, 9);
  });
});
