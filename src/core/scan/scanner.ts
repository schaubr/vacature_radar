import type { RadarEvents } from "../../shared/ipc";
import type { PageDiagnostics, RenderMode, Settings, Source, SourceTestResult, ExtractStrategy, ListingItem, Recipe } from "../../shared/types";
import type { Store, VacancyRow } from "../db/store";
import type { PoliteFetcher } from "../net/fetcher";
import { diagnosePage } from "../extract/diagnose";
import type { PageRenderer } from "../net/render";
import type { Notifier } from "../notify";
import { tEn, type Translator } from "../../shared/i18n";
import { BudgetExceededError, LlmNotConfiguredError, type LlmClient, type LlmUsage } from "../llm/client";
import { llmExtractListing } from "../llm/extract-llm";
import { learnRecipe } from "../llm/recipe-learn";
import { scoreVacancy, type ScoringTravel } from "../llm/score";
import { extractDetail } from "../extract/detail";
import { cleanHtmlForLlm, looksJsRendered, sha256 } from "../extract/html";
import { extractListing } from "../extract/listing";
import { applyRecipe, findNextPage, recipeLooksHealthy } from "../extract/recipe";
import { dedupeKey } from "../match/dedupe";
import { prefilter } from "../match/prefilter";

export interface ScanDeps {
  store: Store;
  fetcher: PoliteFetcher;
  renderer: PageRenderer | null; // null in contexts without a browser
  llm: LlmClient | null;
  notifier: Notifier;
  now: () => Date;
  emit: <E extends keyof RadarEvents>(event: E, payload: RadarEvents[E]) => void;
  /**
   * Whether the LLM can actually be used right now (API key present). Defaults to `llm !== null`.
   * Extra optional dep: main passes a function that checks the secret store.
   */
  llmConfigured?: () => boolean;
  /** Travel-time computation (optional; absent in contexts without routing). */
  travel?: { computeFor(ids?: number[]): Promise<unknown> };
  /** Translator for log lines, stored errors and notifications, resolved at call time (default English). */
  t?: Translator;
}

type Mode = "static" | "browser";

interface PageLoad {
  html: string;
  contentType: string;
  url: string;
  /** Child frames seen by the browser renderer (browser mode only). */
  frames?: { url: string; included: boolean }[];
}

interface ExtractOutcome {
  items: ListingItem[];
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
  modeUsed: Mode;
  pageHash: string;
  /** The LLM tiers were skipped because the page is unchanged since the last LLM extraction. */
  guardSkipped: boolean;
  /** The mode "auto" resolved to, if any. */
  detectedMode: Mode | null;
  /** The (first) page the items were extracted from. */
  page: PageLoad;
  /** LLM tiers were available and attempted (not skipped by the unchanged-page guard). */
  llmUsed: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ScanService {
  private queue: number[] = [];
  private current: number | null = null;
  private running: Promise<void> | null = null;
  private scoring: Promise<void> | null = null;
  private statusListener: (() => void) | null = null;

  constructor(private readonly deps: ScanDeps) {}

  private get t(): Translator {
    return this.deps.t ?? tEn;
  }

  /** Registers a callback invoked whenever `status` may have changed. */
  setStatusListener(fn: (() => void) | null): void {
    this.statusListener = fn;
  }

  get status(): { scanning: boolean; currentSourceId: number | null; queueLength: number } {
    return {
      scanning: this.running !== null || this.current !== null,
      currentSourceId: this.current,
      queueLength: this.queue.length,
    };
  }

  private changed(): void {
    try {
      this.statusListener?.();
    } catch {
      /* listener errors must not break scanning */
    }
  }

  // ---------- queue ----------

  /** Serial scan queue. If a run is active, the new ids are merged into it and the active run's promise is returned. */
  scanMany(sourceIds: number[]): Promise<void> {
    for (const id of sourceIds) {
      if (id !== this.current && !this.queue.includes(id)) this.queue.push(id);
    }
    if (this.running) {
      this.changed();
      return this.running;
    }
    if (this.queue.length === 0) return Promise.resolve();
    this.running = this.drain();
    this.changed();
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      // A standalone scoring run must not overlap with a scan queue.
      if (this.scoring) await this.scoring.catch(() => undefined);
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        await this.scanSource(id);
      }
    } finally {
      this.current = null;
      this.running = null;
      this.changed();
    }
  }

  // ---------- helpers ----------

  private log(level: "info" | "warn" | "error", message: string, sourceId: number | null = null): void {
    try {
      this.deps.store.log(level, message, sourceId);
    } catch {
      /* store closed or source gone */
    }
  }

  private budgetExceeded(settings: Settings): boolean {
    return this.deps.store.monthUsageUsd(this.deps.now()) >= settings.monthlyBudgetUsd;
  }

  /** Why a scan with 0 items found nothing, mentioning a missing key or exhausted budget when that is the likely cause. */
  private noItemsMessage(settings: Settings): string {
    const { llm, llmConfigured } = this.deps;
    if (!llm || (llmConfigured && !llmConfigured())) {
      return this.t("scan.noItems.noKey");
    }
    if (this.budgetExceeded(settings)) {
      return this.t("scan.noItems.budget");
    }
    return this.t("scan.noItems.plain");
  }

  private llmUsable(settings: Settings): LlmClient | null {
    const { llm, llmConfigured } = this.deps;
    if (!llm) return null;
    if (llmConfigured && !llmConfigured()) return null;
    if (this.budgetExceeded(settings)) return null;
    return llm;
  }

  private async loadPage(url: string, mode: Mode): Promise<PageLoad> {
    if (mode === "browser") {
      if (!this.deps.renderer) throw new Error(this.t("scan.noBrowser"));
      await this.deps.fetcher.throttle(url);
      const r = await this.deps.renderer.render(url);
      return { html: r.html, contentType: "text/html", url: r.url || url, frames: r.frames };
    }
    const r = await this.deps.fetcher.fetch(url);
    return { html: r.body, contentType: r.contentType, url: r.url || url };
  }

  /** Mode + extraction shared by scanSource and testSource (steps 3-5). */
  private async fetchAndExtract(args: {
    url: string;
    renderMode: RenderMode;
    detectedMode: Mode | null;
    maxPages: number;
    existingRecipe: Recipe | null;
    lastStrategy: ExtractStrategy | null;
    lastPageHash: string | null;
    settings: Settings;
    llm: LlmClient | null;
  }): Promise<ExtractOutcome> {
    const { url, settings, llm } = args;
    let detectedMode: Mode | null = null;
    let mode: Mode;
    let auto = false;
    if (args.renderMode === "static") mode = "static";
    else if (args.renderMode === "browser") mode = "browser";
    else if (args.detectedMode) mode = args.detectedMode;
    else {
      auto = true;
      mode = "static";
    }

    let page = await this.loadPage(url, mode);
    if (auto && this.deps.renderer && looksJsRendered(page.html)) {
      mode = "browser";
      page = await this.loadPage(url, mode);
      detectedMode = "browser";
    }

    const run = async (p: PageLoad) => {
      const pageHash = sha256(cleanHtmlForLlm(p.html));
      let guardSkipped = false;
      let useLlm = llm;
      if (useLlm) {
        const healthy =
          args.existingRecipe !== null && recipeLooksHealthy(applyRecipe(p.html, p.url, args.existingRecipe));
        if (!healthy && pageHash === args.lastPageHash && args.lastStrategy === "llm") {
          useLlm = null;
          guardSkipped = true;
        }
      }
      const res = await extractListing({
        url: p.url,
        html: p.html,
        contentType: p.contentType,
        existingRecipe: args.existingRecipe,
        learnRecipe: useLlm ? (cleaned, u) => learnRecipe(useLlm!, settings, cleaned, u, p.html) : undefined,
        llmExtract: useLlm ? (compact, u) => llmExtractListing(useLlm!, settings, compact, u) : undefined,
      });
      return { ...res, pageHash, guardSkipped };
    };

    let res = await run(page);
    // Auto mode, static page that yielded nothing: the page may be built by JavaScript.
    if (auto && mode === "static" && res.items.length === 0 && !res.guardSkipped && this.deps.renderer) {
      mode = "browser";
      page = await this.loadPage(url, mode);
      detectedMode = "browser";
      res = await run(page);
    } else if (auto && mode === "static" && res.items.length > 0) {
      detectedMode = "static";
    } else if (auto && mode === "browser" && res.items.length > 0) {
      detectedMode = "browser";
    }

    let items = res.items;
    // Pagination: only with a recipe, following the same recipe.
    if (res.strategy === "recipe" && res.recipe && args.maxPages > 1) {
      const seen = new Set(items.map((i) => i.url));
      const visited = new Set([page.url]);
      let cur = page;
      for (let n = 1; n < args.maxPages; n++) {
        const next = findNextPage(cur.html, cur.url, res.recipe);
        if (!next || visited.has(next)) break;
        visited.add(next);
        try {
          cur = await this.loadPage(next, mode);
        } catch (e) {
          this.log("warn", this.t("scan.paginationStopped", { url: next, error: errMsg(e) }));
          break;
        }
        const more = applyRecipe(cur.html, cur.url, res.recipe).filter((i) => !seen.has(i.url));
        if (more.length === 0) break;
        for (const i of more) seen.add(i.url);
        items = items.concat(more);
      }
    }

    return {
      items,
      strategy: res.strategy,
      recipe: res.recipe,
      modeUsed: mode,
      pageHash: res.pageHash,
      guardSkipped: res.guardSkipped,
      detectedMode,
      page,
      llmUsed: llm !== null && !res.guardSkipped,
    };
  }

  /** Diagnostics for a loaded page, plus the message to show when it yielded no vacancies. */
  private diagnose(out: ExtractOutcome, llmAvailable: boolean, settings: Settings): { diagnostics: PageDiagnostics; message: string } {
    const diagnostics = diagnosePage({
      html: out.page.html,
      pageUrl: out.page.url,
      modeUsed: out.modeUsed,
      frames: out.page.frames ?? [],
      llmUsed: out.llmUsed,
      itemCount: out.items.length,
      itemUrls: out.items.map((i) => i.url),
      llmAvailable,
      t: this.t,
    });
    // The generic no-key hint is replaced by the existing no-key/budget messages (which know about the budget).
    const message = diagnostics.hint === null || diagnostics.hint === this.t("diag.noKey") ? this.noItemsMessage(settings) : diagnostics.hint;
    if (out.items.length === 0 && diagnostics.hint !== null) diagnostics.hint = message;
    return { diagnostics, message };
  }

  // ---------- scanning ----------

  async scanSource(sourceId: number): Promise<void> {
    const { store } = this.deps;
    let source: Source | null;
    try {
      source = store.getSource(sourceId);
    } catch {
      return;
    }
    if (!source) return;
    this.current = sourceId;
    this.changed();
    try {
      await this.doScan(source);
    } catch (e) {
      // doScan handles its own errors; this is the last line of defence for the queue.
      this.log("error", this.t("scan.crashed", { error: errMsg(e) }), sourceId);
    }
    try {
      const closed = this.deps.store.closeExpired(this.deps.now().toISOString().slice(0, 10));
      if (closed.length > 0) {
        this.log("info", this.t("scan.pastDeadline", { count: closed.length }), sourceId);
        this.deps.emit("vacancies.changed", { newIds: [] });
      }
    } catch {
      /* store closed */
    } finally {
      this.current = null;
      this.changed();
    }
  }

  private async doScan(source: Source): Promise<void> {
    const { store, fetcher } = this.deps;
    const sourceId = source.id;
    const now = this.deps.now();
    const nowIso = now.toISOString();
    this.log("info", this.t("scan.started"), sourceId);

    const fail = (message: string, status: "error" | "empty" = "error"): void => {
      try {
        store.updateSourceRuntime(sourceId, {
          lastScanAt: nowIso,
          lastStatus: status,
          lastError: message,
          consecutiveFailures: source.consecutiveFailures + 1,
        });
      } catch {
        /* source deleted */
      }
      this.log(status === "error" ? "error" : "warn", message, sourceId);
      this.deps.emit("sources.changed", {});
    };

    const settings = store.getSettings();
    let mode: Mode = source.renderMode === "browser" ? "browser" : "static";
    let outcome: ExtractOutcome;
    try {
      // 2. robots
      if (!(await fetcher.isAllowed(source.url))) {
        fail(this.t("scan.blockedRobots"));
        return;
      }
      // 3-5. load + extract
      outcome = await this.fetchAndExtract({
        url: source.url,
        renderMode: source.renderMode,
        detectedMode: source.detectedMode,
        maxPages: source.maxPages,
        existingRecipe: source.recipe,
        lastStrategy: source.strategy,
        lastPageHash: source.lastPageHash,
        settings,
        llm: this.llmUsable(settings),
      });
      mode = outcome.modeUsed;
    } catch (e) {
      fail(errMsg(e));
      return;
    }

    // 6. nothing found
    if (outcome.items.length === 0) {
      if (outcome.guardSkipped) {
        // Unchanged page whose items were found by the LLM before: do not pay again, do not count as failure.
        store.updateSourceRuntime(sourceId, {
          lastScanAt: nowIso,
          lastStatus: "ok",
          lastError: null,
          detectedMode: outcome.detectedMode ?? source.detectedMode,
        });
        this.log("info", this.t("scan.pageUnchanged"), sourceId);
        this.deps.emit("sources.changed", {});
        return;
      }
      fail(this.diagnose(outcome, this.llmUsable(settings) !== null, settings).message, "empty");
      return;
    }

    let found = 0;
    let newIds: number[] = [];
    try {
      // 7. upsert
      const seenIds: number[] = [];
      const fresh: VacancyRow[] = [];
      for (const item of outcome.items) {
        const existing = store.getVacancyByUrl(item.url);
        if (existing) {
          store.touchVacancySeen(existing.id, nowIso);
          seenIds.push(existing.id);
          continue;
        }
        const row = store.insertVacancy({
          ...item,
          sourceId,
          dedupeKey: dedupeKey(item.title, item.organization),
          now: nowIso,
        });
        seenIds.push(row.id);
        const dup = store.findDuplicateCandidate(row, now);
        if (dup) store.setDuplicateOf(row.id, dup.id);
        else fresh.push(row);
      }
      found = outcome.items.length;
      newIds = fresh.map((r) => r.id);

      // 8. missed / closing (only reached after a successful extraction)
      const closed = store.markMissed(sourceId, seenIds, settings.closeAfterMissedScans, now);
      if (closed.length > 0) this.log("info", this.t("scan.noLongerListed", { count: closed.length }), sourceId);

      // 9. prefilter + detail
      const prefs = store.getProfile().preferences;
      // DESIGN-DEVIATION: the per-scan cap counts only vacancies that pass the prefilter (those that cost a detail
      // fetch and a scoring call); prefiltered-out ones are free and must not starve the cap.
      let budgeted = 0;
      for (const row of fresh) {
        const pf = prefilter({ title: row.title, snippet: row.snippet }, prefs, this.t);
        if (!pf.pass) {
          store.setScoreState(row.id, "filtered", { prefilterReason: pf.reason });
          continue;
        }
        if (budgeted >= settings.maxNewScoredPerScan) {
          store.setScoreState(row.id, "skipped");
          continue;
        }
        budgeted++;
        await this.fetchDetail(row, mode);
      }
      await this.computeTravel(fresh.map((r) => r.id));

      // 10. source runtime
      store.updateSourceRuntime(sourceId, {
        lastScanAt: nowIso,
        lastSuccessAt: nowIso,
        lastStatus: "ok",
        lastError: null,
        lastFound: found,
        strategy: outcome.strategy,
        recipe: outcome.recipe,
        lastPageHash: outcome.pageHash,
        consecutiveFailures: 0,
        detectedMode: outcome.detectedMode ?? source.detectedMode,
      });
    } catch (e) {
      fail(errMsg(e));
      return;
    }
    this.deps.emit("vacancies.changed", { newIds });
    this.deps.emit("sources.changed", {});

    // 11-12. scoring queue + notifications (errors here must not turn the scan into a failure)
    let scored = 0;
    try {
      await this.computeTravel();
      const scoredIds = await this.runScoringQueue(settings, sourceId);
      scored = scoredIds.length;
      this.notifyScored(scoredIds, settings);
      if (scored > 0) this.deps.emit("vacancies.changed", { newIds: [] });
    } catch (e) {
      this.log("error", this.t("scan.scoringFailed", { error: errMsg(e) }), sourceId);
    }

    // Scoring may have improved locations (geo_state reset to pending): resolve them for display.
    await this.computeTravel();

    // 13.
    this.log("info", this.t("scan.finished", { found, fresh: newIds.length, scored }), sourceId);
  }

  /** Geocodes + computes travel; never throws (ORS problems must not fail a scan). */
  private async computeTravel(ids?: number[]): Promise<void> {
    if (!this.deps.travel) return;
    try {
      await this.deps.travel.computeFor(ids);
    } catch (e) {
      this.log("warn", this.t("scan.travelFailed", { error: errMsg(e) }));
    }
  }

  private async fetchDetail(row: VacancyRow, mode: Mode): Promise<void> {
    const { store, fetcher } = this.deps;
    try {
      if (!(await fetcher.isAllowed(row.url))) {
        store.setScoreState(row.id, "error", { error: this.t("scan.blockedRobots") });
        return;
      }
      const page = await this.loadPage(row.url, mode);
      const d = extractDetail(page.html, page.url);
      if (!d.text.trim()) {
        store.setScoreState(row.id, "error", { error: this.t("scan.noDetailText") });
        return;
      }
      store.saveDetail(row.id, d.text, { organization: d.organization, location: d.location, dateText: d.datePosted });
    } catch (e) {
      store.setScoreState(row.id, "error", { error: errMsg(e) });
    }
  }

  // ---------- scoring ----------

  private feedbackHints() {
    return this.deps.store.recentFeedback(10);
  }

  /** Scores pending vacancies serially. Returns ids scored in this run. */
  private async runScoringQueue(settings: Settings, sourceId: number | null, quiet = false): Promise<number[]> {
    const { store, llm } = this.deps;
    const pending = store.pendingScoring(50);
    if (pending.length === 0) return [];
    const profile = store.getProfile();
    let reason: string | null = null;
    if (!llm || (this.deps.llmConfigured && !this.deps.llmConfigured())) reason = this.t("scan.reason.noKey");
    else if (!profile.markdown.trim()) reason = this.t("scan.reason.noProfile");
    else if (this.budgetExceeded(settings)) reason = this.t("scan.reason.budget");
    if (reason) {
      if (!quiet) this.log("warn", this.t("scan.scoringSkipped", { reason, count: pending.length }), sourceId);
      return [];
    }
    const feedback = this.feedbackHints();
    const scored: number[] = [];
    for (const row of pending) {
      try {
        await this.scoreRow(llm!, settings, profile, row, feedback);
        scored.push(row.id);
      } catch (e) {
        if (e instanceof BudgetExceededError || e instanceof LlmNotConfiguredError) {
          this.log("warn", this.t("scan.scoringStopped", { error: e.message }), sourceId);
          break;
        }
        try {
          store.setScoreState(row.id, "error", { error: errMsg(e) });
        } catch {
          /* row gone */
        }
        this.log("error", this.t("scan.scoringItemFailed", { title: row.title, error: errMsg(e) }), sourceId);
      }
    }
    return scored;
  }

  private async scoreRow(
    llm: LlmClient,
    settings: Settings,
    profile: ReturnType<Store["getProfile"]>,
    row: VacancyRow,
    feedback: ReturnType<Store["recentFeedback"]>,
  ): Promise<LlmUsage> {
    const { store } = this.deps;
    const sourceName = store.getSource(row.sourceId)?.name ?? "";
    const fresh = store.getVacancy(row.id) ?? row;
    const travel: ScoringTravel | null =
      fresh.travelMinutes !== null && profile.homeGeo
        ? {
            homeLabel: profile.homeGeo.label,
            travelMinutes: fresh.travelMinutes,
            travelKm: fresh.travelKm,
            geoState: fresh.geoState,
          }
        : null;
    const r = await scoreVacancy(
      llm,
      settings,
      profile,
      {
        title: row.title,
        organization: row.organization,
        location: row.location,
        sourceName,
        url: row.url,
        description: row.description,
      },
      feedback,
      travel,
    );
    store.saveScore(row.id, { fields: r.fields, score: r.score, model: r.usage.model, profileVersion: profile.version });
    store.updateIdentity(row.id, { organization: r.organization, location: r.location });
    return r.usage;
  }

  /**
   * Scores all pending vacancies now (after a key, profile or budget change) instead of waiting for the next scan.
   * Does nothing while a scan queue runs (it scores at its end); concurrent calls share one run.
   */
  scorePending(): Promise<void> {
    if (this.scoring) return this.scoring;
    if (this.running) return Promise.resolve();
    const run = (async () => {
      try {
        const settings = this.deps.store.getSettings();
        await this.computeTravel();
        const ids = await this.runScoringQueue(settings, null, true);
        if (ids.length > 0) {
          this.log("info", this.t("scan.scoredPending", { count: ids.length }));
          this.notifyScored(ids, settings);
          this.deps.emit("vacancies.changed", { newIds: [] });
        }
      } catch (e) {
        this.log("error", this.t("scan.scoringFailed", { error: errMsg(e) }));
      } finally {
        this.scoring = null;
        this.changed();
      }
    })();
    this.scoring = run;
    this.changed();
    return run;
  }

  private notifyScored(ids: number[], settings: Settings): void {
    if (!settings.notificationsEnabled || ids.length === 0) return;
    const { store, notifier } = this.deps;
    const hits = ids
      .map((id) => store.getVacancy(id))
      .filter(
        (v): v is VacancyRow =>
          !!v && v.score !== null && v.score >= settings.notifyThreshold && v.bucket !== "knockout" && v.notifiedAt === null,
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (hits.length === 0) return;
    const nowIso = this.deps.now().toISOString();
    if (hits.length <= 3) {
      for (const v of hits) {
        notifier.notify({
          title: `${v.score} · ${v.title}`,
          body: [v.organization, v.location].filter(Boolean).join(" · "),
          vacancyId: v.id,
        });
      }
    } else {
      notifier.notify({
        title: this.t("notify.strongMany", { count: hits.length }),
        body: hits
          .slice(0, 3)
          .map((v) => v.title)
          .join("\n"),
      });
    }
    for (const v of hits) store.markNotified(v.id, nowIso);
  }

  /** Scores (or re-scores) one vacancy, fetching its detail page first when needed. Throws on failure. */
  async scoreOne(vacancyId: number): Promise<void> {
    const { store, llm } = this.deps;
    const row = store.getVacancy(vacancyId);
    if (!row) throw new Error(this.t("scan.notFound"));
    const settings = store.getSettings();
    if (!llm || (this.deps.llmConfigured && !this.deps.llmConfigured())) {
      throw new Error(this.t("scan.err.noKey"));
    }
    const profile = store.getProfile();
    if (!profile.markdown.trim()) throw new Error(this.t("scan.err.noProfile"));
    if (this.budgetExceeded(settings)) throw new Error(this.t("scan.err.budget"));

    let current = row;
    if (!current.description) {
      const source = store.getSource(current.sourceId);
      const mode: Mode = source?.renderMode === "browser" ? "browser" : source?.renderMode === "auto" ? (source.detectedMode ?? "static") : "static";
      await this.fetchDetail(current, mode);
      current = store.getVacancy(vacancyId)!;
      if (!current.description) throw new Error(current.scoreError ?? this.t("scan.err.noFetchText"));
    }
    await this.computeTravel([vacancyId]);
    current = store.getVacancy(vacancyId) ?? current;
    try {
      await this.scoreRow(llm, settings, profile, current, this.feedbackHints());
    } catch (e) {
      if (!(e instanceof BudgetExceededError || e instanceof LlmNotConfiguredError)) {
        store.setScoreState(vacancyId, "error", { error: errMsg(e) });
      }
      throw e;
    } finally {
      this.deps.emit("vacancies.changed", { newIds: [] });
    }
  }

  // ---------- test ----------

  async testSource(input: { url: string; renderMode: RenderMode; maxPages: number; sourceId?: number }): Promise<SourceTestResult> {
    const { fetcher } = this.deps;
    const settings = this.deps.store.getSettings();
    // Use what an existing source with this URL has learned (its saved recipe and detected mode).
    const byId = input.sourceId !== undefined ? this.deps.store.getSource(input.sourceId) : null;
    const known =
      byId && byId.url === input.url ? byId : (this.deps.store.listSources().find((s) => s.url === input.url) ?? null);
    let cost = 0;
    const base = this.llmUsable(settings);
    const metered: LlmClient | null = base
      ? {
          structured: async (req) => {
            const r = await base.structured(req);
            cost += r.usage.costUsd;
            return r;
          },
          text: async (req) => {
            const r = await base.text(req);
            cost += r.usage.costUsd;
            return r;
          },
        }
      : null;
    const result = (over: Partial<SourceTestResult>): SourceTestResult => ({
      ok: false,
      error: null,
      modeUsed: input.renderMode === "browser" ? "browser" : "static",
      strategy: null,
      recipe: null,
      items: [],
      robotsAllowed: true,
      llmCostUsd: cost,
      diagnostics: {
        modeUsed: input.renderMode === "browser" ? "browser" : "static",
        visibleTextChars: 0,
        linkCount: 0,
        frames: [],
        embeddedHosts: [],
        portals: [],
        llmUsed: false,
        hint: null,
      },
      ...over,
    });
    try {
      if (!(await fetcher.isAllowed(input.url))) {
        return result({ error: this.t("scan.blockedRobots"), robotsAllowed: false });
      }
      const out = await this.fetchAndExtract({
        url: input.url,
        renderMode: input.renderMode,
        detectedMode: input.renderMode === "auto" ? (known?.detectedMode ?? null) : null,
        maxPages: Math.min(5, Math.max(1, input.maxPages || 1)),
        existingRecipe: known?.recipe ?? null,
        lastStrategy: null,
        lastPageHash: null,
        settings,
        llm: metered,
      });
      const { diagnostics, message } = this.diagnose(out, metered !== null, settings);
      return result({
        ok: out.items.length > 0,
        error: out.items.length > 0 ? null : message,
        diagnostics,
        modeUsed: out.modeUsed,
        strategy: out.strategy,
        recipe: out.recipe,
        items: out.items.slice(0, 50),
      });
    } catch (e) {
      return result({ error: errMsg(e) });
    }
  }
}
