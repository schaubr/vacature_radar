import { describe, expect, it } from "vitest";
import type { LlmClient, LlmUsage, StructuredRequest } from "../src/core/llm/client";
import { buildScoringSystem, buildScoringUser, renderPreferences } from "../src/core/llm/prompts";
import { postProcessScore, scoreVacancy } from "../src/core/llm/score";
import type { ScoreOutput } from "../src/core/llm/schemas";
import { DEFAULT_PREFERENCES, DEFAULT_SETTINGS, type Profile } from "../src/shared/types";

const usage: LlmUsage = { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 };

function out(over: Partial<ScoreOutput> = {}): ScoreOutput {
  return {
    summary: " Begeleider in een woonzorgcentrum. ",
    organization: "WZC Zonnebloem",
    location: "Gent",
    sector: "ouderenzorg",
    is_social_sector: true,
    hours: "38u",
    contract: "onbepaalde duur",
    diploma_required: "bachelor sociaal werk",
    experience_required: "",
    pay_scale: "IFIC",
    deadline: "2026-12-01",
    score: 75,
    bucket: "strong",
    subscores: { diploma: 90, experience: 70, skills: 70, preferences: 60 },
    reasons: ["a", "b"],
    gaps: [],
    knockout_reason: "",
    confidence: "high",
    ...over,
  };
}

const profile: Profile = {
  markdown: "# Jane\nMaatschappelijk werker, 5 jaar ervaring",
  preferences: { ...DEFAULT_PREFERENCES, homeLocation: "Gent", hours: "fulltime", contractTypes: ["permanent"], dealBreakers: "nachtwerk" },
  version: 1,
  importedFrom: "manual",
  updatedAt: null,
  homeGeo: null,
  homeGeoError: null,
};

describe("postProcessScore", () => {
  it("clamps scores to integers 0..100", () => {
    const r = postProcessScore(out({ score: 123.6, subscores: { diploma: -5, experience: 50.4, skills: 101, preferences: NaN } }));
    expect(r.score.score).toBe(100);
    expect(r.score.subscores).toEqual({ diploma: 0, experience: 50, skills: 100, preferences: 0 });
    expect(postProcessScore(out({ score: -10 })).score.score).toBe(0);
  });

  it("derives bucket from score so they never disagree", () => {
    expect(postProcessScore(out({ score: 70, bucket: "weak" })).score.bucket).toBe("strong");
    expect(postProcessScore(out({ score: 69, bucket: "strong" })).score.bucket).toBe("possible");
    expect(postProcessScore(out({ score: 50, bucket: "weak" })).score.bucket).toBe("possible");
    expect(postProcessScore(out({ score: 49, bucket: "possible" })).score.bucket).toBe("weak");
  });

  it("forces knockout bucket and score <= 30 when knockout_reason is set", () => {
    const r = postProcessScore(out({ score: 88, bucket: "strong", knockout_reason: "Master required" })).score;
    expect(r.bucket).toBe("knockout");
    expect(r.score).toBe(30);
    expect(r.knockoutReason).toBe("Master required");
    expect(postProcessScore(out({ score: 10, knockout_reason: "x" })).score.score).toBe(10);
  });

  it("ignores a knockout bucket without a reason", () => {
    const r = postProcessScore(out({ score: 60, bucket: "knockout", knockout_reason: "  " })).score;
    expect(r.bucket).toBe("possible");
    expect(r.knockoutReason).toBe("");
  });

  it("truncates reasons and gaps to 4 and maps fields", () => {
    const r = postProcessScore(out({ reasons: ["1", "2", "3", "4", "5", "6"], gaps: ["1", "", "2", "3", "4", "5"] }));
    expect(r.score.reasons).toHaveLength(4);
    expect(r.score.gaps).toEqual(["1", "2", "3", "4"]);
    expect(r.fields.summary).toBe("Begeleider in een woonzorgcentrum.");
    expect(r.fields.isSocialSector).toBe(true);
    expect(r.fields.diplomaRequired).toBe("bachelor sociaal werk");
    expect(r.fields.payScale).toBe("IFIC");
  });
});

describe("scoreVacancy", () => {
  it("calls the scoring model with effort, 6000 tokens and language-specific system", async () => {
    let seen: StructuredRequest<unknown> | null = null;
    const llm: LlmClient = {
      async structured(req) {
        seen = req as StructuredRequest<unknown>;
        return { data: out() as never, usage };
      },
      async text() {
        throw new Error("unused");
      },
    };
    const settings = { ...DEFAULT_SETTINGS, outputLanguage: "nl" as const, effort: "medium" as const };
    const r = await scoreVacancy(
      llm,
      settings,
      profile,
      { title: "Begeleider", organization: "X", location: "Gent", sourceName: "VDAB", url: "https://x/1", description: "Tekst" },
      [{ feedback: "up", title: "T", organization: "O", note: "mooi" }],
    );
    expect(r.score.bucket).toBe("strong");
    expect(r.usage).toBe(usage);
    expect(r.organization).toBe("WZC Zonnebloem");
    expect(r.location).toBe("Gent");
    const req = seen as unknown as StructuredRequest<unknown>;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.effort).toBe("medium");
    expect(req.maxTokens).toBe(6000);
    expect(req.purpose).toBe("score");
    expect(req.system[0].cache).toBe(false);
    expect(req.system[0].text).toContain("in Dutch");
    expect(req.system[1].cache).toBe(true);
    expect(req.system[1].text).toContain("Maatschappelijk werker");
    expect(req.user).toContain("The candidate liked: T at O. Note: mooi");
  });
});

describe("prompts", () => {
  it("renders preferences readably and skips empty ones", () => {
    const text = renderPreferences(profile.preferences);
    expect(text).toContain("- Home location: Gent");
    expect(text).toContain("- Hours: full-time only");
    expect(text).toContain("- Acceptable contract types: permanent");
    expect(text).toContain("- Deal-breakers: nachtwerk");
    expect(text).not.toContain("Ambitions");
    expect(renderPreferences(DEFAULT_PREFERENCES)).toBe("(no preferences stated)");
  });

  it("language instruction follows the setting", () => {
    expect(buildScoringSystem(profile, "en")[0].text).toContain("in English");
    expect(buildScoringSystem(profile, "nl")[0].text).toContain("in Dutch");
  });

  it("limits feedback to 10 and truncates the description to 12000 chars", () => {
    const fb = Array.from({ length: 15 }, (_, i) => ({ feedback: "down" as const, title: `T${i}`, organization: "", note: "" }));
    const u = buildScoringUser(
      { title: "t", organization: "o", location: "l", sourceName: "s", url: "u", description: "x".repeat(20000) },
      fb,
    );
    expect(u.match(/disliked:/g)).toHaveLength(10);
    expect(u).toContain("# Vacancy\nTitle: t");
    expect(u.length).toBeLessThan(13500);
    const none = buildScoringUser({ title: "t", organization: "o", location: "l", sourceName: "s", url: "u", description: "d" }, []);
    expect(none.startsWith("# Vacancy")).toBe(true);
  });

  describe("travel line", () => {
    const v = { title: "t", organization: "o", location: "Lendelede", sourceName: "s", url: "u", description: "d" };
    const travel = { homeLabel: "Gent, Oost-Vlaanderen, Belgium", travelMinutes: 34, travelKm: 41, geoState: "ok" as const };

    it("is placed right after the Location line when travel is known", () => {
      const u = buildScoringUser(v, [], travel);
      expect(u).toContain(
        "Location: Lendelede\nTravel from the candidate's home (Gent, Oost-Vlaanderen, Belgium): 34 min by car, 41 km (car, without traffic; computed by a routing service)\nSource: s",
      );
    });

    it("notes when only the region is known", () => {
      const u = buildScoringUser(v, [], { ...travel, geoState: "approximate" });
      expect(u).toContain("about 34 min by car, 41 km (car, without traffic; computed by a routing service) (only the region of the job is known)");
    });

    it("is absent without travel data", () => {
      expect(buildScoringUser(v, [])).not.toContain("Travel from");
      expect(buildScoringUser(v, [], null)).not.toContain("Travel from");
      expect(buildScoringUser(v, [], { ...travel, travelMinutes: null })).not.toContain("Travel from");
    });

    it("the system prompt tells the model how to use it", () => {
      expect(buildScoringSystem(profile, "en")[0].text).toContain("When a Travel line is present");
    });

    it("scoreVacancy passes the travel through to the user prompt", async () => {
      let user = "";
      const llm = { structured: async (req: any) => { user = req.user; return { data: req.schema.parse(out()), usage: {} as any }; }, text: async () => { throw new Error("x"); } };
      await scoreVacancy(llm as any, DEFAULT_SETTINGS, profile, v, [], travel);
      expect(user).toContain("Travel from the candidate's home");
    });
  });
});
