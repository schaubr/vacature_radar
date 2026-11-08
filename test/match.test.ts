import { describe, expect, it } from "vitest";
import { dedupeKey, normalizeOrg, normalizeTitle } from "../src/core/match/dedupe";
import { prefilter } from "../src/core/match/prefilter";
import { DEFAULT_PREFERENCES, type Preferences } from "../src/shared/types";

const prefs = (over: Partial<Preferences>): Preferences => ({ ...DEFAULT_PREFERENCES, ...over });

describe("normalizeTitle", () => {
  it("strips gender markers in all spellings", () => {
    for (const t of [
      "Maatschappelijk werker (m/v/x)", "Maatschappelijk werker m/v/x", "Maatschappelijk werker (m/v)",
      "Maatschappelijk werker (v/m/x)", "Maatschappelijk werker (h/f/x)", "Maatschappelijk werker ( M / V / X )",
    ]) {
      expect(normalizeTitle(t)).toBe("maatschappelijk werker");
    }
  });
  it("removes diacritics and punctuation, collapses spaces", () => {
    expect(normalizeTitle("  Coördinator  Informatieveiligheid – (Gent)!  ")).toBe("coordinator informatieveiligheid gent");
  });
  it("does not eat slashes inside normal words", () => {
    expect(normalizeTitle("Begeleider ICT/Support")).toBe("begeleider ict support");
    expect(normalizeTitle("Verpleegkundige a/b")).toBe("verpleegkundige a b");
  });
});

describe("normalizeOrg and dedupeKey", () => {
  it("removes legal suffixes but keeps ocmw", () => {
    expect(normalizeOrg("Zorgbedrijf VZW")).toBe("zorgbedrijf");
    expect(normalizeOrg("Dienst X cvba")).toBe("dienst x");
    expect(normalizeOrg("OCMW Lendelede")).toBe("ocmw lendelede");
    expect(normalizeOrg("Bvb Nvidia")).toBe("bvb nvidia");
  });
  it("builds a stable key across sources", () => {
    expect(dedupeKey("Maatschappelijk werker (m/v/x)", "OCMW LENDELEDE")).toBe(dedupeKey("maatschappelijk  werker", "Ocmw Lendelede"));
    expect(dedupeKey("Jurist", "")).toBe("jurist|");
    expect(dedupeKey("Jurist", "A")).not.toBe(dedupeKey("Jurist", "B"));
  });
});

describe("prefilter", () => {
  const item = { title: "Maatschappelijk werker (m/v/x)", snippet: "Begeleiding van gezinnen in Gent" };
  it("passes with no keywords", () => {
    expect(prefilter(item, prefs({}))).toEqual({ pass: true });
  });
  it("excludes on title only, whole words, case and diacritics insensitive", () => {
    expect(prefilter({ title: "Chauffeur CAMION", snippet: "" }, prefs({ excludeKeywords: ["camion"] }))).toMatchObject({ pass: false });
    expect(prefilter({ title: "Kok in café", snippet: "" }, prefs({ excludeKeywords: ["cafe"] }))).toMatchObject({ pass: false });
    expect(prefilter({ title: "Districtmanager", snippet: "" }, prefs({ excludeKeywords: ["ict"] }))).toEqual({ pass: true });
    expect(prefilter({ title: "Jurist", snippet: "chauffeur gezocht" }, prefs({ excludeKeywords: ["chauffeur"] }))).toEqual({ pass: true });
  });
  it("supports multi-word keywords and ignores blank ones", () => {
    expect(prefilter({ title: "Medewerker  technische   dienst", snippet: "" }, prefs({ excludeKeywords: ["technische dienst", " "] }))).toMatchObject({ pass: false });
    expect(prefilter(item, prefs({ excludeKeywords: ["", "  "] }))).toEqual({ pass: true });
    expect(prefilter(item, prefs({ includeKeywords: [" "] }))).toEqual({ pass: true });
  });
  it("requires an include keyword in title or snippet when set", () => {
    expect(prefilter(item, prefs({ includeKeywords: ["maatschappelijk werker"] }))).toEqual({ pass: true });
    expect(prefilter(item, prefs({ includeKeywords: ["gezinnen"] }))).toEqual({ pass: true });
    const r = prefilter({ title: "Boekhouder", snippet: "Financiën" }, prefs({ includeKeywords: ["sociaal", "welzijn"] }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toMatch(/include/i);
  });
  it("exclude wins over include and reports the keyword", () => {
    const r = prefilter(item, prefs({ includeKeywords: ["gezinnen"], excludeKeywords: ["werker"] }));
    expect(r).toEqual({ pass: false, reason: 'Title contains excluded keyword "werker"' });
  });
  it("escapes regex characters in keywords", () => {
    expect(prefilter({ title: "C++ developer", snippet: "" }, prefs({ excludeKeywords: ["c++"] }))).toMatchObject({ pass: false });
    expect(() => prefilter(item, prefs({ excludeKeywords: ["(", "[a"] }))).not.toThrow();
  });
});
