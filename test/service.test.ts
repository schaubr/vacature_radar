import { describe, expect, it, vi } from "vitest";
import { translatorFor, type Translator } from "../src/shared/i18n";
import { strToU8, zipSync } from "fflate";
import { Store } from "../src/core/db/store";
import type { LlmClient } from "../src/core/llm/client";
import { PoliteFetcher } from "../src/core/net/fetcher";
import { ScanService } from "../src/core/scan/scanner";
import { Scheduler } from "../src/core/scan/scheduler";
import { seedSources, SEED_SOURCES } from "../src/core/seed";
import { RadarService, type SecretsPort } from "../src/core/service";
import { RADAR_METHODS, type RadarEvents } from "../src/shared/ipc";
import { DEFAULT_PREFERENCES, type SourceInput } from "../src/shared/types";
import { VVSG_RECIPE, VVSG_URL, fixture } from "./helpers";

const srcInput = (over: Partial<SourceInput> = {}): SourceInput => ({
  name: "VVSG", url: VVSG_URL, enabled: true, renderMode: "static", scanIntervalHours: null, maxPages: 1, notes: "", ...over,
});

function setup(opts: { t?: Translator; key?: string | null; secureStorage?: boolean; file?: { path: string; data: Uint8Array } | null; llm?: LlmClient | null; orsKey?: string | null; reentry?: boolean } = {}) {
  const store = new Store(":memory:");
  let key: string | null = opts.key === undefined ? null : opts.key;
  const secrets: SecretsPort = {
    get: () => key,
    set: (k) => { key = k; },
    clear: () => { key = null; },
    available: () => opts.secureStorage !== false,
    needsReentry: () => opts.reentry === true,
  };
  let orsKey: string | null = opts.orsKey ?? null;
  const orsSecrets: SecretsPort = {
    get: () => orsKey,
    set: (k) => { orsKey = k; },
    clear: () => { orsKey = null; },
    available: () => opts.secureStorage !== false,
    needsReentry: () => opts.reentry === true,
  };
  const recomputeAll = vi.fn(async () => ({ updated: 2, failed: 1 }));
  const validateOrsKey = vi.fn(async (k: string) => { if (k === "bad") throw new Error("Invalid OpenRouteService API key"); });
  const events: { name: string; payload: unknown }[] = [];
  const emit = <E extends keyof RadarEvents>(name: E, payload: RadarEvents[E]) => void events.push({ name, payload });
  const raw = async (url: string) => {
    if (url.endsWith("/robots.txt")) return { status: 404, url, contentType: "text/plain", body: "" };
    return { status: 200, url, contentType: "text/html", body: url === VVSG_URL ? fixture("vvsg_list.html") : fixture("vvsg_detail.html") };
  };
  const fetcher = new PoliteFetcher(raw, { minIntervalMs: 0, sleep: async () => {} });
  const now = () => new Date("2026-11-08T12:00:00Z");
  const llm = opts.llm === undefined ? null : opts.llm;
  const scanner = new ScanService({ store, fetcher, renderer: null, llm, notifier: { notify: () => {} }, now, emit, llmConfigured: () => key !== null });
  const scheduler = new Scheduler({ store, scanner, now });
  const opened: string[] = [];
  const onSettingsChanged = vi.fn();
  const validateKey = vi.fn(async (k: string) => { if (k === "bad") throw new Error("Invalid API key"); });
  const service = new RadarService({
    store, scanner, scheduler, llm, secrets, now, emit, onSettingsChanged, validateKey, orsSecrets, validateOrsKey, travel: { recomputeAll },
    shell: { openExternal: (u) => opened.push(u), pickImportFile: async () => opts.file ?? null },
    t: opts.t,
  });
  const names = () => events.map((e) => e.name);
  return { store, service, events, names, opened, onSettingsChanged, validateKey, getKey: () => key, getOrsKey: () => orsKey, recomputeAll, validateOrsKey };
}

describe("RadarService", () => {
  it("implements every RadarApi method", () => {
    const { service } = setup();
    for (const m of RADAR_METHODS) expect(typeof service[m], m).toBe("function");
  });

  it("seeds only into an empty sources table", () => {
    const { store } = setup();
    expect(seedSources(store)).toBe(SEED_SOURCES.length);
    expect(seedSources(store)).toBe(0);
    const list = store.listSources();
    expect(list).toHaveLength(8);
    expect(list.find((s) => s.name === "Fiola vzw")).toMatchObject({ url: "https://fiolavzw.be/vacatures/", enabled: true, renderMode: "static", strategy: "recipe" });
    expect(list.at(-1)).toMatchObject({ name: "Socius (sociaal-cultureel werk)", url: "https://socius.be/vacature/", enabled: true, renderMode: "static", strategy: "recipe", maxPages: 3 });
    expect(list.filter((s) => s.enabled).map((s) => s.renderMode)).toEqual(["browser", "browser", "static", "static", "static", "static"]);
    const withRecipe = list.filter((s) => s.recipe);
    expect(withRecipe.map((s) => s.strategy)).toEqual(["recipe", "recipe", "recipe", "recipe", "recipe", "recipe"]);
    expect(list.filter((s) => !s.enabled).every((s) => s.recipe === null)).toBe(true);
    expect(list.filter((s) => !s.enabled).every((s) => /Use Test before enabling/.test(s.notes))).toBe(true);
    const zn = list.find((s) => s.name === "Zorgnet-Icuro")!;
    expect(zn.renderMode).toBe("browser");
    expect(zn.notes).toMatch(/embedded Jobat widget/);
    expect(list.filter((s) => !s.enabled && s !== zn).every((s) => s.renderMode === "auto")).toBe(true);
  });

  describe("seed revisions", () => {
    const fiola = (store: Store) => store.listSources().find((s) => s.url === "https://fiolavzw.be/vacatures/");
    /** An install made before revision 2: the six original seeds, no stored revision. */
    const legacy = () => {
      const { store } = setup();
      for (const s of SEED_SOURCES.filter((x) => x.since === 1)) {
        const { since: _since, ...input } = s;
        store.createSource(input);
      }
      return store;
    };

    const socius = (store: Store) => store.listSources().find((s) => s.url === "https://socius.be/vacature/");

    it("a fresh install gets all 8 seeds including Fiola and Socius and stores the revision", () => {
      const { store } = setup();
      expect(seedSources(store)).toBe(8);
      expect(fiola(store)).toBeTruthy();
      expect(socius(store)).toBeTruthy();
      expect(store.getMeta("seedRevision")).toBe(3);
    });

    it("a revision 2 install gains only Socius", () => {
      const store = legacy();
      const { since: _s, ...fi } = SEED_SOURCES.find((x) => x.since === 2)!;
      store.createSource(fi);
      store.setMeta("seedRevision", 2);
      expect(seedSources(store)).toBe(1);
      expect(store.listSources()).toHaveLength(8);
      expect(socius(store)).toMatchObject({ enabled: true, renderMode: "static", strategy: "recipe", maxPages: 3 });
      expect(store.getMeta("seedRevision")).toBe(3);
      expect(seedSources(store)).toBe(0);
    });

    it("a deleted Socius is not re-added", () => {
      const { store } = setup();
      seedSources(store);
      store.deleteSource(socius(store)!.id);
      expect(seedSources(store)).toBe(0);
      expect(socius(store)).toBeUndefined();
      expect(store.listSources()).toHaveLength(7);
    });

    it("an existing install without a revision gains Fiola and Socius", () => {
      const store = legacy();
      expect(store.getMeta("seedRevision")).toBeNull();
      expect(seedSources(store)).toBe(2);
      expect(store.listSources()).toHaveLength(8);
      expect(fiola(store)).toMatchObject({ enabled: true, renderMode: "static", strategy: "recipe" });
      expect(seedSources(store)).toBe(0);
    });

    it("a deleted Fiola is not re-added, and restarts are idempotent", () => {
      const store = legacy();
      seedSources(store);
      store.deleteSource(fiola(store)!.id);
      expect(seedSources(store)).toBe(0);
      expect(seedSources(store)).toBe(0);
      expect(fiola(store)).toBeUndefined();
      expect(store.listSources()).toHaveLength(7);
    });

    it("does not duplicate a seed whose URL the owner already added (canonical compare)", () => {
      const store = legacy();
      store.createSource(srcInput({ name: "My Fiola", url: "https://FIOLAVZW.be/vacatures?utm_source=x" }));
      expect(seedSources(store)).toBe(1); // only Socius
      expect(store.listSources()).toHaveLength(8);
    });
  });

  it("sources CRUD emits events; update resets learned state; delete removes vacancies", async () => {
    const { service, names, store } = setup();
    const s = service["sources.create"](srcInput());
    expect(names()).toContain("sources.changed");
    expect(service["sources.list"]()).toHaveLength(1);
    store.updateSourceRuntime(s.id, { recipe: VVSG_RECIPE, strategy: "recipe", detectedMode: "static", lastPageHash: "h" });
    expect(service["sources.update"](s.id, { name: "Renamed" }).recipe).not.toBeNull();
    const moved = service["sources.update"](s.id, { url: "https://www.vvsg.be/elders" });
    expect(moved.recipe).toBeNull();
    expect(moved.detectedMode).toBeNull();
    store.updateSourceRuntime(s.id, { recipe: VVSG_RECIPE, strategy: "recipe", lastPageHash: "h" });
    const reset = service["sources.resetRecipe"](s.id);
    expect(reset).toMatchObject({ recipe: null, strategy: null, lastPageHash: null });
    expect(() => service["sources.update"](999, { name: "x" })).toThrow(/not found/);

    const s2 = service["sources.create"](srcInput({ url: VVSG_URL }));
    store.updateSourceRuntime(s2.id, { recipe: VVSG_RECIPE });
    await service["scan.now"](s2.id);
    await vi.waitFor(() => expect(store.getSource(s2.id)!.lastStatus).toBe("ok"));
    expect(service["vacancies.list"]({ statuses: [], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" }).length).toBeGreaterThan(0);
    service["sources.delete"](s2.id);
    expect(service["vacancies.list"]({ statuses: [], minScore: null, sourceId: s2.id, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" })).toHaveLength(0);
    expect(store.getVacancyByUrl("https://www.vvsg.be/vacatures/overzicht-vacatures/lennik-expert-financien")).toBeNull();
  });

  it("scan.now(null) scans enabled sources and emits app.status; sources.test works", async () => {
    const { service, store, names } = setup();
    const a = service["sources.create"](srcInput());
    service["sources.create"](srcInput({ name: "off", enabled: false }));
    store.updateSourceRuntime(a.id, { recipe: VVSG_RECIPE });
    service["scan.now"](null);
    await vi.waitFor(() => expect(store.getSource(a.id)!.lastStatus).toBe("ok"));
    await vi.waitFor(() => expect(service["app.status"]().scanning).toBe(false));
    expect(names()).toContain("app.status");
    expect(store.listSources().find((s) => s.name === "off")!.lastStatus).toBe("never");
    // Same URL as an existing source: its saved recipe is used.
    const known = await service["sources.test"]({ url: VVSG_URL, renderMode: "static", maxPages: 1, sourceId: a.id });
    expect(known).toMatchObject({ ok: true, strategy: "recipe" });
    expect(known.items).toHaveLength(5);
    const t = await service["sources.test"]({ url: VVSG_URL + "?x=1", renderMode: "static", maxPages: 1 });
    expect(t).toMatchObject({ ok: false, items: [], robotsAllowed: true });
    expect(t.error).toMatch(/No vacancies/); // no recipe, no key: only non-LLM tiers ran
  });

  it("vacancies: get marks seen, status, feedback, counts, openExternal, rescore errors", async () => {
    const { service, store, opened, names } = setup();
    const s = service["sources.create"](srcInput());
    store.updateSourceRuntime(s.id, { recipe: VVSG_RECIPE });
    await service["scan.now"](s.id);
    await vi.waitFor(() => expect(store.getSource(s.id)!.lastStatus).toBe("ok"));
    const list = service["vacancies.list"]({ statuses: [], minScore: null, sourceId: null, search: "", includeUnscored: true, maxTravelMinutes: null, sort: "date" });
    expect(service["vacancies.counts"]().new).toBe(list.length);
    const d = service["vacancies.get"](list[0].id)!;
    expect(d.status).toBe("seen");
    expect(service["vacancies.counts"]().new).toBe(list.length - 1);
    service["vacancies.setStatus"](list[0].id, "interested");
    service["vacancies.setFeedback"](list[0].id, "up", "nice");
    const d2 = service["vacancies.get"](list[0].id)!;
    expect(d2).toMatchObject({ status: "interested", feedback: "up", feedbackNote: "nice" });
    expect(service["vacancies.get"](99999)).toBeNull();
    service["vacancies.openExternal"](list[0].id);
    expect(opened).toEqual([d2.url]);
    await expect(service["vacancies.rescore"](list[0].id)).rejects.toThrow(/API key/);
    expect(names()).toContain("vacancies.changed");
  });

  it("profile save/import (zip) preserves preferences and emits app.status", async () => {
    const zip = zipSync({ "Profile.csv": strToU8("First Name,Headline\nJane,Social worker\n") });
    const { service, events, store } = setup({ file: { path: "/x/Basic_LinkedInDataExport.zip", data: zip } });
    expect(service["app.status"]().profileReady).toBe(false);
    const prefs = { ...DEFAULT_PREFERENCES, homeLocation: "Gent" };
    const saved = service["profile.save"]({ markdown: "hello", preferences: prefs });
    expect(saved).toMatchObject({ version: 1, importedFrom: "manual" });
    expect(events.at(-1)).toMatchObject({ name: "app.status", payload: { profileReady: true } });
    const imported = (await service["profile.import"]())!;
    expect(imported.markdown).toContain("Headline: Social worker");
    expect(imported.importedFrom).toBe("linkedin_zip");
    expect(imported.preferences.homeLocation).toBe("Gent");
    expect(imported.version).toBe(2);
    expect(store.getProfile().version).toBe(2);
  });

  it("profile.import: cancel -> null, pdf needs a key, other types are rejected, pdf works with key", async () => {
    expect(await setup()["service"]["profile.import"]()).toBeNull();

    const pdf = { path: "/x/Profile.PDF", data: new Uint8Array([1, 2, 3]) };
    const noKey = setup({ file: pdf });
    await expect(noKey.service["profile.import"]()).rejects.toThrow(/API key/);

    const llm: LlmClient = {
      structured: async () => { throw new Error("unused"); },
      text: async () => ({ text: "# Jane\nSocial worker", usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }),
    };
    const withKey = setup({ file: pdf, key: "sk-ant-xxx", llm });
    const p = (await withKey.service["profile.import"]())!;
    expect(p).toMatchObject({ markdown: "# Jane\nSocial worker", importedFrom: "linkedin_pdf" });

    const txt = setup({ file: { path: "/x/a.txt", data: new Uint8Array() } });
    await expect(txt.service["profile.import"]()).rejects.toThrow(/Unsupported/);
  });

  it("settings.save returns merged settings, calls onSettingsChanged and emits app.status", () => {
    const { service, onSettingsChanged, events } = setup();
    const s = service["settings.save"]({ monthlyBudgetUsd: 9, launchAtLogin: false });
    expect(s.monthlyBudgetUsd).toBe(9);
    expect(s.notifyThreshold).toBe(70);
    expect(service["settings.get"]()).toEqual(s);
    expect(onSettingsChanged).toHaveBeenCalledWith(s, { monthlyBudgetUsd: 9, launchAtLogin: false });
    expect(events.at(-1)!.name).toBe("app.status");
  });

  it("apiKey/orsKey status expose needsReentry only when a stored key could not be decrypted", () => {
    expect(setup().service["apiKey.status"]()).toEqual({ configured: false, masked: null });
    expect(setup().service["orsKey.status"]()).toEqual({ configured: false, masked: null });
    const t = setup({ reentry: true });
    expect(t.service["apiKey.status"]()).toEqual({ configured: false, masked: null, needsReentry: true });
    expect(t.service["orsKey.status"]()).toEqual({ configured: false, masked: null, needsReentry: true });
    // a readable key never reports it
    expect(setup({ reentry: true, key: "sk-ant-api03-abcdefghijklmnop" }).service["apiKey.status"]().needsReentry).toBeUndefined();
  });

  it("apiKey set/status/clear with validation and secure storage failure", async () => {
    const t = setup();
    expect(t.service["apiKey.status"]()).toEqual({ configured: false, masked: null });
    expect(await t.service["apiKey.set"]("   ")).toMatchObject({ ok: false });
    expect(await t.service["apiKey.set"]("bad")).toEqual({ ok: false, error: "Invalid API key" });
    expect(t.getKey()).toBeNull();
    expect(await t.service["apiKey.set"]("sk-ant-api03-abcdefghijklmnop")).toEqual({ ok: true, error: null });
    const st = t.service["apiKey.status"]();
    expect(st.configured).toBe(true);
    expect(st.masked).toBe("sk-ant-…mnop");
    expect(st.masked).not.toContain("abcdefgh");
    expect(t.events.at(-1)).toMatchObject({ name: "app.status", payload: { apiKeyConfigured: true } });
    t.service["apiKey.clear"]();
    expect(t.service["apiKey.status"]().configured).toBe(false);
    expect(t.events.at(-1)).toMatchObject({ payload: { apiKeyConfigured: false } });

    const noSec = setup({ secureStorage: false });
    expect(await noSec.service["apiKey.set"]("sk-ant-api03-abcdefghijklmnop")).toEqual({
      ok: false,
      error: "Secure storage is not available on this system",
    });
    expect(noSec.validateKey).not.toHaveBeenCalled();
    // the rest of the service keeps working
    expect(noSec.service["settings.get"]().scanIntervalHours).toBe(6);
  });

  it("triggers scoring of pending vacancies after key, profile and budget changes", async () => {
    const t = setup();
    const spy = vi.spyOn((t.service as unknown as { d: { scanner: { scorePending: () => Promise<void> } } }).d.scanner, "scorePending");
    await t.service["apiKey.set"]("sk-ant-api03-abcdefghijklmnop");
    expect(spy).toHaveBeenCalledTimes(1);
    await t.service["apiKey.set"]("bad");
    expect(spy).toHaveBeenCalledTimes(1);
    t.service["profile.save"]({ markdown: "", preferences: DEFAULT_PREFERENCES });
    expect(spy).toHaveBeenCalledTimes(1);
    t.service["profile.save"]({ markdown: "text", preferences: DEFAULT_PREFERENCES });
    expect(spy).toHaveBeenCalledTimes(2);
    t.service["settings.save"]({ monthlyBudgetUsd: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    t.service["settings.save"]({ monthlyBudgetUsd: 20 });
    expect(spy).toHaveBeenCalledTimes(3);
    t.service["settings.save"]({ notifyThreshold: 80 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("usage.summary, log.list and app.status", () => {
    const { service, store } = setup();
    store.recordUsage({ model: "m", purpose: "score", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 6, at: "2026-11-03T00:00:00.000Z" });
    store.log("info", "hello");
    expect(service["usage.summary"]()).toMatchObject({ monthUsd: 6, budgetUsd: 5, budgetExceeded: true });
    expect(service["log.list"](10)[0].message).toBe("hello");
    expect(service["app.status"]()).toMatchObject({ scanning: false, budgetExceeded: true, apiKeyConfigured: false, profileReady: false, nextScanAt: null });
    service["sources.create"](srcInput());
    expect(service["app.status"]().nextScanAt).toBe("2026-11-08T12:00:00.000Z");
  });

  it("emits app.status when the scanner status changes", async () => {
    const { service, store, events } = setup();
    const s = service["sources.create"](srcInput());
    store.updateSourceRuntime(s.id, { recipe: VVSG_RECIPE });
    events.length = 0;
    service["scan.now"](s.id);
    await vi.waitFor(() => expect(store.getSource(s.id)!.lastStatus).toBe("ok"));
    await vi.waitFor(() => expect((events.filter((e) => e.name === "app.status").at(-1)!.payload as { scanning: boolean }).scanning).toBe(false));
    const statuses = events.filter((e) => e.name === "app.status").map((e) => e.payload as { scanning: boolean; currentSourceId: number | null });
    expect(statuses.some((x) => x.scanning && x.currentSourceId === s.id)).toBe(true);
  });

  describe("travel", () => {
    it("orsKey.status/set/clear mirror the Anthropic key handling, validate first and recompute after saving", async () => {
      const { service, getOrsKey, validateOrsKey, recomputeAll, events } = setup();
      expect(service["orsKey.status"]()).toEqual({ configured: false, masked: null });
      expect(await service["orsKey.set"]("   ")).toEqual({ ok: false, error: "Enter an API key" });
      expect(await service["orsKey.set"]("bad")).toEqual({ ok: false, error: "Invalid OpenRouteService API key" });
      expect(getOrsKey()).toBeNull();
      expect(recomputeAll).not.toHaveBeenCalled();
      expect(await service["orsKey.set"](" 5b3ce3597851110001cf6248abcdef1234567890 ")).toEqual({ ok: true, error: null });
      expect(validateOrsKey).toHaveBeenLastCalledWith("5b3ce3597851110001cf6248abcdef1234567890");
      expect(getOrsKey()).toBe("5b3ce3597851110001cf6248abcdef1234567890");
      expect(service["orsKey.status"]()).toMatchObject({ configured: true, masked: expect.stringContaining("…") });
      expect(service["orsKey.status"]().masked).not.toContain("abcdef12345678");
      await vi.waitFor(() => expect(recomputeAll).toHaveBeenCalledTimes(1));
      expect(events.some((e) => e.name === "vacancies.changed")).toBe(true);
      service["orsKey.clear"]();
      expect(service["orsKey.status"]().configured).toBe(false);
    });

    it("orsKey.set reports unavailable secure storage", async () => {
      const { service } = setup({ secureStorage: false });
      expect((await service["orsKey.set"]("abc")).error).toMatch(/Secure storage/);
    });

    it("travel.recompute awaits the recompute and returns its counts", async () => {
      const { service, recomputeAll } = setup();
      expect(await service["travel.recompute"]()).toEqual({ updated: 2, failed: 1 });
      expect(recomputeAll).toHaveBeenCalledTimes(1);
    });

    it("profile.save recomputes only when the home location changed", async () => {
      const { service, recomputeAll } = setup();
      const prefs = { ...DEFAULT_PREFERENCES, homeLocation: "Gent" };
      service["profile.save"]({ markdown: "", preferences: prefs });
      await vi.waitFor(() => expect(recomputeAll).toHaveBeenCalledTimes(1));
      service["profile.save"]({ markdown: "more", preferences: { ...prefs, maxCommute: "40 km" } });
      service["profile.save"]({ markdown: "more", preferences: { ...prefs, homeLocation: " Gent " } });
      await new Promise((r) => setTimeout(r, 20));
      expect(recomputeAll).toHaveBeenCalledTimes(1);
      service["profile.save"]({ markdown: "more", preferences: { ...prefs, homeLocation: "Aalst" } });
      await vi.waitFor(() => expect(recomputeAll).toHaveBeenCalledTimes(2));
    });

    it("app.status.travelConfigured needs the ORS key and a resolved home", () => {
      const a = setup({ orsKey: "k" });
      expect(a.service["app.status"]().travelConfigured).toBe(false);
      a.store.setHomeGeo({ query: "gent", label: "Gent", lat: 51, lon: 3 });
      expect(a.service["app.status"]().travelConfigured).toBe(true);
      a.service["orsKey.clear"]();
      expect(a.service["app.status"]().travelConfigured).toBe(false);
      const b = setup();
      b.store.setHomeGeo({ query: "gent", label: "Gent", lat: 51, lon: 3 });
      expect(b.service["app.status"]().travelConfigured).toBe(false);
    });
  });
});

describe("RadarService in Dutch", () => {
  const t = translatorFor(() => "nl");
  it("translates validation and import errors", async () => {
    const { service } = setup({ t, secureStorage: false });
    expect(await service["apiKey.set"]("   ")).toEqual({ ok: false, error: "Geef een API-sleutel in" });
    expect(await service["apiKey.set"]("sk-x")).toEqual({ ok: false, error: "Veilige opslag is niet beschikbaar op dit systeem" });
    expect(() => service["sources.update"](9999, {})).toThrow("Bron niet gevonden");
    const pdf = setup({ t, file: { path: "/x/cv.docx", data: new Uint8Array() } });
    await expect(pdf.service["profile.import"]()).rejects.toThrow(/Niet-ondersteund bestandstype/);
  });
});
