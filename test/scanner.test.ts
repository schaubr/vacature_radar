import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { Store } from "../src/core/db/store";
import { cleanHtmlForLlm, sha256 } from "../src/core/extract/html";
import { applyRecipe } from "../src/core/extract/recipe";
import { BudgetExceededError, type LlmClient, type LlmUsage } from "../src/core/llm/client";
import { PoliteFetcher, type RawFetch } from "../src/core/net/fetcher";
import type { PageRenderer } from "../src/core/net/render";
import type { Notifier } from "../src/core/notify";
import { OrsClient, type JsonHttp } from "../src/core/geo/ors";
import { TravelService } from "../src/core/geo/travel";
import { ScanService } from "../src/core/scan/scanner";
import type { RadarEvents } from "../src/shared/ipc";
import type { Recipe, SourceInput } from "../src/shared/types";
import { translatorFor, type Lang } from "../src/shared/i18n";
import { HELAN_RECIPE, VDAB_RECIPE, VDAB_URL, VVSG_RECIPE, VVSG_URL, fixture } from "./helpers";

const VVSG_HTML = fixture("vvsg_list.html");
const VVSG_ITEMS = applyRecipe(VVSG_HTML, VVSG_URL, VVSG_RECIPE);
const N = VVSG_ITEMS.length;
const ZN_URL = "https://www.zorgneticuro.be/content/overzicht-jobs";
const ZN_HTML = fixture("zorgneticuro_list.html");
const SHELL = "<html><body><app-root></app-root></body></html>";

const USAGE: LlmUsage = { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 };

function recipeOut(r: Recipe) {
  return {
    found: true,
    item_selector: r.itemSelector,
    title_selector: r.titleSelector,
    link_selector: r.linkSelector,
    organization_selector: r.organizationSelector,
    location_selector: r.locationSelector,
    date_selector: r.dateSelector,
    next_page_selector: r.nextPageSelector,
    notes: "",
  };
}

function scoreOut(score: number, organization = "", location = "") {
  return {
    summary: "s", organization, location, sector: "social", is_social_sector: true, hours: "", contract: "",
    diploma_required: "", experience_required: "", pay_scale: "", deadline: "",
    score, bucket: "strong" as const,
    subscores: { diploma: 80, experience: 80, skills: 80, preferences: 80 },
    reasons: ["r"], gaps: [], knockout_reason: "", confidence: "high" as const,
  };
}

class FakeLlm implements LlmClient {
  calls: Record<string, number> = {};
  titles: string[] = [];
  users: string[] = [];
  scoreFor: (description: string, title: string) => number = () => 80;
  learned: Recipe | null = VVSG_RECIPE;
  failScoreFor: string | null = null;
  identity: { organization: string; location: string } = { organization: "", location: "" };
  async structured(req: any) {
    this.calls[req.purpose] = (this.calls[req.purpose] ?? 0) + 1;
    let data: unknown;
    if (req.purpose === "learn_recipe") {
      data = this.learned ? recipeOut(this.learned) : { ...recipeOut(VVSG_RECIPE), found: false };
    } else if (req.purpose === "score") {
      const text = String(req.user);
      const title = /Title: (.*)/.exec(text)?.[1] ?? "";
      this.titles.push(title);
      this.users.push(text);
      if (this.failScoreFor && title.includes(this.failScoreFor)) throw new Error("boom");
      data = scoreOut(this.scoreFor(text, title), this.identity.organization, this.identity.location);
    } else {
      data = { vacancies: [] };
    }
    return { data: req.schema.parse(data), usage: USAGE };
  }
  async text(): Promise<never> {
    throw new Error("unused");
  }
}

interface Env {
  store: Store;
  scanner: ScanService;
  llm: FakeLlm;
  notes: { title: string; body: string; vacancyId?: number }[];
  events: string[];
  rawCalls: string[];
  renderCalls: string[];
  routes: Map<string, string>;
  renders: Map<string, string>;
  renderFrames: Map<string, { url: string; included: boolean }[]>;
  setNow(iso: string): void;
  addSource(over?: Partial<SourceInput> & { recipe?: Recipe | null }): number;
}

function mk(opts: { lang?: Lang; llm?: boolean; profile?: boolean; renderer?: boolean; travel?: (store: Store) => { computeFor(ids?: number[]): Promise<unknown> } } = {}): Env {
  const store = new Store(":memory:");
  if (opts.profile !== false) store.saveProfile({ markdown: "I am a social worker.", preferences: store.getProfile().preferences });
  const routes = new Map<string, string>();
  const renders = new Map<string, string>();
  const renderFrames = new Map<string, { url: string; included: boolean }[]>();
  const rawCalls: string[] = [];
  const renderCalls: string[] = [];
  const raw: RawFetch = async (url) => {
    rawCalls.push(url);
    if (url.endsWith("/robots.txt")) {
      const body = routes.get(url);
      return body === undefined ? { status: 404, url, contentType: "text/plain", body: "" } : { status: 200, url, contentType: "text/plain", body };
    }
    const body = routes.get(url);
    if (body !== undefined) return { status: 200, url, contentType: "text/html", body };
    if (url.startsWith("https://www.vvsg.be/vacatures/")) return { status: 200, url, contentType: "text/html", body: fixture("vvsg_detail.html") };
    return { status: 500, url, contentType: "text/html", body: "err" };
  };
  const renderer: PageRenderer | null =
    opts.renderer === false
      ? null
      : {
          async render(url) {
            renderCalls.push(url);
            const html = renders.get(url) ?? (url.includes("/vacatures/") && url.includes("vdab") && !url.includes("trefwoord") ? fixture("vdab_detail.html") : undefined);
            if (html === undefined) throw new Error("render: no page for " + url);
            return { url, html, frames: renderFrames.get(url) };
          },
        };
  const tr = translatorFor(() => opts.lang ?? store.getSettings().outputLanguage);
  const fetcher = new PoliteFetcher(raw, { minIntervalMs: 0, sleep: async () => {}, t: tr });
  const llm = new FakeLlm();
  const notes: Env["notes"] = [];
  const events: string[] = [];
  const notifier: Notifier = { notify: (n) => notes.push(n) };
  let t = Date.parse("2026-11-08T10:00:00Z");
  const scanner = new ScanService({
    store,
    fetcher,
    renderer,
    llm: opts.llm === false ? null : llm,
    notifier,
    now: () => new Date(t),
    emit: <E extends keyof RadarEvents>(e: E) => void events.push(e),
    travel: opts.travel?.(store),
    t: tr,
  });
  routes.set(VVSG_URL, VVSG_HTML);
  return {
    store, scanner, llm, notes, events, rawCalls, renderCalls, routes, renders, renderFrames,
    setNow: (iso) => (t = Date.parse(iso)),
    addSource(over = {}) {
      const { recipe, ...input } = over;
      const s = store.createSource({ name: "VVSG", url: VVSG_URL, enabled: true, renderMode: "static", scanIntervalHours: null, maxPages: 1, notes: "", ...input });
      store.updateSourceRuntime(s.id, { recipe: recipe === undefined ? VVSG_RECIPE : recipe });
      return s.id;
    },
  };
}

const rows = (e: Env) => e.store.listVacancies({ statuses: [], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" });

describe("ScanService", () => {
  it("inserts new items, fetches details and scores them", async () => {
    const e = mk();
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const list = rows(e);
    expect(list).toHaveLength(N);
    expect(list.every((v) => v.scoreState === "scored" && v.score === 80)).toBe(true);
    const s = e.store.getSource(id)!;
    expect(s.lastStatus).toBe("ok");
    expect(s.lastFound).toBe(N);
    expect(s.strategy).toBe("recipe");
    expect(s.lastPageHash).toBeTruthy();
    expect(e.store.getVacancy(list[0].id)!.description).not.toBe("");
    expect(e.events).toContain("vacancies.changed");
    expect(e.events).toContain("sources.changed");
    expect(e.store.listLog(50).some((l) => /Scan finished: \d+ found, \d+ new, \d+ scored/.test(l.message))).toBe(true);
  });

  it("a second scan touches instead of inserting and does not rescore", async () => {
    const e = mk();
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const scoreCalls = e.llm.calls.score;
    e.setNow("2026-11-08T18:00:00Z");
    await e.scanner.scanSource(id);
    expect(rows(e)).toHaveLength(N);
    expect(e.llm.calls.score).toBe(scoreCalls);
    const v = e.store.getVacancy(rows(e)[0].id)!;
    expect(v.lastSeenAt).toBe("2026-11-08T18:00:00.000Z");
    expect(v.firstSeenAt).toBe("2026-11-08T10:00:00.000Z");
  });

  it("links duplicates (same title+org from another source) and does not score them", async () => {
    const e = mk();
    const a = e.addSource();
    await e.scanner.scanSource(a);
    const scoreCalls = e.llm.calls.score;
    const urlB = "https://www.vvsg.be/other-list";
    e.routes.set(urlB, VVSG_HTML.replaceAll("/vacatures/overzicht-vacatures/", "/vacatures/kopie/"));
    const b = e.addSource({ name: "Copy", url: urlB });
    await e.scanner.scanSource(b);
    const dups = e.store.getVacancyByUrl(VVSG_ITEMS[0].url.replace("/overzicht-vacatures/", "/kopie/"))!;
    expect(dups.sourceId).toBe(b);
    expect(dups.duplicateOf).not.toBeNull();
    expect(e.llm.calls.score).toBe(scoreCalls);
    expect(rows(e)).toHaveLength(N); // duplicates are hidden from the list
    expect(e.store.getSource(b)!.lastFound).toBe(N);
  });

  it("lists every distinct URL of one source even when title+organization repeat (Helan)", async () => {
    const e = mk();
    const url = "https://www.helanjobs.be/vacatures/";
    e.routes.set(url, fixture("helan_list.html"));
    const id = e.addSource({ name: "Helan", url, recipe: HELAN_RECIPE });
    const expected = applyRecipe(fixture("helan_list.html"), url, HELAN_RECIPE).map((i) => i.url);
    expect(new Set(expected).size).toBe(10);
    await e.scanner.scanSource(id);
    await e.scanner.scanSource(id);
    const listed = rows(e).map((r) => r.url).sort();
    expect(listed).toEqual([...expected].sort());
    expect(e.store.listVacancies({ statuses: [], minScore: null, sourceId: id, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" })).toHaveLength(10);
  });

  it("applies the prefilter", async () => {
    const e = mk();
    const prefs = { ...e.store.getProfile().preferences, excludeKeywords: ["financieel"] };
    e.store.saveProfile({ markdown: "I am a social worker.", preferences: prefs });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const filtered = rows(e).filter((v) => v.scoreState === "filtered");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((v) => /financieel/i.test(v.title))).toBe(true);
    expect(e.store.getVacancyDetail(filtered[0].id)!.prefilterReason).toMatch(/excluded keyword/);
    expect(e.llm.titles.some((t) => /financieel/i.test(t))).toBe(false);
  });

  it("caps scoring per scan and marks the rest skipped", async () => {
    const e = mk();
    e.store.saveSettings({ maxNewScoredPerScan: 3 });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const list = rows(e);
    expect(list.filter((v) => v.scoreState === "scored")).toHaveLength(3);
    expect(list.filter((v) => v.scoreState === "skipped")).toHaveLength(N - 3);
  });

  it("notifies individually for 1-3 matches", async () => {
    const e = mk();
    e.llm.scoreFor = (_t, title) => (/Teamcoach/i.test(title) ? 90 : 40);
    const id = e.addSource();
    await e.scanner.scanSource(id);
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0].title).toBe("90 · Teamcoach samenleven");
    const nv = e.store.getVacancy(e.notes[0].vacancyId!)!;
    expect(e.notes[0].body).toBe([nv.organization, nv.location].filter(Boolean).join(" · "));
    expect(e.notes[0].body.length).toBeGreaterThan(0);
    expect(e.notes[0].vacancyId).toBeGreaterThan(0);
    expect(e.store.getVacancy(e.notes[0].vacancyId!)!.notifiedAt).not.toBeNull();
    // a rescan does not notify again
    await e.scanner.scanSource(id);
    expect(e.notes).toHaveLength(1);
  });

  it("sends one summary for more than 3 matches, and respects notificationsEnabled", async () => {
    const e = mk();
    const id = e.addSource();
    await e.scanner.scanSource(id);
    expect(e.notes).toHaveLength(1);
    expect(e.notes[0].title).toBe(`${N} new strong matches`);
    expect(e.notes[0].body.split("\n")).toHaveLength(3);
    expect(e.notes[0].vacancyId).toBeUndefined();

    const q = mk();
    q.store.saveSettings({ notificationsEnabled: false });
    await q.scanner.scanSource(q.addSource());
    expect(q.notes).toHaveLength(0);
  });

  it("closes vacancies only after enough missed successful scans", async () => {
    const e = mk();
    e.store.saveSettings({ closeAfterMissedScans: 2 });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const all = rows(e);
    // listing shrinks to its first 2 items
    const $ = load(VVSG_HTML);
    $(".node--type-job").slice(2).remove();
    const partial = $.html();
    const keep = applyRecipe(partial, VVSG_URL, VVSG_RECIPE).length;
    expect(keep).toBe(2);
    e.routes.set(VVSG_URL, partial);
    await e.scanner.scanSource(id);
    let closed = e.store.listVacancies({ statuses: ["closed"], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" });
    expect(closed).toHaveLength(0);
    // a failing/empty scan in between must not count as a miss
    e.routes.set(VVSG_URL, "<html><body><p>nothing</p></body></html>");
    await e.scanner.scanSource(id);
    expect(e.store.getSource(id)!.lastStatus).toBe("empty");
    // Misses reached the limit, but the rows were seen less than 7 days ago: nothing closes yet.
    e.routes.set(VVSG_URL, partial);
    await e.scanner.scanSource(id);
    expect(e.store.listVacancies({ statuses: ["closed"], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" })).toHaveLength(0);
    // A user workflow state is never auto-closed.
    const missing = all.filter((v) => !applyRecipe(partial, VVSG_URL, VVSG_RECIPE).some((i) => i.url === v.url));
    e.store.setStatus(missing[0].id, "applied");
    e.setNow("2026-11-17T10:00:00Z");
    await e.scanner.scanSource(id);
    expect(e.store.getVacancy(missing[0].id)!.status).toBe("applied");
    closed = e.store.listVacancies({ statuses: ["closed"], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" });
    expect(closed).toHaveLength(all.length - 2 - 1);
  });

  it("closes vacancies past their deadline at the end of a scan", async () => {
    const e = mk();
    e.llm.scoreFor = () => 50;
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const v = rows(e)[0];
    const row = e.store.getVacancy(v.id)!;
    e.store.saveScore(v.id, { fields: { ...row.fields!, deadline: "2026-11-01" }, score: row.scoreResult!, model: "m", profileVersion: 1 });
    e.setNow("2026-11-09T10:00:00Z");
    await e.scanner.scanSource(id);
    expect(e.store.getVacancy(v.id)!.status).toBe("closed");
  });

  it("writes the organization and location from the scoring answer back, keeping the dedupe key", async () => {
    const e = mk();
    e.llm.identity = { organization: "Clean Org", location: "Clean Town" };
    await e.scanner.scanSource(e.addSource());
    for (const v of rows(e)) {
      const row = e.store.getVacancy(v.id)!;
      expect(row).toMatchObject({ organization: "Clean Org", location: "Clean Town" });
      expect(row.dedupeKey).not.toContain("clean org");
    }
    // empty answers leave the stored values alone (scoreOne path)
    const f = mk();
    f.store.saveSettings({ maxNewScoredPerScan: 1 });
    await f.scanner.scanSource(f.addSource());
    const skipped = rows(f).find((v) => v.scoreState === "skipped")!;
    f.llm.identity = { organization: "Late Org", location: "" };
    const before = f.store.getVacancy(skipped.id)!;
    await f.scanner.scoreOne(skipped.id);
    expect(f.store.getVacancy(skipped.id)).toMatchObject({ organization: "Late Org", location: before.location });
  });

  it("says why 0 items were found when there is no key or no budget", async () => {
    const noKey = mk({ llm: false });
    const id = noKey.addSource({ recipe: null });
    await noKey.scanner.scanSource(id);
    expect(noKey.store.getSource(id)!.lastError).toMatch(/Add an Anthropic API key/);
    const broke = mk();
    broke.store.recordUsage({ model: "m", purpose: "score", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 10, at: "2026-11-02T00:00:00.000Z" });
    const bid = broke.addSource({ recipe: null });
    await broke.scanner.scanSource(bid);
    expect(broke.store.getSource(bid)!.lastError).toMatch(/monthly budget/);
  });

  it("scorePending scores the backlog, shares one run and yields to a running scan", async () => {
    const e = mk({ profile: false });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    expect(rows(e).every((v) => v.scoreState === "pending")).toBe(true);
    await e.scanner.scorePending(); // still no profile: quiet no-op
    expect(e.llm.calls.score).toBeUndefined();
    expect(e.store.listLog(50).filter((l) => /Scoring skipped/.test(l.message))).toHaveLength(1);
    e.store.saveProfile({ markdown: "profile", preferences: e.store.getProfile().preferences });
    e.events.length = 0;
    const p1 = e.scanner.scorePending();
    const p2 = e.scanner.scorePending();
    expect(p2).toBe(p1);
    await p1;
    expect(rows(e).every((v) => v.scoreState === "scored")).toBe(true);
    expect(e.llm.calls.score).toBe(N);
    expect(e.events).toContain("vacancies.changed");
    expect(e.notes).toHaveLength(1); // summary notification for the strong matches
    // while a scan queue runs, scorePending does nothing
    const scan = e.scanner.scanMany([id]);
    await e.scanner.scorePending();
    await scan;
    expect(e.llm.calls.score).toBe(N);
  });

  it("stops on robots.txt disallow", async () => {
    const e = mk();
    e.routes.set("https://www.vvsg.be/robots.txt", "User-agent: *\nDisallow: /");
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const s = e.store.getSource(id)!;
    expect(s.lastStatus).toBe("error");
    expect(s.lastError).toBe("Blocked by robots.txt");
    expect(s.consecutiveFailures).toBe(1);
    expect(rows(e)).toHaveLength(0);
    expect(e.rawCalls.filter((u) => u === VVSG_URL)).toHaveLength(0);
  });

  it("reports 0 items as empty without marking anything missed", async () => {
    const e = mk();
    const id = e.addSource();
    await e.scanner.scanSource(id);
    e.routes.set(VVSG_URL, "<html><body><p>geen vacatures</p></body></html>");
    await e.scanner.scanSource(id);
    const s = e.store.getSource(id)!;
    expect(s.lastStatus).toBe("empty");
    expect(s.consecutiveFailures).toBe(1);
    expect(rows(e).every((v) => e.store.getVacancy(v.id)!.missedScans === 0)).toBe(true);
    await e.scanner.scanSource(id);
    expect(e.store.getSource(id)!.consecutiveFailures).toBe(2);
  });

  it("records a fetch error and keeps the queue alive", async () => {
    const e = mk();
    e.routes.set("https://bad.example/jobs", "x");
    const bad = e.addSource({ name: "Bad", url: "https://bad.example/other" }); // 500
    const good = e.addSource();
    await e.scanner.scanMany([bad, good]);
    expect(e.store.getSource(bad)!.lastStatus).toBe("error");
    expect(e.store.getSource(bad)!.lastError).toMatch(/HTTP 500/);
    expect(e.store.getSource(good)!.lastStatus).toBe("ok");
    expect(e.scanner.status).toEqual({ scanning: false, currentSourceId: null, queueLength: 0 });
  });

  it("marks a vacancy as error when its detail page fails and continues", async () => {
    const e = mk();
    const firstUrl = VVSG_ITEMS[0].url;
    const id = e.addSource();
    e.routes.set(firstUrl, ""); // empty detail page
    await e.scanner.scanSource(id);
    const v = e.store.getVacancyByUrl(firstUrl)!;
    expect(v.scoreState).toBe("error");
    expect(rows(e).filter((r) => r.scoreState === "scored")).toHaveLength(N - 1);
  });

  it("leaves vacancies pending when the budget is exceeded, missing key, or empty profile", async () => {
    const budget = mk();
    budget.store.recordUsage({ model: "m", purpose: "score", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 10, at: "2026-11-02T00:00:00.000Z" });
    await budget.scanner.scanSource(budget.addSource());
    expect(rows(budget)).toHaveLength(N);
    expect(rows(budget).every((v) => v.scoreState === "pending")).toBe(true);
    expect(budget.llm.calls.score).toBeUndefined();
    expect(budget.store.listLog(50).some((l) => /Scoring skipped \(monthly budget reached\)/.test(l.message))).toBe(true);

    const nollm = mk({ llm: false });
    await nollm.scanner.scanSource(nollm.addSource());
    expect(rows(nollm).every((v) => v.scoreState === "pending")).toBe(true);

    const noprofile = mk({ profile: false });
    await noprofile.scanner.scanSource(noprofile.addSource());
    expect(rows(noprofile).every((v) => v.scoreState === "pending")).toBe(true);
    expect(noprofile.llm.calls.score).toBeUndefined();
    // once the profile exists, the next scan scores the backlog
    noprofile.store.saveProfile({ markdown: "now I have one", preferences: noprofile.store.getProfile().preferences });
    await noprofile.scanner.scanSource(noprofile.addSource({ name: "again" }));
    expect(rows(noprofile).filter((v) => v.scoreState === "scored").length).toBe(N);
  });

  it("stops the queue on BudgetExceededError and flags other failures per vacancy", async () => {
    const e = mk();
    let n = 0;
    const orig = e.llm.structured.bind(e.llm);
    e.llm.structured = (async (req: any) => {
      if (req.purpose === "score" && ++n === 3) throw new BudgetExceededError();
      return orig(req);
    }) as never;
    await e.scanner.scanSource(e.addSource());
    expect(rows(e).filter((v) => v.scoreState === "scored")).toHaveLength(2);
    expect(rows(e).filter((v) => v.scoreState === "pending")).toHaveLength(N - 2);

    const f = mk();
    f.llm.failScoreFor = "Teamcoach";
    await f.scanner.scanSource(f.addSource());
    const err = rows(f).filter((v) => v.scoreState === "error");
    expect(err).toHaveLength(1);
    expect(f.store.getVacancyDetail(err[0].id)!.scoreError).toBe("boom");
  });

  it("auto mode switches to the browser for a JS shell page and remembers it", async () => {
    const e = mk();
    e.routes.set(VDAB_URL, SHELL);
    e.renders.set(VDAB_URL, fixture("vdab_list.html"));
    const id = e.addSource({ name: "VDAB", url: VDAB_URL, renderMode: "auto", recipe: VDAB_RECIPE });
    await e.scanner.scanSource(id);
    const s = e.store.getSource(id)!;
    expect(s.lastStatus).toBe("ok");
    expect(s.detectedMode).toBe("browser");
    expect(e.renderCalls[0]).toBe(VDAB_URL);
    expect(e.renderCalls.length).toBeGreaterThan(1); // details are rendered too
    expect(rows(e).length).toBeGreaterThanOrEqual(10);
    const staticListFetches = () => e.rawCalls.filter((u) => u === VDAB_URL).length;
    expect(staticListFetches()).toBe(1);
    await e.scanner.scanSource(id);
    expect(staticListFetches()).toBe(1); // second scan goes straight to the browser
  });

  it("auto mode falls back to the browser when static yields 0 items, else records static", async () => {
    const e = mk();
    // static page is long enough to look rendered but has no vacancies
    e.routes.set(VDAB_URL, "<html><body><main>" + "<p>tekst zonder vacatures.</p>".repeat(200) + "<a href='/a'>a</a></main></body></html>");
    e.renders.set(VDAB_URL, fixture("vdab_list.html"));
    const id = e.addSource({ name: "VDAB", url: VDAB_URL, renderMode: "auto", recipe: VDAB_RECIPE });
    await e.scanner.scanSource(id);
    expect(e.store.getSource(id)!.detectedMode).toBe("browser");

    const st = mk();
    const sid = st.addSource({ renderMode: "auto" });
    await st.scanner.scanSource(sid);
    expect(st.store.getSource(sid)!.detectedMode).toBe("static");
    expect(st.renderCalls).toHaveLength(0);
  });

  it("learns a recipe with the LLM, and the cost guard skips LLM tiers on an unchanged page", async () => {
    const e = mk();
    const id = e.addSource({ recipe: null });
    await e.scanner.scanSource(id);
    expect(e.llm.calls.learn_recipe).toBe(1);
    expect(e.store.getSource(id)!.strategy).toBe("recipe");
    expect(e.store.getSource(id)!.recipe).toEqual(VVSG_RECIPE);

    // Source that previously needed the LLM, same page hash, no healthy recipe: do not pay again.
    const g = mk();
    const gid = g.addSource({ recipe: null });
    g.store.updateSourceRuntime(gid, { strategy: "llm", lastPageHash: sha256(cleanHtmlForLlm(VVSG_HTML)) });
    await g.scanner.scanSource(gid);
    expect(g.llm.calls.learn_recipe).toBeUndefined();
    expect(g.llm.calls.extract_listing).toBeUndefined();
    const s = g.store.getSource(gid)!;
    expect(s.lastStatus).toBe("ok");
    expect(s.consecutiveFailures).toBe(0);
    expect(rows(g)).toHaveLength(0);

    // A changed page is not guarded.
    const h = mk();
    const hid = h.addSource({ recipe: null });
    h.store.updateSourceRuntime(hid, { strategy: "llm", lastPageHash: "old" });
    await h.scanner.scanSource(hid);
    expect(h.llm.calls.learn_recipe).toBe(1);
    expect(rows(h)).toHaveLength(N);
  });

  it("follows next pages with the same recipe up to maxPages", async () => {
    const e = mk();
    const recipe = { ...VVSG_RECIPE, nextPageSelector: "a.next" };
    const page = (items: number, next: string | null) => {
      const $ = load(VVSG_HTML);
      $(".node--type-job").slice(items).remove();
      if (next) $("body").append(`<a class="next" href="${next}">next</a>`);
      return $.html();
    };
    e.routes.set(VVSG_URL, page(3, "/p2"));
    const p2 = VVSG_HTML.replaceAll("/vacatures/overzicht-vacatures/", "/vacatures/p2/");
    const $2 = load(p2);
    $2(".node--type-job").slice(2).remove();
    $2("body").append(`<a class="next" href="/p3">next</a>`);
    e.routes.set("https://www.vvsg.be/p2", $2.html());
    e.routes.set("https://www.vvsg.be/p3", page(1, null).replaceAll("/vacatures/overzicht-vacatures/", "/vacatures/p3/"));
    const id = e.addSource({ recipe, maxPages: 2 });
    await e.scanner.scanSource(id);
    expect(e.store.getSource(id)!.lastFound).toBe(5); // 3 + 2, page 3 not fetched
    expect(e.rawCalls).not.toContain("https://www.vvsg.be/p3");
    const id3 = e.addSource({ name: "three", recipe, maxPages: 5 });
    await e.scanner.scanSource(id3);
    expect(e.store.getSource(id3)!.lastFound).toBe(6);
  });

  it("merges ids into a running queue and reports status", async () => {
    const e = mk();
    const a = e.addSource();
    const b = e.addSource({ name: "B", url: "https://www.vvsg.be/b" });
    e.routes.set("https://www.vvsg.be/b", VVSG_HTML.replaceAll("/vacatures/overzicht-vacatures/", "/vacatures/b/"));
    const p1 = e.scanner.scanMany([a]);
    expect(e.scanner.status.scanning).toBe(true);
    const p2 = e.scanner.scanMany([a, b]); // a is queued/current already
    await Promise.all([p1, p2]);
    expect(e.store.getSource(a)!.lastStatus).toBe("ok");
    expect(e.store.getSource(b)!.lastStatus).toBe("ok");
    expect(e.rawCalls.filter((u) => u === VVSG_URL)).toHaveLength(1);
    expect(e.scanner.status).toEqual({ scanning: false, currentSourceId: null, queueLength: 0 });
  });

  it("notifies the status listener while scanning", async () => {
    const e = mk();
    const seen: { scanning: boolean; current: number | null }[] = [];
    e.scanner.setStatusListener(() => seen.push({ scanning: e.scanner.status.scanning, current: e.scanner.status.currentSourceId }));
    const id = e.addSource();
    await e.scanner.scanMany([id]);
    expect(seen.some((s) => s.current === id)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ scanning: false, current: null });
  });

  it("scoreOne fetches missing details and scores; errors are reported", async () => {
    const e = mk();
    e.store.saveSettings({ maxNewScoredPerScan: 1 });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    const skipped = rows(e).find((v) => v.scoreState === "skipped")!;
    await e.scanner.scoreOne(skipped.id);
    const d = e.store.getVacancyDetail(skipped.id)!;
    expect(d.scoreState).toBe("scored");
    expect(d.description).not.toBe("");

    const noKey = mk({ llm: false });
    await noKey.scanner.scanSource(noKey.addSource());
    const any = rows(noKey)[0];
    await expect(noKey.scanner.scoreOne(any.id)).rejects.toThrow(/API key/);
  });

  it("stores the diagnostic hint as lastError for a 0-item scan", async () => {
    const e = mk({ llm: false });
    e.routes.set(ZN_URL, ZN_HTML);
    const id = e.addSource({ name: "ZN", url: ZN_URL, recipe: null });
    await e.scanner.scanSource(id);
    const s = e.store.getSource(id)!;
    expect(s.lastStatus).toBe("empty");
    expect(s.lastError).toMatch(/loads its vacancies from Jobat with a script. Use Browser mode/);
    expect(e.store.listLog(20).some((l) => /loads its vacancies from Jobat/.test(l.message))).toBe(true);
  });

  describe("testSource", () => {
    it("extracts without writing vacancies and reports LLM cost", async () => {
      const e = mk();
      const r = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(r.ok).toBe(true);
      expect(r.strategy).toBe("recipe");
      expect(r.recipe).toEqual(VVSG_RECIPE);
      expect(r.items).toHaveLength(N);
      expect(r.robotsAllowed).toBe(true);
      expect(r.llmCostUsd).toBeCloseTo(0.01);
      expect(rows(e)).toHaveLength(0);
      expect(e.store.listSources()).toHaveLength(0);
    });

    it("uses the saved recipe of the source (by id, or by identical URL)", async () => {
      const e = mk({ llm: false });
      const id = e.addSource();
      const byId = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1, sourceId: id });
      expect(byId).toMatchObject({ ok: true, strategy: "recipe" });
      expect(byId.items).toHaveLength(N);
      const byUrl = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(byUrl.items).toHaveLength(N);
      // a different (edited) URL does not borrow the recipe
      e.routes.set("https://www.vvsg.be/andere", VVSG_HTML);
      const other = await e.scanner.testSource({ url: "https://www.vvsg.be/andere", renderMode: "static", maxPages: 1, sourceId: id });
      expect(other.ok).toBe(false);
    });

    it("reports robots and fetch failures", async () => {
      const e = mk();
      e.routes.set("https://www.vvsg.be/robots.txt", "User-agent: *\nDisallow: /");
      const r = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(r).toMatchObject({ ok: false, robotsAllowed: false, error: "Blocked by robots.txt" });
      const f = mk();
      const r2 = await f.scanner.testSource({ url: "https://nope.example/x", renderMode: "static", maxPages: 1 });
      expect(r2.ok).toBe(false);
      expect(r2.error).toMatch(/HTTP 500/);
    });

    it("needs no LLM for sites with JSON-LD or a feed, and says so when nothing is found", async () => {
      const e = mk({ llm: false });
      e.routes.set(VVSG_URL, `<html><body><p>${"nothing to see here ".repeat(30)}</p></body></html>`);
      const r = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/No vacancies/);
      expect(r.diagnostics.hint).toMatch(/No vacancies/);
    });

    it("always returns diagnostics, with a hint when nothing is found", async () => {
      const e = mk();
      const ok = await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(ok.diagnostics).toMatchObject({ modeUsed: "static", hint: null, llmUsed: true });
      expect(ok.diagnostics.linkCount).toBeGreaterThan(0);
      expect(ok.diagnostics.visibleTextChars).toBeGreaterThan(0);

      const z = mk({ llm: false });
      z.routes.set(ZN_URL, ZN_HTML);
      const r = await z.scanner.testSource({ url: ZN_URL, renderMode: "static", maxPages: 1 });
      expect(r.ok).toBe(false);
      expect(r.diagnostics.embeddedHosts).toContain("www.jobat.be");
      expect(r.diagnostics.portals.map((p) => p.host)).toEqual(["www.jobat.be"]);
      expect(r.diagnostics.hint).toMatch(/loads its vacancies from Jobat with a script. Use Browser mode/);
      expect(r.error).toBe(r.diagnostics.hint);

      const robots = mk();
      robots.routes.set("https://www.vvsg.be/robots.txt", "User-agent: *\nDisallow: /");
      const blocked = await robots.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 });
      expect(blocked.diagnostics.hint).toBeNull();
    });

    it("passes renderer frames through to the diagnostics", async () => {
      const e = mk({ llm: false });
      const frames = [{ url: "https://www.jobat.be/w", included: true }, { url: "https://www.googletagmanager.com/ns.html", included: false }];
      e.renders.set(ZN_URL, ZN_HTML);
      e.renderFrames.set(ZN_URL, frames);
      const r = await e.scanner.testSource({ url: ZN_URL, renderMode: "browser", maxPages: 1 });
      expect(r.modeUsed).toBe("browser");
      expect(r.diagnostics.frames).toEqual(frames);
      expect(r.diagnostics.hint).toMatch(/with a script, but nothing was captured/);
    });

    it("finds JobPosting JSON-LD inside an appended frame section", async () => {
      const e = mk({ llm: false });
      const ld = (n: number) => ({ "@type": "JobPosting", title: `Begeleider ${n}`, url: `https://www.jobat.be/job/${n}`, hiringOrganization: { name: "Zorg" } });
      const frame = `<section data-vr-frame-src="https://www.jobat.be/w"><script type="application/ld+json">${JSON.stringify([1, 2, 3].map(ld))}</script></section>`;
      e.renders.set(ZN_URL, ZN_HTML.replace("</body>", frame + "</body>"));
      const r = await e.scanner.testSource({ url: ZN_URL, renderMode: "browser", maxPages: 1 });
      expect(r.ok).toBe(true);
      expect(r.items).toHaveLength(3);
      expect(r.diagnostics.hint).toBeNull();
    });
  });
});

describe("ScanService travel integration", () => {
  it("computes travel before scoring so the LLM sees the Travel line", async () => {
    const order: string[] = [];
    const http: JsonHttp = async (_u, init) => {
      if (init.method === "GET") {
        order.push("geocode");
        return { status: 200, body: JSON.stringify({ features: [{ geometry: { coordinates: [3.7, 51.0] }, properties: { label: "Gent, Belgium", confidence: 0.9, layer: "locality" } }] }) };
      }
      order.push("matrix");
      const n = JSON.parse(init.body!).destinations.length;
      return { status: 200, body: JSON.stringify({ durations: [Array(n).fill(2040)], distances: [Array(n).fill(41.2)] }) };
    };
    const e = mk({
      travel: (store) => new TravelService({ store, ors: new OrsClient({ http, getKey: () => "K", minIntervalMs: 0 }), orsConfigured: () => true }),
    });
    e.store.saveProfile({ markdown: "I am a social worker.", preferences: { ...e.store.getProfile().preferences, homeLocation: "Gent" } });
    const origStructured = e.llm.structured.bind(e.llm);
    e.llm.structured = (async (req: any) => {
      if (req.purpose === "score") order.push("score");
      return origStructured(req);
    }) as typeof e.llm.structured;
    const id = e.addSource();
    await e.scanner.scanSource(id);
    expect(e.llm.users.length).toBeGreaterThan(0);
    expect(e.llm.users.some((u) => /Travel from the candidate's home \(Gent, Belgium\): 34 min by car, 41\.2 km \(car, without traffic/.test(u))).toBe(true);
    expect(order.indexOf("matrix")).toBeGreaterThan(-1);
    expect(order.indexOf("matrix")).toBeLessThan(order.indexOf("score"));
    // rows whose place cannot be derived (private organizations without a location) get no travel and no line
    const withTravel = rows(e).filter((v) => v.travelMinutes !== null);
    expect(withTravel.length).toBeGreaterThan(0);
    expect(withTravel[0]).toMatchObject({ travelMinutes: 34, travelKm: 41.2, geoState: "ok" });
    expect(e.llm.users.filter((u) => u.includes("Travel from")).length).toBe(withTravel.length);
  });

  it("scores normally without a travel line when travel is not configured", async () => {
    const e = mk();
    await e.scanner.scanSource(e.addSource());
    expect(e.llm.users.length).toBeGreaterThan(0);
    expect(e.llm.users.some((u) => u.includes("Travel from"))).toBe(false);
  });

  it("a failing travel service never fails the scan", async () => {
    const e = mk({ travel: () => ({ computeFor: async () => { throw new Error("ors down"); } }) });
    await e.scanner.scanSource(e.addSource());
    expect(e.store.getSource(1)!.lastStatus).toBe("ok");
    expect(rows(e).every((v) => v.scoreState === "scored")).toBe(true);
    expect(e.store.listLog(50).some((l) => /Travel time computation failed: ors down/.test(l.message))).toBe(true);
  });

  it("scorePending and scoreOne compute travel first", async () => {
    const calls: (number[] | undefined)[] = [];
    const e = mk({ travel: () => ({ computeFor: async (ids) => void calls.push(ids) }) });
    const id = e.addSource();
    await e.scanner.scanSource(id);
    calls.length = 0;
    await e.scanner.scorePending();
    expect(calls).toEqual([undefined]);
    calls.length = 0;
    const v = rows(e)[0];
    await e.scanner.scoreOne(v.id);
    expect(calls).toEqual([[v.id]]);
  });
});

describe("ScanService in Dutch", () => {
  it("writes the source error and the scan log in the current language", async () => {
    const e = mk({ lang: "nl" });
    e.routes.set("https://www.vvsg.be/robots.txt", "User-agent: *\nDisallow: /");
    const id = e.addSource();
    await e.scanner.scanSource(id);
    expect(e.store.getSource(id)!.lastError).toBe("Geblokkeerd door robots.txt");
    expect(e.store.listLog(20).some((l) => l.message === "Scan gestart")).toBe(true);
    expect((await e.scanner.testSource({ url: VVSG_URL, renderMode: "static", maxPages: 1 })).error).toBe("Geblokkeerd door robots.txt");
  });

  it("follows the setting at call time and reports HTTP errors and finished scans in Dutch", async () => {
    const e = mk();
    e.store.saveSettings({ outputLanguage: "nl" });
    const bad = e.addSource({ name: "Bad", url: "https://bad.example/jobs" });
    await e.scanner.scanSource(bad);
    expect(e.store.getSource(bad)!.lastError).toBe("HTTP 500 voor https://bad.example/jobs");
    const ok = e.addSource();
    await e.scanner.scanSource(ok);
    expect(e.store.listLog(50).some((l) => /Scan klaar: \d+ gevonden, \d+ nieuw, \d+ beoordeeld/.test(l.message))).toBe(true);
    e.store.saveSettings({ outputLanguage: "en" });
    await e.scanner.scanSource(ok);
    expect(e.store.listLog(50).some((l) => /Scan finished: \d+ found/.test(l.message))).toBe(true);
  });
});
