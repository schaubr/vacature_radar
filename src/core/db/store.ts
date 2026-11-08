import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_PREFERENCES,
  DEFAULT_SETTINGS,
  type Bucket,
  type Feedback,
  type ListingItem,
  type LlmPurpose,
  type LogEntry,
  type Preferences,
  type Profile,
  type Recipe,
  type ScoreResult,
  type Settings,
  type Source,
  type SourceInput,
  type UsageSummary,
  type VacancyCounts,
  type VacancyDetail,
  type VacancyFields,
  type VacancyFilter,
  type VacancyListItem,
  type VacancyStatus,
} from "../../shared/types";

type ScoreState = VacancyListItem["scoreState"];
type Row = Record<string, unknown>;

/** Full vacancies row mapped to camelCase. */
export interface VacancyRow {
  id: number;
  sourceId: number;
  url: string;
  title: string;
  organization: string;
  location: string;
  snippet: string;
  dateText: string;
  description: string;
  detailFetchedAt: string | null;
  fields: VacancyFields | null;
  firstSeenAt: string;
  lastSeenAt: string;
  missedScans: number;
  status: VacancyStatus;
  duplicateOf: number | null;
  dedupeKey: string;
  score: number | null;
  bucket: Bucket | null;
  scoreResult: ScoreResult | null;
  scoreState: ScoreState;
  scoreError: string | null;
  scoredAt: string | null;
  scoreModel: string | null;
  profileVersion: number | null;
  prefilterReason: string | null;
  feedback: Feedback | null;
  feedbackNote: string;
  notifiedAt: string | null;
}

/** ListingItem + sourceId + dedupeKey + now (ISO timestamp used for first/last seen). */
export interface NewVacancy extends ListingItem {
  sourceId: number;
  dedupeKey: string;
  now: string;
}

export type SourceRuntimePatch = Partial<
  Pick<
    Source,
    | "detectedMode"
    | "strategy"
    | "recipe"
    | "lastScanAt"
    | "lastSuccessAt"
    | "lastStatus"
    | "lastError"
    | "lastFound"
    | "lastPageHash"
    | "consecutiveFailures"
  >
>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    render_mode TEXT NOT NULL DEFAULT 'auto', detected_mode TEXT, scan_interval_hours REAL,
    max_pages INTEGER NOT NULL DEFAULT 1, strategy TEXT, recipe_json TEXT, last_scan_at TEXT,
    last_success_at TEXT, last_status TEXT NOT NULL DEFAULT 'never', last_error TEXT,
    last_found INTEGER NOT NULL DEFAULT 0, last_page_hash TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE vacancies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, organization TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date_text TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', detail_fetched_at TEXT, fields_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, missed_scans INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new', duplicate_of INTEGER REFERENCES vacancies(id) ON DELETE SET NULL,
    dedupe_key TEXT NOT NULL, score INTEGER, bucket TEXT, score_json TEXT, score_state TEXT NOT NULL DEFAULT 'pending',
    score_error TEXT, scored_at TEXT, score_model TEXT, profile_version INTEGER, prefilter_reason TEXT,
    feedback TEXT, feedback_note TEXT NOT NULL DEFAULT '', notified_at TEXT
  );
  CREATE INDEX idx_vacancies_source ON vacancies(source_id);
  CREATE INDEX idx_vacancies_dedupe ON vacancies(dedupe_key);
  CREATE INDEX idx_vacancies_status ON vacancies(status);
  CREATE INDEX idx_vacancies_score ON vacancies(score);
  CREATE TABLE profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    markdown TEXT NOT NULL DEFAULT '', preferences_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, imported_from TEXT, updated_at TEXT
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL
  );
  CREATE INDEX idx_llm_usage_at ON llm_usage(at);
  CREATE TABLE scan_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL, source_id INTEGER, level TEXT NOT NULL, message TEXT NOT NULL
  );
  `,
];

const LOG_KEEP = 2000;
const LOG_PRUNE_EVERY = 100;
const DUPLICATE_WINDOW_DAYS = 60;

const parseJson = <T>(s: unknown): T | null => {
  if (typeof s !== "string" || s === "") return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const str = (v: unknown): string => (v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export class Store {
  private db: DatabaseSync;
  private insertsSincePrune = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---------- internals ----------

  private migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }
  private one(sql: string, ...params: unknown[]): Row | null {
    return (this.db.prepare(sql).get(...(params as never[])) as Row | undefined) ?? null;
  }
  private run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  // ---------- sources ----------

  private mapSource(r: Row): Source {
    return {
      id: Number(r.id),
      name: str(r.name),
      url: str(r.url),
      enabled: Number(r.enabled) === 1,
      renderMode: r.render_mode as Source["renderMode"],
      detectedMode: (r.detected_mode as Source["detectedMode"]) ?? null,
      scanIntervalHours: numOrNull(r.scan_interval_hours),
      maxPages: Number(r.max_pages),
      strategy: (r.strategy as Source["strategy"]) ?? null,
      recipe: parseJson<Recipe>(r.recipe_json),
      lastScanAt: strOrNull(r.last_scan_at),
      lastSuccessAt: strOrNull(r.last_success_at),
      lastStatus: r.last_status as Source["lastStatus"],
      lastError: strOrNull(r.last_error),
      lastFound: Number(r.last_found),
      lastPageHash: strOrNull(r.last_page_hash),
      consecutiveFailures: Number(r.consecutive_failures),
      notes: str(r.notes),
      createdAt: str(r.created_at),
    };
  }

  listSources(): Source[] {
    return this.all("SELECT * FROM sources ORDER BY id").map((r) => this.mapSource(r));
  }

  getSource(id: number): Source | null {
    const r = this.one("SELECT * FROM sources WHERE id = ?", id);
    return r ? this.mapSource(r) : null;
  }

  createSource(input: SourceInput): Source {
    const res = this.run(
      `INSERT INTO sources (name, url, enabled, render_mode, scan_interval_hours, max_pages, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.url,
      input.enabled ? 1 : 0,
      input.renderMode,
      input.scanIntervalHours,
      clampPages(input.maxPages),
      input.notes,
      new Date().toISOString(),
    );
    return this.getSource(res.lastInsertRowid)!;
  }

  updateSource(id: number, patch: Partial<SourceInput>): Source {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.url !== undefined) add("url", patch.url);
    if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
    if (patch.renderMode !== undefined) {
      add("render_mode", patch.renderMode);
      if (patch.renderMode !== "auto") add("detected_mode", null);
    }
    if (patch.scanIntervalHours !== undefined) add("scan_interval_hours", patch.scanIntervalHours);
    if (patch.maxPages !== undefined) add("max_pages", clampPages(patch.maxPages));
    if (patch.notes !== undefined) add("notes", patch.notes);
    if (sets.length) this.run(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    const s = this.getSource(id);
    if (!s) throw new Error(`Source ${id} not found`);
    return s;
  }

  updateSourceRuntime(id: number, patch: SourceRuntimePatch): Source {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    // `in` checks so that explicit null clears a column while absent keys are untouched.
    if ("detectedMode" in patch) add("detected_mode", patch.detectedMode ?? null);
    if ("strategy" in patch) add("strategy", patch.strategy ?? null);
    if ("recipe" in patch) add("recipe_json", patch.recipe ? JSON.stringify(patch.recipe) : null);
    if ("lastScanAt" in patch) add("last_scan_at", patch.lastScanAt ?? null);
    if ("lastSuccessAt" in patch) add("last_success_at", patch.lastSuccessAt ?? null);
    if ("lastStatus" in patch && patch.lastStatus !== undefined) add("last_status", patch.lastStatus);
    if ("lastError" in patch) add("last_error", patch.lastError ?? null);
    if ("lastFound" in patch && patch.lastFound !== undefined) add("last_found", patch.lastFound);
    if ("lastPageHash" in patch) add("last_page_hash", patch.lastPageHash ?? null);
    if ("consecutiveFailures" in patch && patch.consecutiveFailures !== undefined)
      add("consecutive_failures", patch.consecutiveFailures);
    if (sets.length) this.run(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    const s = this.getSource(id);
    if (!s) throw new Error(`Source ${id} not found`);
    return s;
  }

  deleteSource(id: number): void {
    this.tx(() => {
      // Vacancies cascade; clear cross-source duplicate links first so FK SET NULL is not needed mid-cascade.
      this.run(
        "UPDATE vacancies SET duplicate_of = NULL WHERE duplicate_of IN (SELECT id FROM vacancies WHERE source_id = ?)",
        id,
      );
      this.run("DELETE FROM sources WHERE id = ?", id);
    });
  }

  // ---------- vacancies ----------

  private mapVacancy(r: Row): VacancyRow {
    return {
      id: Number(r.id),
      sourceId: Number(r.source_id),
      url: str(r.url),
      title: str(r.title),
      organization: str(r.organization),
      location: str(r.location),
      snippet: str(r.snippet),
      dateText: str(r.date_text),
      description: str(r.description),
      detailFetchedAt: strOrNull(r.detail_fetched_at),
      fields: parseJson<VacancyFields>(r.fields_json),
      firstSeenAt: str(r.first_seen_at),
      lastSeenAt: str(r.last_seen_at),
      missedScans: Number(r.missed_scans),
      status: r.status as VacancyStatus,
      duplicateOf: numOrNull(r.duplicate_of),
      dedupeKey: str(r.dedupe_key),
      score: numOrNull(r.score),
      bucket: (r.bucket as Bucket | null) ?? null,
      scoreResult: parseJson<ScoreResult>(r.score_json),
      scoreState: r.score_state as ScoreState,
      scoreError: strOrNull(r.score_error),
      scoredAt: strOrNull(r.scored_at),
      scoreModel: strOrNull(r.score_model),
      profileVersion: numOrNull(r.profile_version),
      prefilterReason: strOrNull(r.prefilter_reason),
      feedback: (r.feedback as Feedback | null) ?? null,
      feedbackNote: str(r.feedback_note),
      notifiedAt: strOrNull(r.notified_at),
    };
  }

  getVacancyByUrl(url: string): VacancyRow | null {
    const r = this.one("SELECT * FROM vacancies WHERE url = ?", url);
    return r ? this.mapVacancy(r) : null;
  }

  getVacancy(id: number): VacancyRow | null {
    const r = this.one("SELECT * FROM vacancies WHERE id = ?", id);
    return r ? this.mapVacancy(r) : null;
  }

  insertVacancy(v: NewVacancy): VacancyRow {
    const res = this.run(
      `INSERT INTO vacancies (source_id, url, title, organization, location, snippet, date_text,
         first_seen_at, last_seen_at, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.sourceId,
      v.url,
      v.title,
      v.organization,
      v.location,
      v.snippet,
      v.dateText,
      v.now,
      v.now,
      v.dedupeKey,
    );
    return this.getVacancy(res.lastInsertRowid)!;
  }

  touchVacancySeen(id: number, now: string): void {
    this.run(
      `UPDATE vacancies SET last_seen_at = ?, missed_scans = 0,
         status = CASE WHEN status = 'closed' THEN 'seen' ELSE status END
       WHERE id = ?`,
      now,
      id,
    );
  }

  /**
   * Increments missed_scans for every non-closed row of the source that is not in `seenIds`. A row is only
   * auto-closed when its status is new/seen (never interested/applied/dismissed), it reached `closeAfter`
   * misses AND it was last seen at least 7 days before `now` (listing pages re-sort, so a still-open
   * vacancy can drop off page 1 for a while). Returns the closed ids.
   */
  markMissed(sourceId: number, seenIds: number[], closeAfter: number, now: Date = new Date()): number[] {
    const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    return this.tx(() => {
      const seen = new Set(seenIds);
      const candidates = this.all(
        "SELECT id, missed_scans, status, last_seen_at FROM vacancies WHERE source_id = ? AND status != 'closed'",
        sourceId,
      ).filter((r) => !seen.has(Number(r.id)));
      const closed: number[] = [];
      for (const r of candidates) {
        const id = Number(r.id);
        const missed = Number(r.missed_scans) + 1;
        const closable = (r.status === "new" || r.status === "seen") && str(r.last_seen_at) <= cutoff;
        if (missed >= closeAfter && closable) {
          this.run("UPDATE vacancies SET missed_scans = ?, status = 'closed' WHERE id = ?", missed, id);
          closed.push(id);
        } else {
          this.run("UPDATE vacancies SET missed_scans = ? WHERE id = ?", missed, id);
        }
      }
      return closed;
    });
  }

  /** Closes new/seen vacancies whose scored deadline (YYYY-MM-DD) is before `today`. Returns the closed ids. */
  closeExpired(today: string): number[] {
    return this.tx(() => {
      const closed: number[] = [];
      const rows = this.all(
        "SELECT id, fields_json FROM vacancies WHERE status IN ('new','seen') AND fields_json IS NOT NULL",
      );
      for (const r of rows) {
        const f = parseJson<{ deadline?: string }>(r.fields_json);
        const d = f?.deadline?.trim() ?? "";
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < today) {
          this.run("UPDATE vacancies SET status = 'closed' WHERE id = ?", Number(r.id));
          closed.push(Number(r.id));
        }
      }
      return closed;
    });
  }

  /** `now` is injectable for tests; defaults to the wall clock. */
  findDuplicateCandidate(dedupeKey: string, excludeId: number, now: Date = new Date()): VacancyRow | null {
    const cutoff = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();
    const r = this.one(
      `SELECT * FROM vacancies
       WHERE dedupe_key = ? AND id != ? AND duplicate_of IS NULL AND status != 'closed' AND first_seen_at >= ?
       ORDER BY first_seen_at ASC, id ASC LIMIT 1`,
      dedupeKey,
      excludeId,
      cutoff,
    );
    return r ? this.mapVacancy(r) : null;
  }

  setDuplicateOf(id: number, canonicalId: number): void {
    this.run("UPDATE vacancies SET duplicate_of = ? WHERE id = ?", canonicalId, id);
  }

  saveDetail(
    id: number,
    description: string,
    patch: Partial<{ organization: string; location: string; dateText: string }> = {},
  ): void {
    const sets = ["description = ?", "detail_fetched_at = ?"];
    const vals: unknown[] = [description, new Date().toISOString()];
    // Only overwrite list-page values with non-empty detail values.
    if (patch.organization) (sets.push("organization = ?"), vals.push(patch.organization));
    if (patch.location) (sets.push("location = ?"), vals.push(patch.location));
    if (patch.dateText) (sets.push("date_text = ?"), vals.push(patch.dateText));
    this.run(`UPDATE vacancies SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
  }

  saveScore(
    id: number,
    r: { fields: VacancyFields; score: ScoreResult; model: string; profileVersion: number },
  ): void {
    this.run(
      `UPDATE vacancies SET score = ?, bucket = ?, score_json = ?, fields_json = ?, score_state = 'scored',
         score_error = NULL, prefilter_reason = NULL, scored_at = ?, score_model = ?, profile_version = ?
       WHERE id = ?`,
      r.score.score,
      r.score.bucket,
      JSON.stringify(r.score),
      JSON.stringify(r.fields),
      new Date().toISOString(),
      r.model,
      r.profileVersion,
      id,
    );
  }

  setScoreState(
    id: number,
    state: "pending" | "filtered" | "error" | "skipped",
    info: { error?: string; prefilterReason?: string } = {},
  ): void {
    this.run(
      "UPDATE vacancies SET score_state = ?, score_error = ?, prefilter_reason = ? WHERE id = ?",
      state,
      info.error ?? null,
      info.prefilterReason ?? null,
      id,
    );
  }

  markNotified(id: number, now: string): void {
    this.run("UPDATE vacancies SET notified_at = ? WHERE id = ?", now, id);
  }

  setStatus(id: number, status: VacancyStatus): void {
    this.run("UPDATE vacancies SET status = ? WHERE id = ?", status, id);
  }

  setFeedback(id: number, feedback: Feedback | null, note: string): void {
    this.run("UPDATE vacancies SET feedback = ?, feedback_note = ? WHERE id = ?", feedback, note, id);
  }

  private mapListItem(r: Row): VacancyListItem {
    const fields = parseJson<VacancyFields>(r.fields_json);
    return {
      id: Number(r.id),
      sourceId: Number(r.source_id),
      sourceName: str(r.source_name),
      title: str(r.title),
      organization: str(r.organization),
      location: str(r.location),
      url: str(r.url),
      status: r.status as VacancyStatus,
      score: numOrNull(r.score),
      bucket: (r.bucket as Bucket | null) ?? null,
      firstSeenAt: str(r.first_seen_at),
      deadline: fields?.deadline ?? "",
      feedback: (r.feedback as Feedback | null) ?? null,
      scoreState: r.score_state as ScoreState,
      duplicateCount: Number(r.duplicate_count),
    };
  }

  private static readonly LIST_SELECT = `
    SELECT v.id, v.source_id, v.title, v.organization, v.location, v.url, v.status, v.score, v.bucket,
           v.first_seen_at, v.fields_json, v.feedback, v.score_state, s.name AS source_name,
           (SELECT COUNT(*) FROM vacancies d WHERE d.duplicate_of = v.id) AS duplicate_count
    FROM vacancies v JOIN sources s ON s.id = v.source_id`;

  listVacancies(filter: VacancyFilter): VacancyListItem[] {
    const where: string[] = ["v.duplicate_of IS NULL"];
    const params: unknown[] = [];
    if (filter.statuses.length) {
      where.push(`v.status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    } else {
      where.push("v.status NOT IN ('closed', 'dismissed')");
    }
    if (filter.sourceId != null) {
      where.push("v.source_id = ?");
      params.push(filter.sourceId);
    }
    if (filter.minScore != null) {
      where.push(filter.includeUnscored ? "(v.score IS NULL OR v.score >= ?)" : "v.score >= ?");
      params.push(filter.minScore);
    } else if (!filter.includeUnscored) {
      where.push("v.score IS NOT NULL");
    }
    const order =
      filter.sort === "date"
        ? "v.first_seen_at DESC, v.id DESC"
        : "(v.score IS NULL) ASC, v.score DESC, v.first_seen_at DESC, v.id DESC";
    let rows = this.all(`${Store.LIST_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order}`, ...params);
    const q = filter.search.trim().toLowerCase();
    if (q) {
      // Done in JS: SQLite lower()/LIKE are ASCII-only, vacancy text has diacritics.
      rows = rows.filter((r) =>
        [r.title, r.organization, r.location].some((f) => str(f).toLowerCase().includes(q)),
      );
    }
    return rows.map((r) => this.mapListItem(r));
  }

  getVacancyDetail(id: number): VacancyDetail | null {
    const r = this.one(`${Store.LIST_SELECT} WHERE v.id = ?`, id);
    if (!r) return null;
    const row = this.getVacancy(id)!;
    const dups = this.all(
      `SELECT d.id, d.url, s.name AS source_name FROM vacancies d JOIN sources s ON s.id = d.source_id
       WHERE d.duplicate_of = ? ORDER BY d.id`,
      id,
    ).map((d) => ({ id: Number(d.id), url: str(d.url), sourceName: str(d.source_name) }));
    return {
      ...this.mapListItem(r),
      description: row.description,
      snippet: row.snippet,
      fields: row.fields,
      scoreResult: row.scoreResult,
      scoreModel: row.scoreModel,
      scoredAt: row.scoredAt,
      scoreError: row.scoreError,
      prefilterReason: row.prefilterReason,
      feedbackNote: row.feedbackNote,
      duplicates: dups,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /**
   * Counts over canonical (non-duplicate) vacancies. `total` = those not closed/dismissed.
   * `strongNew` = status 'new', score >= threshold, bucket not knockout.
   */
  countVacancies(threshold: number): VacancyCounts {
    const r = this.one(
      `SELECT
         COALESCE(SUM(status = 'new'), 0) AS n_new,
         COALESCE(SUM(status = 'interested'), 0) AS n_interested,
         COALESCE(SUM(status = 'applied'), 0) AS n_applied,
         COALESCE(SUM(status = 'new' AND score >= ? AND COALESCE(bucket, '') != 'knockout'), 0) AS n_strong,
         COALESCE(SUM(status NOT IN ('closed', 'dismissed')), 0) AS n_total
       FROM vacancies WHERE duplicate_of IS NULL`,
      threshold,
    )!;
    return {
      new: Number(r.n_new),
      interested: Number(r.n_interested),
      applied: Number(r.n_applied),
      strongNew: Number(r.n_strong),
      total: Number(r.n_total),
    };
  }

  recentFeedback(limit: number): { title: string; organization: string; feedback: Feedback; note: string }[] {
    // Ordered by most recent activity on the row; id is the proxy (feedback has no timestamp column).
    return this.all(
      `SELECT title, organization, feedback, feedback_note FROM vacancies
       WHERE feedback IS NOT NULL ORDER BY id DESC LIMIT ?`,
      limit,
    ).map((r) => ({
      title: str(r.title),
      organization: str(r.organization),
      feedback: r.feedback as Feedback,
      note: str(r.feedback_note),
    }));
  }

  pendingScoring(limit: number): VacancyRow[] {
    return this.all(
      `SELECT * FROM vacancies
       WHERE score_state = 'pending' AND description != '' AND duplicate_of IS NULL
       ORDER BY first_seen_at ASC, id ASC LIMIT ?`,
      limit,
    ).map((r) => this.mapVacancy(r));
  }

  // ---------- profile / settings ----------

  getProfile(): Profile {
    let r = this.one("SELECT * FROM profile WHERE id = 1");
    if (!r) {
      this.run(
        "INSERT INTO profile (id, markdown, preferences_json, version, imported_from, updated_at) VALUES (1, '', ?, 0, NULL, NULL)",
        JSON.stringify(DEFAULT_PREFERENCES),
      );
      r = this.one("SELECT * FROM profile WHERE id = 1")!;
    }
    const prefs = parseJson<Partial<Preferences>>(r.preferences_json) ?? {};
    return {
      markdown: str(r.markdown),
      preferences: { ...DEFAULT_PREFERENCES, ...prefs },
      version: Number(r.version),
      importedFrom: (r.imported_from as Profile["importedFrom"]) ?? null,
      updatedAt: strOrNull(r.updated_at),
    };
  }

  /** Increments version on every save. `importedFrom` defaults to "manual" when omitted. */
  saveProfile(input: {
    markdown: string;
    preferences: Preferences;
    importedFrom?: Profile["importedFrom"];
  }): Profile {
    const current = this.getProfile();
    this.run(
      "UPDATE profile SET markdown = ?, preferences_json = ?, version = ?, imported_from = ?, updated_at = ? WHERE id = 1",
      input.markdown,
      JSON.stringify(input.preferences),
      current.version + 1,
      input.importedFrom ?? "manual",
      new Date().toISOString(),
    );
    return this.getProfile();
  }

  getSettings(): Settings {
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const r of this.all("SELECT key, value_json FROM settings")) {
      const key = str(r.key);
      if (!(key in DEFAULT_SETTINGS)) continue;
      const v = parseJson<unknown>(r.value_json);
      if (v !== null && typeof v === typeof (DEFAULT_SETTINGS as unknown as Row)[key]) {
        (out as unknown as Row)[key] = v;
      }
    }
    return out;
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || !(k in DEFAULT_SETTINGS)) continue;
        this.run(
          "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
          k,
          JSON.stringify(v),
        );
      }
    });
    return this.getSettings();
  }

  // ---------- usage + log ----------

  recordUsage(u: {
    model: string;
    purpose: LlmPurpose;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    at: string;
  }): void {
    this.run(
      `INSERT INTO llm_usage (at, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      u.at,
      u.model,
      u.purpose,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.costUsd,
    );
  }

  private monthRange(now: Date): [string, string] {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return [start.toISOString(), end.toISOString()];
  }

  monthUsageUsd(now: Date): number {
    const [a, b] = this.monthRange(now);
    const r = this.one("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_usage WHERE at >= ? AND at < ?", a, b)!;
    return Number(r.usd);
  }

  usageSummary(now: Date, budgetUsd: number): UsageSummary {
    const [a, b] = this.monthRange(now);
    const monthUsd = this.monthUsageUsd(now);
    const byPurpose = this.all(
      `SELECT purpose, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM llm_usage
       WHERE at >= ? AND at < ? GROUP BY purpose ORDER BY usd DESC`,
      a,
      b,
    ).map((r) => ({ purpose: r.purpose as LlmPurpose, usd: Number(r.usd), calls: Number(r.calls) }));

    // Last 30 days including today (UTC), oldest first, zero-filled.
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const firstDay = todayStart - 29 * 86_400_000;
    const byDay = new Map<string, number>();
    for (const r of this.all(
      `SELECT substr(at, 1, 10) AS day, SUM(cost_usd) AS usd FROM llm_usage
       WHERE at >= ? AND at < ? GROUP BY day`,
      new Date(firstDay).toISOString(),
      new Date(todayStart + 86_400_000).toISOString(),
    )) {
      byDay.set(str(r.day), Number(r.usd));
    }
    const last30Days: { day: string; usd: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const day = new Date(firstDay + i * 86_400_000).toISOString().slice(0, 10);
      last30Days.push({ day, usd: byDay.get(day) ?? 0 });
    }
    return { monthUsd, budgetUsd, budgetExceeded: monthUsd >= budgetUsd, byPurpose, last30Days };
  }

  log(level: LogEntry["level"], message: string, sourceId: number | null = null): void {
    const res = this.run(
      "INSERT INTO scan_log (at, source_id, level, message) VALUES (?, ?, ?, ?)",
      new Date().toISOString(),
      sourceId,
      level,
      message,
    );
    if (++this.insertsSincePrune >= LOG_PRUNE_EVERY || res.lastInsertRowid % LOG_PRUNE_EVERY === 0) {
      this.insertsSincePrune = 0;
      this.run("DELETE FROM scan_log WHERE id <= (SELECT MAX(id) FROM scan_log) - ?", LOG_KEEP);
    }
  }

  listLog(limit: number): LogEntry[] {
    return this.all("SELECT * FROM scan_log ORDER BY id DESC LIMIT ?", limit).map((r) => ({
      id: Number(r.id),
      at: str(r.at),
      sourceId: numOrNull(r.source_id),
      level: r.level as LogEntry["level"],
      message: str(r.message),
    }));
  }
}

function clampPages(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n || 1)));
}
