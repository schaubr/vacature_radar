import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type NewVacancy } from "../src/core/db/store";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  type ScoreResult,
  type SourceInput,
  type VacancyFields,
  type VacancyFilter,
} from "../src/shared/types";
import { RADAR_METHODS } from "../src/shared/ipc";

const srcInput = (over: Partial<SourceInput> = {}): SourceInput => ({
  name: "Src",
  url: "https://example.org/jobs",
  enabled: true,
  renderMode: "auto",
  scanIntervalHours: null,
  maxPages: 1,
  notes: "",
  ...over,
});

const T0 = "2026-11-01T10:00:00.000Z";
let counter = 0;
const nv = (sourceId: number, over: Partial<NewVacancy> = {}): NewVacancy => {
  counter++;
  return {
    sourceId,
    title: `Job ${counter}`,
    url: `https://example.org/jobs/${counter}`,
    organization: "Org",
    location: "Gent",
    dateText: "",
    snippet: "snippet",
    dedupeKey: `job ${counter}|org`,
    now: T0,
    ...over,
  };
};

const fields = (over: Partial<VacancyFields> = {}): VacancyFields => ({
  summary: "s",
  sector: "welzijn",
  isSocialSector: true,
  hours: "full",
  contract: "permanent",
  diplomaRequired: "bachelor",
  experienceRequired: "",
  payScale: "",
  deadline: "2026-12-01",
  ...over,
});

const score = (n: number, bucket: ScoreResult["bucket"]): ScoreResult => ({
  score: n,
  bucket,
  subscores: { diploma: 1, experience: 2, skills: 3, preferences: 4 },
  reasons: ["r"],
  gaps: ["g"],
  knockoutReason: bucket === "knockout" ? "no diploma" : "",
  confidence: "high",
});

const filter = (over: Partial<VacancyFilter> = {}): VacancyFilter => ({
  statuses: [],
  minScore: null,
  sourceId: null,
  search: "",
  includeUnscored: true,
  maxTravelMinutes: null,
  sort: "score",
  ...over,
});

const scoreIt = (store: Store, id: number, n: number, bucket: ScoreResult["bucket"] = "possible") =>
  store.saveScore(id, { fields: fields(), score: score(n, bucket), model: "claude-opus-5-5", profileVersion: 1 });

describe("migrations", () => {
  it("is idempotent when reopening a file db and keeps data", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vr-store-"));
    const file = path.join(dir, "radar.db");
    try {
      const a = new Store(file);
      const s = a.createSource(srcInput({ name: "Persisted" }));
      a.insertVacancy(nv(s.id));
      a.close();
      const b = new Store(file);
      expect(b.listSources().map((x) => x.name)).toEqual(["Persisted"]);
      expect(b.listVacancies(filter())).toHaveLength(1);
      b.close();
      const c = new Store(file);
      expect(c.listSources()).toHaveLength(1);
      c.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RADAR_METHODS", () => {
  it("lists every api method once", () => {
    expect(new Set(RADAR_METHODS).size).toBe(RADAR_METHODS.length);
    expect(RADAR_METHODS).toContain("sources.list");
    expect(RADAR_METHODS).toContain("app.status");
    expect(RADAR_METHODS).toHaveLength(29);
  });
});

describe("sources", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("creates with defaults and maps fields", () => {
    const s = store.createSource(srcInput({ name: "A", renderMode: "browser", scanIntervalHours: 2.5, maxPages: 3, notes: "n" }));
    expect(s).toMatchObject({
      name: "A",
      enabled: true,
      renderMode: "browser",
      scanIntervalHours: 2.5,
      maxPages: 3,
      notes: "n",
      detectedMode: null,
      strategy: null,
      recipe: null,
      lastStatus: "never",
      lastError: null,
      lastFound: 0,
      consecutiveFailures: 0,
    });
    expect(new Date(s.createdAt).toISOString()).toBe(s.createdAt);
    expect(store.getSource(s.id)).toEqual(s);
    expect(store.getSource(999)).toBeNull();
  });

  it("clamps maxPages to 1..5", () => {
    expect(store.createSource(srcInput({ maxPages: 99 })).maxPages).toBe(5);
    expect(store.createSource(srcInput({ maxPages: 0 })).maxPages).toBe(1);
  });

  it("updates only the given fields", () => {
    const s = store.createSource(srcInput());
    const u = store.updateSource(s.id, { name: "New", enabled: false, scanIntervalHours: 12 });
    expect(u).toMatchObject({ name: "New", enabled: false, scanIntervalHours: 12, url: s.url });
    expect(store.updateSource(s.id, { scanIntervalHours: null }).scanIntervalHours).toBeNull();
    expect(() => store.updateSource(999, { name: "x" })).toThrow();
  });

  it("updates runtime fields incl. recipe json and explicit nulls", () => {
    const s = store.createSource(srcInput());
    const recipe = {
      itemSelector: "li", titleSelector: "a", linkSelector: "a", organizationSelector: "",
      locationSelector: "", dateSelector: "", nextPageSelector: "",
    };
    const u = store.updateSourceRuntime(s.id, {
      detectedMode: "browser", strategy: "recipe", recipe, lastScanAt: T0, lastSuccessAt: T0,
      lastStatus: "ok", lastFound: 20, lastPageHash: "abc", consecutiveFailures: 0,
    });
    expect(u).toMatchObject({ detectedMode: "browser", strategy: "recipe", recipe, lastStatus: "ok", lastFound: 20, lastPageHash: "abc" });
    const e = store.updateSourceRuntime(s.id, { lastStatus: "error", lastError: "boom", consecutiveFailures: 2 });
    expect(e).toMatchObject({ lastStatus: "error", lastError: "boom", consecutiveFailures: 2, strategy: "recipe" });
    const cleared = store.updateSourceRuntime(s.id, { strategy: null, recipe: null, lastError: null });
    expect(cleared).toMatchObject({ strategy: null, recipe: null, lastError: null, lastFound: 20 });
  });

  it("deleting a source deletes its vacancies, even with cross-source duplicates", () => {
    const a = store.createSource(srcInput({ name: "A" }));
    const b = store.createSource(srcInput({ name: "B" }));
    const va = store.insertVacancy(nv(a.id, { dedupeKey: "k" }));
    const vb = store.insertVacancy(nv(b.id, { dedupeKey: "k" }));
    store.setDuplicateOf(vb.id, va.id);
    store.deleteSource(a.id);
    expect(store.getVacancy(va.id)).toBeNull();
    expect(store.getVacancy(vb.id)).not.toBeNull();
    expect(store.getVacancy(vb.id)!.duplicateOf).toBeNull();
    expect(store.listSources()).toHaveLength(1);
  });
});

describe("vacancies", () => {
  let store: Store;
  let sid: number;
  beforeEach(() => {
    store = new Store(":memory:");
    sid = store.createSource(srcInput({ name: "VVSG" })).id;
  });

  it("inserts with defaults and finds by url/id", () => {
    const v = store.insertVacancy(nv(sid, { title: "Maatschappelijk werker", url: "https://x.be/1" }));
    expect(v).toMatchObject({
      sourceId: sid, title: "Maatschappelijk werker", status: "new", scoreState: "pending", score: null,
      bucket: null, description: "", fields: null, scoreResult: null, missedScans: 0, duplicateOf: null,
      firstSeenAt: T0, lastSeenAt: T0, feedback: null, feedbackNote: "", notifiedAt: null,
    });
    expect(store.getVacancyByUrl("https://x.be/1")?.id).toBe(v.id);
    expect(store.getVacancy(v.id)?.url).toBe("https://x.be/1");
    expect(store.getVacancyByUrl("nope")).toBeNull();
  });

  it("rejects duplicate urls", () => {
    store.insertVacancy(nv(sid, { url: "https://x.be/same" }));
    expect(() => store.insertVacancy(nv(sid, { url: "https://x.be/same" }))).toThrow();
  });

  it("touchVacancySeen updates last_seen, resets missed, and reopens closed", () => {
    const v = store.insertVacancy(nv(sid));
    store.markMissed(sid, [], 5);
    expect(store.getVacancy(v.id)!.missedScans).toBe(1);
    store.touchVacancySeen(v.id, "2026-11-02T00:00:00.000Z");
    expect(store.getVacancy(v.id)).toMatchObject({ missedScans: 0, lastSeenAt: "2026-11-02T00:00:00.000Z", status: "new" });
    store.setStatus(v.id, "closed");
    store.touchVacancySeen(v.id, "2026-11-03T00:00:00.000Z");
    expect(store.getVacancy(v.id)!.status).toBe("seen");
    store.setStatus(v.id, "applied");
    store.touchVacancySeen(v.id, "2026-11-04T00:00:00.000Z");
    expect(store.getVacancy(v.id)!.status).toBe("applied");
  });

  it("markMissed increments, closes after N, and only touches this source's open rows", () => {
    const other = store.createSource(srcInput({ name: "Other" })).id;
    const a = store.insertVacancy(nv(sid));
    const b = store.insertVacancy(nv(sid));
    const o = store.insertVacancy(nv(other));
    expect(store.markMissed(sid, [a.id], 3)).toEqual([]);
    expect(store.getVacancy(b.id)!.missedScans).toBe(1);
    expect(store.getVacancy(a.id)!.missedScans).toBe(0);
    expect(store.getVacancy(o.id)!.missedScans).toBe(0);
    store.markMissed(sid, [a.id], 3);
    // Seen less than 7 days ago: counted, but not closed yet.
    expect(store.markMissed(sid, [a.id], 3, new Date("2026-11-05T00:00:00Z"))).toEqual([]);
    expect(store.getVacancy(b.id)).toMatchObject({ status: "new", missedScans: 3 });
    expect(store.markMissed(sid, [a.id], 3, new Date("2026-11-09T00:00:00Z"))).toEqual([b.id]);
    expect(store.getVacancy(b.id)).toMatchObject({ status: "closed", missedScans: 4 });
    // Already closed rows are not counted again.
    expect(store.markMissed(sid, [a.id], 3, new Date("2026-11-09T00:00:00Z"))).toEqual([]);
    expect(store.getVacancy(b.id)!.missedScans).toBe(4);
    expect(store.getVacancy(a.id)!.status).toBe("new");
  });

  it("updateIdentity only overwrites with non-empty values and keeps the dedupe key", () => {
    const v = store.insertVacancy(nv(sid, { organization: "Old org", location: "Old town" }));
    store.updateIdentity(v.id, { organization: "  ", location: "Gent" });
    expect(store.getVacancy(v.id)).toMatchObject({ organization: "Old org", location: "Gent", dedupeKey: v.dedupeKey });
    store.updateIdentity(v.id, { organization: "New org" });
    expect(store.getVacancy(v.id)).toMatchObject({ organization: "New org", location: "Gent", dedupeKey: v.dedupeKey });
  });

  it("markMissed never closes interested/applied/dismissed rows", () => {
    const late = new Date("2026-12-01T00:00:00Z");
    const ids = (["interested", "applied", "dismissed", "seen"] as const).map((st) => {
      const v = store.insertVacancy(nv(sid));
      store.setStatus(v.id, st);
      return v.id;
    });
    expect(store.markMissed(sid, [], 1, late)).toEqual([ids[3]]);
    expect(ids.slice(0, 3).map((id) => store.getVacancy(id)!.status)).toEqual(["interested", "applied", "dismissed"]);
    expect(store.getVacancy(ids[1])!.missedScans).toBe(1);
  });

  it("closeExpired closes new/seen rows past their deadline only", () => {
    const mk = (deadline: string, status: "new" | "applied" = "new") => {
      const v = store.insertVacancy(nv(sid));
      store.saveScore(v.id, {
        fields: { summary: "", sector: "", isSocialSector: true, hours: "", contract: "", diplomaRequired: "", experienceRequired: "", payScale: "", deadline },
        score: { score: 50, bucket: "possible", subscores: { diploma: 1, experience: 1, skills: 1, preferences: 1 }, reasons: [], gaps: [], knockoutReason: "", confidence: "high" },
        model: "m",
        profileVersion: 1,
      });
      store.setStatus(v.id, status);
      return v.id;
    };
    const past = mk("2026-11-01");
    const today = mk("2026-11-08");
    const none = mk("");
    const applied = mk("2026-10-01", "applied");
    const unscored = store.insertVacancy(nv(sid)).id;
    expect(store.closeExpired("2026-11-08")).toEqual([past]);
    expect([today, none, applied, unscored].map((id) => store.getVacancy(id)!.status)).toEqual(["new", "new", "applied", "new"]);
  });

  it("findDuplicateCandidate honours key, exclusion, closed, canonical-only and 60-day window", () => {
    const now = new Date("2026-11-08T00:00:00.000Z");
    const first = store.insertVacancy(nv(sid, { dedupeKey: "k1", now: "2026-11-01T00:00:00.000Z" }));
    const second = store.insertVacancy(nv(sid, { dedupeKey: "k1", now: "2026-11-02T00:00:00.000Z" }));
    expect(store.findDuplicateCandidate("k1", second.id, now)?.id).toBe(first.id);
    expect(store.findDuplicateCandidate("k1", first.id, now)?.id).toBe(second.id);
    expect(store.findDuplicateCandidate("other", second.id, now)).toBeNull();
    store.setDuplicateOf(first.id, second.id);
    expect(store.findDuplicateCandidate("k1", 9999, now)?.id).toBe(second.id); // first is no longer canonical
    store.setStatus(second.id, "closed");
    expect(store.findDuplicateCandidate("k1", 9999, now)).toBeNull();
    const old = store.insertVacancy(nv(sid, { dedupeKey: "old", now: "2026-08-01T00:00:00.000Z" }));
    expect(store.findDuplicateCandidate("old", old.id + 100, now)).toBeNull();
    expect(store.findDuplicateCandidate("old", old.id + 100, new Date("2026-09-15T00:00:00.000Z"))?.id).toBe(old.id);
  });

  it("saveDetail fills organization/location only when empty (listing values win)", () => {
    const v = store.insertVacancy(nv(sid, { organization: "List Org", location: "Gent", dateText: "1 nov" }));
    store.saveDetail(v.id, "full text", { organization: "", location: "Oost-Vlaanderen", dateText: "2 nov" });
    const r = store.getVacancy(v.id)!;
    expect(r).toMatchObject({ description: "full text", organization: "List Org", location: "Gent", dateText: "2 nov" });
    expect(r.detailFetchedAt).toBeTruthy();
    const e = store.insertVacancy(nv(sid, { organization: "", location: "" }));
    store.saveDetail(e.id, "t", { organization: "Detail Org", location: "Brugge" });
    expect(store.getVacancy(e.id)).toMatchObject({ organization: "Detail Org", location: "Brugge" });
  });

  it("saveScore sets state, bucket, json and clears errors; setScoreState transitions", () => {
    const v = store.insertVacancy(nv(sid));
    store.setScoreState(v.id, "error", { error: "boom" });
    expect(store.getVacancy(v.id)).toMatchObject({ scoreState: "error", scoreError: "boom" });
    store.setScoreState(v.id, "filtered", { prefilterReason: "excluded: stage" });
    expect(store.getVacancy(v.id)).toMatchObject({ scoreState: "filtered", scoreError: null, prefilterReason: "excluded: stage" });
    store.setScoreState(v.id, "skipped");
    expect(store.getVacancy(v.id)).toMatchObject({ scoreState: "skipped", prefilterReason: null });
    store.saveScore(v.id, { fields: fields(), score: score(82, "strong"), model: "claude-opus-5-5", profileVersion: 3 });
    const r = store.getVacancy(v.id)!;
    expect(r).toMatchObject({
      scoreState: "scored", score: 82, bucket: "strong", scoreModel: "claude-opus-5-5", profileVersion: 3,
      scoreError: null, prefilterReason: null,
    });
    expect(r.scoreResult).toEqual(score(82, "strong"));
    expect(r.fields).toEqual(fields());
    expect(r.scoredAt).toBeTruthy();
    store.setScoreState(v.id, "pending");
    expect(store.getVacancy(v.id)).toMatchObject({ scoreState: "pending", score: 82 });
  });

  it("pendingScoring needs description, no duplicates, oldest first, honours limit", () => {
    const a = store.insertVacancy(nv(sid, { now: "2026-11-03T00:00:00.000Z" }));
    const b = store.insertVacancy(nv(sid, { now: "2026-11-01T00:00:00.000Z" }));
    const c = store.insertVacancy(nv(sid, { now: "2026-11-02T00:00:00.000Z" }));
    const d = store.insertVacancy(nv(sid)); // no description
    const e = store.insertVacancy(nv(sid, { now: "2026-11-04T00:00:00.000Z" }));
    for (const x of [a, b, c, e]) store.saveDetail(x.id, "text");
    store.setDuplicateOf(e.id, a.id);
    expect(store.pendingScoring(10).map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(store.pendingScoring(2).map((r) => r.id)).toEqual([b.id, c.id]);
    scoreIt(store, b.id, 50);
    expect(store.pendingScoring(10).map((r) => r.id)).toEqual([c.id, a.id]);
    expect(store.pendingScoring(10).map((r) => r.id)).not.toContain(d.id);
  });

  it("status, feedback, notified", () => {
    const v = store.insertVacancy(nv(sid));
    store.setStatus(v.id, "interested");
    store.setFeedback(v.id, "up", "nice");
    store.markNotified(v.id, T0);
    expect(store.getVacancy(v.id)).toMatchObject({ status: "interested", feedback: "up", feedbackNote: "nice", notifiedAt: T0 });
    store.setFeedback(v.id, null, "");
    expect(store.getVacancy(v.id)).toMatchObject({ feedback: null, feedbackNote: "" });
  });

  it("recentFeedback returns only rated rows, newest first, limited", () => {
    const rows = [1, 2, 3, 4].map(() => store.insertVacancy(nv(sid)));
    store.setFeedback(rows[0].id, "up", "good");
    store.setFeedback(rows[2].id, "down", "too far");
    store.setFeedback(rows[3].id, "up", "");
    const fb = store.recentFeedback(10);
    expect(fb.map((f) => f.feedback)).toEqual(["up", "down", "up"]);
    expect(fb[1]).toEqual({ title: rows[2].title, organization: "Org", feedback: "down", note: "too far" });
    expect(store.recentFeedback(2)).toHaveLength(2);
  });
});

describe("listVacancies / detail / counts", () => {
  let store: Store;
  let s1: number;
  let s2: number;
  beforeEach(() => {
    store = new Store(":memory:");
    s1 = store.createSource(srcInput({ name: "VVSG" })).id;
    s2 = store.createSource(srcInput({ name: "VDAB" })).id;
  });

  it("default status filter hides closed and dismissed", () => {
    const a = store.insertVacancy(nv(s1));
    const b = store.insertVacancy(nv(s1));
    const c = store.insertVacancy(nv(s1));
    const d = store.insertVacancy(nv(s1));
    store.setStatus(b.id, "closed");
    store.setStatus(c.id, "dismissed");
    store.setStatus(d.id, "applied");
    expect(store.listVacancies(filter()).map((r) => r.id).sort()).toEqual([a.id, d.id].sort());
    expect(store.listVacancies(filter({ statuses: ["closed", "dismissed"] })).map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
    expect(store.listVacancies(filter({ statuses: ["applied"] })).map((r) => r.id)).toEqual([d.id]);
  });

  it("minScore, includeUnscored and sourceId", () => {
    const hi = store.insertVacancy(nv(s1));
    const lo = store.insertVacancy(nv(s1));
    const un = store.insertVacancy(nv(s2));
    scoreIt(store, hi.id, 80, "strong");
    scoreIt(store, lo.id, 40, "weak");
    const ids = (f: Partial<VacancyFilter>) => store.listVacancies(filter(f)).map((r) => r.id);
    expect(ids({ includeUnscored: false })).toEqual([hi.id, lo.id]);
    expect(ids({ includeUnscored: true })).toEqual([hi.id, lo.id, un.id]);
    expect(ids({ minScore: 50, includeUnscored: false })).toEqual([hi.id]);
    expect(ids({ minScore: 50, includeUnscored: true })).toEqual([hi.id, un.id]);
    expect(ids({ minScore: 0, includeUnscored: false })).toEqual([hi.id, lo.id]);
    expect(ids({ sourceId: s2 })).toEqual([un.id]);
    expect(ids({ sourceId: s1, includeUnscored: false })).toEqual([hi.id, lo.id]);
  });

  it("search is case-insensitive over title, organization and location (incl. diacritics)", () => {
    const a = store.insertVacancy(nv(s1, { title: "Maatschappelijk Werker", organization: "OCMW Lendelede", location: "Lendelede" }));
    const b = store.insertVacancy(nv(s1, { title: "Poetshulp", organization: "Zorgbedrijf", location: "Kortrijk" }));
    const c = store.insertVacancy(nv(s1, { title: "Thuisbegeleider", organization: "Vzw Ätna", location: "Gent" }));
    const ids = (q: string) => store.listVacancies(filter({ search: q })).map((r) => r.id);
    expect(ids("maatschappelijk")).toEqual([a.id]);
    expect(ids("ZORGBEDRIJF")).toEqual([b.id]);
    expect(ids("kortrijk")).toEqual([b.id]);
    expect(ids("ätna")).toEqual([c.id]);
    expect(ids("  lendelede ")).toHaveLength(1);
    expect(ids("nothing")).toEqual([]);
    expect(ids("")).toHaveLength(3);
  });

  it("sorts by score desc with nulls last then first_seen desc; date sort = first_seen desc", () => {
    const a = store.insertVacancy(nv(s1, { now: "2026-11-01T00:00:00.000Z" }));
    const b = store.insertVacancy(nv(s1, { now: "2026-11-02T00:00:00.000Z" }));
    const c = store.insertVacancy(nv(s1, { now: "2026-11-03T00:00:00.000Z" }));
    const d = store.insertVacancy(nv(s1, { now: "2026-11-04T00:00:00.000Z" }));
    const e = store.insertVacancy(nv(s1, { now: "2026-11-05T00:00:00.000Z" }));
    scoreIt(store, a.id, 70);
    scoreIt(store, b.id, 90);
    scoreIt(store, c.id, 70);
    // d, e unscored
    expect(store.listVacancies(filter({ sort: "score" })).map((r) => r.id)).toEqual([b.id, c.id, a.id, e.id, d.id]);
    expect(store.listVacancies(filter({ sort: "date" })).map((r) => r.id)).toEqual([e.id, d.id, c.id, b.id, a.id]);
  });

  it("excludes duplicates, counts them on the canonical row, and fills sourceName/deadline/scoreState", () => {
    const canon = store.insertVacancy(nv(s1, { dedupeKey: "k" }));
    const dup1 = store.insertVacancy(nv(s2, { dedupeKey: "k" }));
    const dup2 = store.insertVacancy(nv(s2, { dedupeKey: "k" }));
    store.setDuplicateOf(dup1.id, canon.id);
    store.setDuplicateOf(dup2.id, canon.id);
    scoreIt(store, canon.id, 75, "strong");
    const list = store.listVacancies(filter());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: canon.id, sourceName: "VVSG", duplicateCount: 2, deadline: "2026-12-01", scoreState: "scored",
      score: 75, bucket: "strong", status: "new", feedback: null, firstSeenAt: T0,
    });
    const detail = store.getVacancyDetail(canon.id)!;
    expect(detail.duplicates.map((d) => d.id)).toEqual([dup1.id, dup2.id]);
    expect(detail.duplicates[0]).toMatchObject({ sourceName: "VDAB", url: dup1.url });
    expect(store.getVacancyDetail(dup1.id)!.duplicateCount).toBe(0);
    expect(store.countVacancies(70).total).toBe(1);
  });

  it("getVacancyDetail returns the full record", () => {
    const v = store.insertVacancy(nv(s1, { snippet: "snip" }));
    expect(store.getVacancyDetail(12345)).toBeNull();
    let d = store.getVacancyDetail(v.id)!;
    expect(d).toMatchObject({ description: "", snippet: "snip", fields: null, scoreResult: null, scoreModel: null, scoredAt: null, deadline: "", duplicates: [], lastSeenAt: T0 });
    store.saveDetail(v.id, "body");
    scoreIt(store, v.id, 60);
    store.setFeedback(v.id, "down", "meh");
    d = store.getVacancyDetail(v.id)!;
    expect(d).toMatchObject({ description: "body", score: 60, scoreModel: "claude-opus-5-5", feedback: "down", feedbackNote: "meh" });
    expect(d.fields).toEqual(fields());
    expect(d.scoreResult?.subscores.skills).toBe(3);
    expect(d.scoredAt).toBeTruthy();
    store.setScoreState(v.id, "filtered", { prefilterReason: "no keyword" });
    expect(store.getVacancyDetail(v.id)!.prefilterReason).toBe("no keyword");
  });

  it("countVacancies", () => {
    const mk = (status: "new" | "interested" | "applied" | "dismissed" | "closed", sc: number | null, bucket: ScoreResult["bucket"] = "strong") => {
      const v = store.insertVacancy(nv(s1));
      store.setStatus(v.id, status);
      if (sc !== null) scoreIt(store, v.id, sc, bucket);
      return v;
    };
    mk("new", 90);
    mk("new", 70);
    mk("new", 69, "possible");
    mk("new", 20, "knockout");
    mk("new", null);
    mk("interested", 80);
    mk("applied", 85);
    mk("dismissed", 85);
    mk("closed", 85);
    const dup = mk("new", 95);
    store.setDuplicateOf(dup.id, store.listVacancies(filter())[0].id);
    expect(store.countVacancies(70)).toEqual({ new: 5, interested: 1, applied: 1, strongNew: 2, total: 7 });
    expect(store.countVacancies(95).strongNew).toBe(0);
  });
});

describe("profile and settings", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("auto-creates the profile with defaults and version 0", () => {
    const p = store.getProfile();
    expect(p).toEqual({
      markdown: "",
      preferences: DEFAULT_PREFERENCES,
      version: 0,
      importedFrom: null,
      updatedAt: null,
      homeGeo: null,
      homeGeoError: null,
    });
    expect(store.getProfile().version).toBe(0);
  });

  it("increments the version on every save and records origin", () => {
    const prefs = { ...DEFAULT_PREFERENCES, homeLocation: "Gent", contractTypes: ["permanent"], includeKeywords: ["sociaal"] };
    const p1 = store.saveProfile({ markdown: "# Me", preferences: prefs });
    expect(p1).toMatchObject({ markdown: "# Me", version: 1, importedFrom: "manual", preferences: prefs });
    expect(p1.updatedAt).toBeTruthy();
    const p2 = store.saveProfile({ markdown: "# Me 2", preferences: prefs, importedFrom: "linkedin_zip" });
    expect(p2).toMatchObject({ version: 2, importedFrom: "linkedin_zip", markdown: "# Me 2" });
    expect(store.getProfile()).toEqual(p2);
  });

  it("tolerates stored preferences missing newer keys", () => {
    store.saveProfile({ markdown: "x", preferences: { ...DEFAULT_PREFERENCES, regions: "Gent" } });
    expect(store.getProfile().preferences).toEqual({ ...DEFAULT_PREFERENCES, regions: "Gent" });
  });

  it("merges settings over defaults and persists patches", () => {
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    const s = store.saveSettings({ scanIntervalHours: 3, effort: "high", notificationsEnabled: false });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, scanIntervalHours: 3, effort: "high", notificationsEnabled: false });
    expect(store.saveSettings({ monthlyBudgetUsd: 12.5 })).toEqual({ ...s, monthlyBudgetUsd: 12.5 });
    expect(store.saveSettings({ effort: "low" }).scanIntervalHours).toBe(3);
    expect(store.saveSettings({})).toEqual(store.getSettings());
  });

  it("ignores unknown or wrongly typed setting values", () => {
    store.saveSettings({ bogus: 1 } as never);
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
    store.saveSettings({ scanIntervalHours: "x" } as never);
    expect(store.getSettings().scanIntervalHours).toBe(DEFAULT_SETTINGS.scanIntervalHours);
  });
});

describe("usage", () => {
  let store: Store;
  const now = new Date("2026-11-15T12:00:00.000Z");
  const use = (at: string, costUsd: number, purpose: "score" | "learn_recipe" | "extract_listing" | "profile_import" = "score") =>
    store.recordUsage({ at, model: "claude-opus-5-5", purpose, inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd });
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("sums the current UTC calendar month only", () => {
    use("2026-10-31T23:59:59.999Z", 100);
    use("2026-11-01T00:00:00.000Z", 1.5);
    use("2026-11-15T11:00:00.000Z", 0.25);
    use("2026-12-01T00:00:00.000Z", 50);
    expect(store.monthUsageUsd(now)).toBeCloseTo(1.75);
    expect(store.monthUsageUsd(new Date("2026-10-10T00:00:00.000Z"))).toBeCloseTo(100);
    expect(store.monthUsageUsd(new Date("2027-01-10T00:00:00.000Z"))).toBe(0);
  });

  it("summarizes by purpose and by day", () => {
    use("2026-11-02T10:00:00.000Z", 1, "score");
    use("2026-11-02T11:00:00.000Z", 2, "score");
    use("2026-11-15T01:00:00.000Z", 0.5, "learn_recipe");
    use("2026-10-20T01:00:00.000Z", 3, "profile_import"); // last 30 days but previous month
    use("2026-10-01T01:00:00.000Z", 9, "score"); // outside 30 days (Oct 17 start)
    const u = store.usageSummary(now, 3);
    expect(u.monthUsd).toBeCloseTo(3.5);
    expect(u.budgetUsd).toBe(3);
    expect(u.budgetExceeded).toBe(true);
    expect(u.byPurpose).toEqual([
      { purpose: "score", usd: 3, calls: 2 },
      { purpose: "learn_recipe", usd: 0.5, calls: 1 },
    ]);
    expect(u.last30Days).toHaveLength(30);
    expect(u.last30Days[0].day).toBe("2026-10-17");
    expect(u.last30Days[29].day).toBe("2026-11-15");
    const byDay = Object.fromEntries(u.last30Days.map((d) => [d.day, d.usd]));
    expect(byDay["2026-11-02"]).toBeCloseTo(3);
    expect(byDay["2026-11-15"]).toBeCloseTo(0.5);
    expect(byDay["2026-10-20"]).toBeCloseTo(3);
    expect(byDay["2026-11-10"]).toBe(0);
    expect(byDay["2026-10-01"]).toBeUndefined();
  });

  it("budget flag is false while under budget", () => {
    use("2026-11-02T10:00:00.000Z", 1);
    expect(store.usageSummary(now, 5)).toMatchObject({ budgetExceeded: false, monthUsd: 1 });
  });
});

describe("log", () => {
  it("lists newest first with levels and source ids", () => {
    const store = new Store(":memory:");
    const s = store.createSource(srcInput());
    store.log("info", "one");
    store.log("warn", "two", s.id);
    store.log("error", "three", null);
    const l = store.listLog(10);
    expect(l.map((x) => x.message)).toEqual(["three", "two", "one"]);
    expect(l[1]).toMatchObject({ level: "warn", sourceId: s.id });
    expect(l[0].sourceId).toBeNull();
    expect(store.listLog(2)).toHaveLength(2);
  });

  it("prunes to the last 2000 rows", () => {
    const store = new Store(":memory:");
    for (let i = 1; i <= 2250; i++) store.log("info", `m${i}`);
    const l = store.listLog(5000);
    // pruning happens every 100 inserts, so between 2000 and 2100 rows remain
    expect(l.length).toBeGreaterThanOrEqual(2000);
    expect(l.length).toBeLessThanOrEqual(2100);
    expect(l[0].message).toBe("m2250");
    expect(l.some((x) => x.message === "m1")).toBe(false);
    expect(l.some((x) => x.message === "m251")).toBe(true);
  });
});

describe("travel storage (user_version 2)", () => {
  let store: Store;
  let sid: number;
  beforeEach(() => {
    store = new Store(":memory:");
    sid = store.createSource(srcInput()).id;
  });

  it("upgrades an existing v1 database file in place, keeping data", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { readFileSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "radar-mig-"));
    const file = path.join(dir, "radar.db");
    try {
      // Build a v1 database with the original schema (migration 1 text) and some data.
      const src = readFileSync(path.join(__dirname, "../src/core/db/store.ts"), "utf8");
      const m = /const MIGRATIONS: string\[\] = \[\s*`([\s\S]*?)`,\s*`/.exec(src);
      expect(m).toBeTruthy();
      const db = new DatabaseSync(file);
      db.exec(m![1]);
      db.exec("PRAGMA user_version = 1");
      db.exec(`INSERT INTO sources (name, url, created_at) VALUES ('Old', 'https://x.test', '${T0}')`);
      db.exec(`INSERT INTO vacancies (source_id, url, title, organization, location, first_seen_at, last_seen_at, dedupe_key, score)
               VALUES (1, 'https://x.test/1', 'Old job', 'Org', 'Gent', '${T0}', '${T0}', 'k', 77)`);
      db.exec(`INSERT INTO profile (id, markdown, preferences_json, version) VALUES (1, 'md', '{"homeLocation":"Gent"}', 3)`);
      db.close();

      const s = new Store(file);
      const cols = (t: string) => (s as unknown as { db: import("node:sqlite").DatabaseSync }).db
        .prepare(`PRAGMA table_info(${t})`).all().map((r) => (r as { name: string }).name);
      expect(cols("vacancies")).toEqual(expect.arrayContaining(["geo_query", "geo_label", "geo_lat", "geo_lon", "geo_state", "geo_error", "travel_minutes", "travel_km", "travel_home_key"]));
      expect(cols("profile")).toEqual(expect.arrayContaining(["home_query", "home_label", "home_lat", "home_lon", "home_error"]));
      expect(cols("geo_cache")).toContain("confidence");
      const [v] = s.listVacancies(filter());
      expect(v).toMatchObject({ title: "Old job", score: 77, geoState: "pending", travelMinutes: null });
      const p = s.getProfile();
      expect(p).toMatchObject({ markdown: "md", version: 3, homeGeo: null, homeGeoError: null });
      expect(p.preferences.homeLocation).toBe("Gent");
      expect(s.getMeta("seedRevision")).toBeNull();
      s.setMeta("seedRevision", 2);
      expect(s.getMeta("seedRevision")).toBe(2);
      expect(Number(((s as unknown as { db: import("node:sqlite").DatabaseSync }).db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(3);
      s.close();
      // reopening a migrated file does not migrate again and keeps meta
      const again = new Store(file);
      expect(again.getMeta("seedRevision")).toBe(2);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a v2 database file to v3 (meta table), keeping data", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(path.join(tmpdir(), "radar-mig2-"));
    const file = path.join(dir, "radar.db");
    try {
      const first = new Store(file);
      first.createSource(srcInput({ name: "Kept" }));
      first.close();
      // Roll back to a genuine v2 file: no meta table, user_version 2.
      const raw = new DatabaseSync(file);
      raw.exec("DROP TABLE meta; PRAGMA user_version = 2");
      raw.close();

      const s = new Store(file);
      expect(s.listSources().map((x) => x.name)).toEqual(["Kept"]);
      expect(s.getMeta("seedRevision")).toBeNull();
      s.setMeta("k", { a: 1 });
      expect(s.getMeta("k")).toEqual({ a: 1 });
      s.close();
      const check = new DatabaseSync(file);
      expect(Number((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(3);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("geo cache round-trips with normalized keys", () => {
    store.putGeoCache({ query: "  Gent  ", found: true, lat: 51.05, lon: 3.72, label: "Gent, BE", layer: "locality", confidence: 0.9 });
    expect(store.getGeoCache("gent")).toMatchObject({ query: "gent", found: true, lat: 51.05, label: "Gent, BE" });
    store.putGeoCache({ query: "Gent", found: false, lat: null, lon: null, label: "", layer: "", confidence: null });
    expect(store.getGeoCache("GENT")?.found).toBe(false);
    expect(store.getGeoCache("nowhere")).toBeNull();
  });

  it("setHomeGeo is exposed through getProfile", () => {
    store.setHomeGeo({ query: "gent", label: "Gent, BE", lat: 51, lon: 3 });
    expect(store.getProfile()).toMatchObject({ homeGeo: { label: "Gent, BE", lat: 51, lon: 3 }, homeGeoError: null });
    expect(store.getHomeQuery()).toBe("gent");
    store.setHomeGeo({ query: "zzz", error: "Could not find" });
    expect(store.getProfile()).toMatchObject({ homeGeo: null, homeGeoError: "Could not find" });
  });

  it("geo/travel work queues", () => {
    const a = store.insertVacancy(nv(sid));
    const b = store.insertVacancy(nv(sid));
    const c = store.insertVacancy(nv(sid));
    expect(store.vacanciesNeedingGeo(10).map((r) => r.id)).toEqual([a.id, b.id, c.id]);
    expect(store.vacanciesNeedingGeo(10, [b.id]).map((r) => r.id)).toEqual([b.id]);
    store.saveVacancyGeo(a.id, { query: "gent", label: "Gent", lat: 51, lon: 3, state: "ok", error: null });
    store.saveVacancyGeo(b.id, { query: "x", label: "", lat: null, lon: null, state: "not_found", error: "nope" });
    expect(store.vacanciesNeedingGeo(10).map((r) => r.id)).toEqual([c.id]);
    expect(store.vacanciesNeedingTravel("home1", 10).map((r) => r.id)).toEqual([a.id]);
    store.saveTravel(a.id, { minutes: 30, km: 20, homeKey: "home1" });
    expect(store.vacanciesNeedingTravel("home1", 10)).toEqual([]);
    expect(store.vacanciesNeedingTravel("home2", 10).map((r) => r.id)).toEqual([a.id]);
    store.clearTravel();
    expect(store.getVacancy(a.id)).toMatchObject({ travelMinutes: null, travelKm: null, travelHomeKey: null, geoState: "ok" });
    store.setStatus(a.id, "closed");
    expect(store.vacanciesNeedingTravel("home1", 10)).toEqual([]);
  });

  it("listVacancies: maxTravelMinutes keeps unknown, sort distance puts unknown last", () => {
    const mk = (min: number | null) => {
      const v = store.insertVacancy(nv(sid));
      store.saveVacancyGeo(v.id, { query: "q", label: "l", lat: 1, lon: 1, state: min === null ? "pending" : "ok", error: null });
      if (min !== null) store.saveTravel(v.id, { minutes: min, km: min / 2, homeKey: "h" });
      return v.id;
    };
    const far = mk(80);
    const unknown = mk(null);
    const near = mk(10);
    const mid = mk(40);
    expect(store.listVacancies(filter({ sort: "distance" })).map((r) => r.id)).toEqual([near, mid, far, unknown]);
    expect(store.listVacancies(filter({ sort: "distance", maxTravelMinutes: 45 })).map((r) => r.id)).toEqual([near, mid, unknown]);
    const item = store.listVacancies(filter({ sort: "distance" }))[0];
    expect(item).toMatchObject({ travelMinutes: 10, travelKm: 5, geoState: "ok" });
    expect(store.getVacancyDetail(near)).toMatchObject({ geoQuery: "q", geoLabel: "l", geoError: null, travelMinutes: 10 });
  });

  it("updateIdentity resets geo_state to pending only when the location changes", () => {
    const v = store.insertVacancy(nv(sid, { location: "Gent" }));
    store.saveVacancyGeo(v.id, { query: "Gent", label: "Gent", lat: 1, lon: 1, state: "ok", error: null });
    store.updateIdentity(v.id, { organization: "New org", location: "Gent" });
    expect(store.getVacancy(v.id)!.geoState).toBe("ok");
    store.updateIdentity(v.id, { location: "" });
    expect(store.getVacancy(v.id)!.geoState).toBe("ok");
    store.updateIdentity(v.id, { location: "Lendelede" });
    expect(store.getVacancy(v.id)).toMatchObject({ location: "Lendelede", geoState: "pending" });
  });
});
