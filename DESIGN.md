# Vacature Radar: technical design

Personal macOS menu-bar app that monitors Flemish social-sector job sites, extracts
vacancies, and scores each one against the owner's LinkedIn profile with Claude.
Single user, single profile, Apple Silicon, never distributed.

This document is the contract between modules. Follow the interfaces exactly.
If something here is impossible, implement the closest thing and leave a
`// DESIGN-DEVIATION:` comment explaining why.

---

## 1. Stack and build

| Concern | Choice | Notes |
|---|---|---|
| Shell | Electron **44.10.2** | Ships Node 24 + Chromium 152. `node:sqlite` works (verified). |
| Language | TypeScript 5.9.x, `strict: true` | One language everywhere. |
| Bundler | **esbuild** for main, preload AND renderer | No Vite. `scripts/build.mjs`. |
| UI | React 19 + plain CSS (CSS variables, light/dark) | No Tailwind, no UI kit. |
| Storage | `node:sqlite` (`DatabaseSync`) | No native modules anywhere. |
| HTML parsing | cheerio 1.x | |
| LLM | `@anthropic-ai/sdk` 1.6.x + zod (version the SDK's helpers need) | See section 7. |
| Zip / CSV | fflate, papaparse | LinkedIn export import. |
| robots.txt | robots-parser | |
| Tests | vitest (latest 4.x), run under Node 22+ | Core logic only, no Electron in tests. |
| Dev scripts | tsx | `scripts/scan-cli.ts`. |
| Packaging | electron-builder 26.x, mac arm64, unsigned | See section 11. |

**All runtime libraries are bundled by esbuild**, so every package goes in
`devDependencies`. electron-builder then packs only `dist/` and `package.json`.

`package.json` scripts:

```
build            node scripts/build.mjs            # dist/main/index.js, dist/preload/index.js, dist/renderer/{index.html,app.js,app.css}
start            npm run build && electron .
test             vitest run
typecheck        tsc --noEmit
dist:mac         npm run build && electron-builder --mac --arm64
scan-cli         NODE_USE_ENV_PROXY=1 tsx scripts/scan-cli.ts
```

esbuild settings: main + preload: `platform: "node"`, `format: "cjs"`, `target: "node24"`,
`external: ["electron"]`, `bundle: true`, `sourcemap: true`. Renderer: `platform: "browser"`,
`format: "iife"`, `jsx: "automatic"`, `loader` for `.css`, output `app.js` + `app.css`,
copy `src/renderer/index.html` to `dist/renderer/index.html`. `package.json` `"main": "dist/main/index.js"`.

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
Strict CSP meta tag in index.html: `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.

---

## 2. Directory layout

```
src/
  shared/            types.ts, ipc.ts, models.ts            (no runtime deps; imported by all)
  core/              Electron-free logic, dependency-injected, fully unit-testable
    db/store.ts
    net/fetcher.ts   net/robots.ts   net/render.ts
    extract/html.ts  extract/urls.ts  extract/feed.ts  extract/jsonld.ts
    extract/recipe.ts  extract/anchors.ts  extract/listing.ts  extract/detail.ts
    match/prefilter.ts  match/dedupe.ts
    llm/client.ts  llm/pricing.ts  llm/schemas.ts  llm/prompts.ts
    llm/score.ts  llm/recipe-learn.ts  llm/extract-llm.ts
    profile/linkedin-zip.ts  profile/linkedin-pdf.ts
    scan/scanner.ts  scan/scheduler.ts
    seed.ts  notify.ts  service.ts
  main/              Electron glue only
    index.ts  tray.ts  secrets.ts  electron-fetch.ts  electron-render.ts  ipc.ts
  preload/index.ts
  renderer/          index.html  main.tsx  App.tsx  api.ts  styles.css  views/*  components/*
scripts/  build.mjs  scan-cli.ts
test/     *.test.ts   fixtures/sites/*.html (real pages captured 2026-11-08)
```

Rule: `src/core/**` never imports `electron`. `src/renderer/**` imports only `src/shared/**`.

---

## 3. Shared domain types (`src/shared/types.ts`)

```ts
export type RenderMode = "auto" | "static" | "browser";
export type ExtractStrategy = "feed" | "jsonld" | "recipe" | "llm";
export type SourceStatus = "ok" | "empty" | "error" | "never";
export type VacancyStatus = "new" | "seen" | "interested" | "applied" | "dismissed" | "closed";
export type Bucket = "strong" | "possible" | "weak" | "knockout";
export type Feedback = "up" | "down";
export type ModelId = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
export type Effort = "low" | "medium" | "high";
export type OutputLanguage = "en" | "nl";

export interface Recipe {
  itemSelector: string;          // CSS selector for each vacancy card in the listing
  titleSelector: string;         // relative to item; "" = item text
  linkSelector: string;          // relative to item; "" = item itself (an <a>) or first a[href] inside
  organizationSelector: string;  // "" if unknown
  locationSelector: string;      // "" if unknown
  dateSelector: string;          // "" if unknown
  nextPageSelector: string;      // absolute selector on page for the "next page" link, "" if none
}

export interface Source {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  renderMode: RenderMode;
  detectedMode: "static" | "browser" | null;  // what "auto" resolved to last time
  scanIntervalHours: number | null;           // null = use global setting
  maxPages: number;                           // 1..5, default 1
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
  lastScanAt: string | null;                  // ISO
  lastSuccessAt: string | null;
  lastStatus: SourceStatus;
  lastError: string | null;
  lastFound: number;                          // items found in last scan
  lastPageHash: string | null;
  consecutiveFailures: number;
  notes: string;
  createdAt: string;
}

export interface SourceInput {
  name: string; url: string; enabled: boolean; renderMode: RenderMode;
  scanIntervalHours: number | null; maxPages: number; notes: string;
}

export interface ListingItem {        // what extraction yields per vacancy on a listing page
  title: string;
  url: string;                        // absolute, canonicalized
  organization: string;
  location: string;
  dateText: string;
  snippet: string;                    // card text, max 400 chars
}

export interface VacancyFields {      // structured fields produced by the scoring call
  summary: string; sector: string; isSocialSector: boolean; hours: string; contract: string;
  diplomaRequired: string; experienceRequired: string; payScale: string; deadline: string;
}

export interface ScoreResult {
  score: number;                      // 0..100 integer, clamped in code
  bucket: Bucket;
  subscores: { diploma: number; experience: number; skills: number; preferences: number };
  reasons: string[];
  gaps: string[];
  knockoutReason: string;             // "" if none
  confidence: "high" | "medium" | "low";
}

export interface VacancyListItem {
  id: number; sourceId: number; sourceName: string;
  title: string; organization: string; location: string; url: string;
  status: VacancyStatus; score: number | null; bucket: Bucket | null;
  firstSeenAt: string; deadline: string; feedback: Feedback | null;
  scoreState: "scored" | "pending" | "filtered" | "error" | "skipped";
  duplicateCount: number;             // how many other vacancies point to this one as duplicate_of
}

export interface VacancyDetail extends VacancyListItem {
  description: string;                // detail text
  snippet: string;
  fields: VacancyFields | null;
  scoreResult: ScoreResult | null;
  scoreModel: string | null;
  scoredAt: string | null;
  scoreError: string | null;
  prefilterReason: string | null;     // why it was filtered out, if it was
  feedbackNote: string;
  duplicates: { id: number; url: string; sourceName: string }[];
  lastSeenAt: string;
}

export interface VacancyFilter {
  statuses: VacancyStatus[];          // empty = all except "closed" and "dismissed"
  minScore: number | null;
  sourceId: number | null;
  search: string;                     // matches title/organization/location, case-insensitive
  includeUnscored: boolean;
  sort: "score" | "date";
}

export interface VacancyCounts { new: number; interested: number; applied: number; strongNew: number; total: number }

export interface Preferences {
  homeLocation: string;               // e.g. "Gent"
  maxCommute: string;                 // free text, e.g. "max 45 min by train or 40 km"
  regions: string;                    // free text, e.g. "Oost-Vlaanderen, Brussel"
  hours: "any" | "fulltime" | "parttime";
  contractTypes: string[];            // subset of ["permanent","temporary","replacement","freelance"]
  desiredRoles: string;
  ambitions: string;
  dealBreakers: string;
  salaryNotes: string;
  includeKeywords: string[];          // prefilter: if non-empty, title+snippet must contain one
  excludeKeywords: string[];          // prefilter: title must contain none
}

export interface Profile {
  markdown: string;                   // the candidate profile text used in prompts
  preferences: Preferences;
  version: number;                    // increments on every save
  importedFrom: "linkedin_zip" | "linkedin_pdf" | "manual" | null;
  updatedAt: string | null;
}

export interface Settings {
  scanIntervalHours: number;          // default 6
  notificationsEnabled: boolean;      // default true
  notifyThreshold: number;            // default 70
  scoringModel: ModelId;              // default "claude-opus-5-5"
  utilityModel: ModelId;              // default "claude-sonnet-5-5" (recipes, extraction, PDF import)
  effort: Effort;                     // default "low"
  outputLanguage: OutputLanguage;     // default "en"
  monthlyBudgetUsd: number;           // default 5
  maxNewScoredPerScan: number;        // default 25, per source per scan
  closeAfterMissedScans: number;      // default 3
  launchAtLogin: boolean;             // default true
}

export interface SourceTestResult {
  ok: boolean;
  error: string | null;
  modeUsed: "static" | "browser";
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
  items: ListingItem[];               // first 50
  robotsAllowed: boolean;
  llmCostUsd: number;
}

export interface UsageSummary {
  monthUsd: number; budgetUsd: number; budgetExceeded: boolean;
  byPurpose: { purpose: LlmPurpose; usd: number; calls: number }[];
  last30Days: { day: string; usd: number }[];
}
export type LlmPurpose = "score" | "learn_recipe" | "extract_listing" | "profile_import";

export interface LogEntry { id: number; at: string; sourceId: number | null; level: "info" | "warn" | "error"; message: string }

export interface AppStatus {
  scanning: boolean; currentSourceId: number | null; queueLength: number;
  nextScanAt: string | null; apiKeyConfigured: boolean; budgetExceeded: boolean;
  profileReady: boolean;              // profile markdown non-empty
}

export const DEFAULT_SETTINGS: Settings;      // values as commented above
export const DEFAULT_PREFERENCES: Preferences; // empty strings/arrays, hours "any"
```

---

## 4. IPC contract (`src/shared/ipc.ts`)

One generic invoke channel per method. The preload exposes:

```ts
window.radar = {
  invoke<K extends keyof RadarApi>(method: K, ...args: Parameters<RadarApi[K]>): Promise<Awaited<ReturnType<RadarApi[K]>>>;
  on<E extends keyof RadarEvents>(event: E, cb: (payload: RadarEvents[E]) => void): () => void; // returns unsubscribe
}
```

```ts
export interface RadarApi {
  "sources.list"(): Source[];
  "sources.create"(input: SourceInput): Source;
  "sources.update"(id: number, patch: Partial<SourceInput>): Source;
  "sources.delete"(id: number): void;               // also deletes its vacancies
  "sources.test"(input: { url: string; renderMode: RenderMode; maxPages: number }): Promise<SourceTestResult>;
  "sources.resetRecipe"(id: number): Source;         // clears recipe+strategy so next scan relearns
  "scan.now"(sourceId: number | null): void;         // null = all enabled; returns immediately
  "vacancies.list"(filter: VacancyFilter): VacancyListItem[];
  "vacancies.get"(id: number): VacancyDetail | null; // marks status new -> seen
  "vacancies.setStatus"(id: number, status: VacancyStatus): void;
  "vacancies.setFeedback"(id: number, feedback: Feedback | null, note: string): void;
  "vacancies.rescore"(id: number): Promise<void>;
  "vacancies.openExternal"(id: number): void;
  "vacancies.counts"(): VacancyCounts;
  "profile.get"(): Profile;
  "profile.save"(input: { markdown: string; preferences: Preferences }): Profile;
  "profile.import"(): Promise<Profile | null>;       // main shows file dialog (.zip or .pdf); null if cancelled
  "settings.get"(): Settings;
  "settings.save"(patch: Partial<Settings>): Settings;
  "apiKey.status"(): { configured: boolean; masked: string | null };
  "apiKey.set"(key: string): Promise<{ ok: boolean; error: string | null }>; // validates with a tiny models.list call
  "apiKey.clear"(): void;
  "usage.summary"(): UsageSummary;
  "log.list"(limit: number): LogEntry[];
  "app.status"(): AppStatus;
}

export interface RadarEvents {
  "vacancies.changed": { newIds: number[] };
  "sources.changed": {};
  "app.status": AppStatus;
  "navigate": { view: "inbox" | "sources" | "profile" | "settings" | "activity"; vacancyId?: number };
}
export const RADAR_METHODS: (keyof RadarApi)[];   // runtime list, used by main to register handlers
```

Main registers `ipcMain.handle("radar:" + method, (e, ...args) => service[method](...args))` for
every entry in `RADAR_METHODS`. Events go out on channel `"radar-event:" + name`.
The renderer **never** sees the API key.

---

## 5. Storage (`src/core/db/store.ts`)

`new Store(path: string)` (use `":memory:"` in tests). Uses `DatabaseSync`, `PRAGMA journal_mode=WAL`,
`PRAGMA foreign_keys=ON`, migrations keyed on `PRAGMA user_version`. All timestamps ISO strings (UTC).
JSON columns stored as TEXT. Methods are synchronous.

Tables:

```sql
sources(id INTEGER PK, name TEXT NOT NULL, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  render_mode TEXT NOT NULL DEFAULT 'auto', detected_mode TEXT, scan_interval_hours REAL,
  max_pages INTEGER NOT NULL DEFAULT 1, strategy TEXT, recipe_json TEXT, last_scan_at TEXT,
  last_success_at TEXT, last_status TEXT NOT NULL DEFAULT 'never', last_error TEXT,
  last_found INTEGER NOT NULL DEFAULT 0, last_page_hash TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)

vacancies(id INTEGER PK, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, organization TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', date_text TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', detail_fetched_at TEXT, fields_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, missed_scans INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new', duplicate_of INTEGER REFERENCES vacancies(id) ON DELETE SET NULL,
  dedupe_key TEXT NOT NULL, score INTEGER, bucket TEXT, score_json TEXT, score_state TEXT NOT NULL DEFAULT 'pending',
  score_error TEXT, scored_at TEXT, score_model TEXT, profile_version INTEGER, prefilter_reason TEXT,
  feedback TEXT, feedback_note TEXT NOT NULL DEFAULT '', notified_at TEXT)
  INDEX on (source_id), (dedupe_key), (status), (score)

profile(id INTEGER PK CHECK (id = 1), markdown TEXT NOT NULL DEFAULT '', preferences_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0, imported_from TEXT, updated_at TEXT)

settings(key TEXT PK, value_json TEXT NOT NULL)          -- merged over DEFAULT_SETTINGS on read

llm_usage(id INTEGER PK, at TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL)

scan_log(id INTEGER PK, at TEXT NOT NULL, source_id INTEGER, level TEXT NOT NULL, message TEXT NOT NULL)
  -- keep last 2000 rows (prune on insert every 100 inserts)
```

Store API (implement all; names are the contract):

```ts
// sources
listSources(): Source[]; getSource(id): Source | null; createSource(input: SourceInput): Source;
updateSource(id, patch: Partial<SourceInput>): Source;
updateSourceRuntime(id, patch: Partial<Pick<Source, "detectedMode"|"strategy"|"recipe"|"lastScanAt"|"lastSuccessAt"|"lastStatus"|"lastError"|"lastFound"|"lastPageHash"|"consecutiveFailures">>): Source;
deleteSource(id): void;
// vacancies
getVacancyByUrl(url): VacancyRow | null; getVacancy(id): VacancyRow | null;
insertVacancy(v: NewVacancy): VacancyRow;        // NewVacancy = ListingItem + sourceId + dedupeKey + now
touchVacancySeen(id, now): void;                 // last_seen_at = now, missed_scans = 0; if status 'closed' -> 'seen'
markMissed(sourceId, seenIds: number[], closeAfter: number): number[]; // increments missed_scans for non-closed vacancies of source not in seenIds; closes those reaching closeAfter; returns closed ids
findDuplicateCandidate(dedupeKey, excludeId): VacancyRow | null; // same key, duplicate_of IS NULL, status != closed, first_seen within 60 days
setDuplicateOf(id, canonicalId): void;
saveDetail(id, description: string, patch: Partial<{organization; location; dateText}>): void;
saveScore(id, r: { fields: VacancyFields; score: ScoreResult; model: string; profileVersion: number }): void; // score_state 'scored'
setScoreState(id, state: "pending"|"filtered"|"error"|"skipped", info?: { error?: string; prefilterReason?: string }): void;
markNotified(id, now): void;
setStatus(id, status): void; setFeedback(id, feedback, note): void;
listVacancies(filter: VacancyFilter): VacancyListItem[];   // excludes rows with duplicate_of NOT NULL
getVacancyDetail(id): VacancyDetail | null;
countVacancies(threshold: number): VacancyCounts;
recentFeedback(limit: number): { title: string; organization: string; feedback: Feedback; note: string }[];
pendingScoring(limit: number): VacancyRow[];    // score_state 'pending' AND description != '' AND duplicate_of IS NULL, oldest first
// profile / settings
getProfile(): Profile; saveProfile(input: { markdown; preferences; importedFrom? }): Profile;
getSettings(): Settings; saveSettings(patch: Partial<Settings>): Settings;
// usage + log
recordUsage(u: { model; purpose; inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens; costUsd; at }): void;
monthUsageUsd(now: Date): number;  usageSummary(now: Date, budgetUsd: number): UsageSummary;
log(level, message, sourceId?: number | null): void; listLog(limit): LogEntry[];
```

`VacancyRow` is the full row mapped to camelCase (export the type from store.ts).

---

## 6. Network and extraction (`src/core/net/*`, `src/core/extract/*`, `src/core/match/*`)

### 6.1 Interfaces

```ts
// net/fetcher.ts
export interface RawResponse { status: number; url: string; contentType: string; body: string }
export type RawFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<RawResponse>;
export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Safari/537.36 VacatureRadar/1.0 (personal job monitor)";
export class PoliteFetcher {
  constructor(raw: RawFetch, opts?: { minIntervalMs?: number /*3000*/; timeoutMs?: number /*30000*/; now?: () => number; sleep?: (ms) => Promise<void> });
  fetch(url: string): Promise<RawResponse>;     // per-host serialization + min interval; throws FetchError on network error or status >= 400
  isAllowed(url: string): Promise<boolean>;     // robots.txt via RobotsCache (fetched through raw, cached 24h per origin; missing/4xx robots = allowed; 5xx = allowed but logged)
}
export class FetchError extends Error { status: number | null }

// net/render.ts
export interface PageRenderer { render(url: string): Promise<{ url: string; html: string }> } // fully rendered DOM after JS
```

`PoliteFetcher` also exposes `throttle(url): Promise<void>` so the renderer path shares the same per-host rate limit.

### 6.2 HTML helpers (`extract/html.ts`)

- `visibleTextLength(html): number`: text length after removing script/style/noscript/svg/template.
- `looksJsRendered(html): boolean`: `visibleTextLength < 2500` OR (body has an element with
  `ng-version` / id `app`/`root`/`__next` and fewer than 15 `a[href]` in body).
- `cleanHtmlForLlm(html, maxChars = 120_000): string`: remove script, style, noscript, svg, iframe,
  template, link, meta, head (keep `<title>` text as a first line), comments; drop every attribute except
  `class`, `id`, `href`, `datetime`, `role`, `aria-label`; drop `_ngcontent-*`/`_nghost-*`/`data-*`;
  collapse whitespace; drop empty elements without attributes. If still longer than maxChars, keep the
  element subtree (main > [role=main] > body) with the highest `a[href]` count that fits, else truncate.
- `extractMainText(html, maxChars = 15_000): string`: remove script/style/noscript/svg/nav/header/footer/
  aside/form/iframe and any element whose id or class contains "cookie" or "consent"; pick `main`, then
  `article`, then `[role=main]`, then `body`; produce text with a newline between block elements,
  collapse blank lines, truncate.
- `sha256(text): string` (hex, `node:crypto`).

### 6.3 URLs (`extract/urls.ts`)

- `resolveUrl(href, base): string | null` (ignore `javascript:`, `mailto:`, `tel:`, `#...`).
- `canonicalizeUrl(url): string`: lowercase host, drop fragment, drop query params matching
  `^utm_`, `fbclid`, `gclid`, `source`, `medium`, `ref`, `trk`, sort remaining params, drop trailing slash
  (except root). Example: `https://www.vdab.be/vindeenjob/vacatures/74890892/maatschappelijk-werker?source=vindeenjob&medium=vacaturedashboard`
  becomes `https://www.vdab.be/vindeenjob/vacatures/74890892/maatschappelijk-werker`.

### 6.4 Tiers

- `extract/feed.ts`: `isFeed(contentType, body)`, `parseFeed(body, baseUrl): ListingItem[]` (RSS 2.0 `item`,
  Atom `entry`; cheerio `xmlMode`). Also `findFeedLink(html, baseUrl): string | null` (not auto-followed;
  surfaced in test results only as a hint in a later version, keep the function).
- `extract/jsonld.ts`: `findJobPostings(html): JobPostingLd[]` walks every
  `script[type="application/ld+json"]`, handles arrays, `@graph`, `ItemList.itemListElement[].item`,
  and `@type` given as string or array. `JobPostingLd = { title; url; description (HTML stripped to text);
  organization; location; datePosted; validThrough; employmentType }` (all strings, "" if missing).
  `jobPostingsToItems(postings, baseUrl): ListingItem[]` (only those with a url).
- `extract/recipe.ts`: `applyRecipe(html, baseUrl, recipe): ListingItem[]` with cheerio. For each item:
  title = text of titleSelector (or item), link = href of linkSelector (or item if `<a>`, else first
  `a[href]` in item); resolve + canonicalize; skip items without title or url; dedupe by url; snippet =
  item text collapsed, max 400 chars. Catch invalid selectors and return `[]`.
  `findNextPage(html, baseUrl, recipe): string | null`.
  `recipeLooksHealthy(items): boolean`: `items.length >= 1` and at least 60% of items have a
  title of 4..200 chars and urls are not all identical.
- `extract/anchors.ts`: `compactAnchors(html, baseUrl, max = 400): string`: one line per `a[href]` in body:
  `[n] <anchor text> | <url> | <closest block ancestor text, 200 chars>`; skip anchors in nav/header/footer,
  skip empty text, dedupe by url.
- `extract/listing.ts` orchestrates (pure function, LLM injected):

```ts
export interface ListingContext {
  url: string; html: string; contentType: string;
  existingRecipe: Recipe | null;
  learnRecipe?: (cleanedHtml: string, url: string) => Promise<Recipe | null>;      // from llm/recipe-learn.ts (does its own validation)
  llmExtract?: (compact: string, url: string) => Promise<ListingItem[]>;            // from llm/extract-llm.ts
}
export interface ListingResult { items: ListingItem[]; strategy: ExtractStrategy | null; recipe: Recipe | null }
export async function extractListing(ctx: ListingContext): Promise<ListingResult>;
```

Order: (1) feed if `isFeed`; (2) JSON-LD job postings with >= 2 items; (3) `existingRecipe` if healthy;
(4) `learnRecipe` then apply, if healthy; (5) `llmExtract`. First tier that yields items wins.
Returns `{ items: [], strategy: null, recipe: existingRecipe }` when all fail.

- `extract/detail.ts`: `extractDetail(html, url): { text: string; organization: string; location: string; datePosted: string; validThrough: string }`.
  If a JobPosting JSON-LD exists, build text from its fields (title, organization, location, employment
  type, validThrough, description) and ALSO append `extractMainText` if the description is under 500 chars.
  Otherwise `extractMainText`.

### 6.5 Matching helpers

- `match/dedupe.ts`: `normalizeTitle(t)`: lowercase, strip diacritics, remove gender markers like `(m/v/x)`,
  `m/v/x`, `(m/v)`, `(v/m/x)`, `(h/f/x)`, remove punctuation, collapse spaces.
  `normalizeOrg(o)`: same, plus remove `vzw`, `cvba`, `bv`, `nv`, `ocmw` stays. `dedupeKey(title, org)`:
  `normalizeTitle(title) + "|" + normalizeOrg(org)`; when org is "" the key is `title|` + host-less.
- `match/prefilter.ts`: `prefilter(item: { title; snippet }, prefs: Preferences): { pass: true } | { pass: false; reason: string }`.
  Case- and diacritic-insensitive word-boundary matching. Exclude keywords checked against title only.
  Include keywords (if any) against title + snippet.

---

## 7. LLM layer (`src/core/llm/*`)

### 7.1 Client (`llm/client.ts`)

```ts
export interface LlmUsage { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
export interface StructuredRequest<T> {
  purpose: LlmPurpose; model: ModelId; effort: Effort; maxTokens: number;
  system: { text: string; cache: boolean }[];         // cache=true puts cache_control {type:"ephemeral"} on that block
  user: Anthropic.ContentBlockParam[] | string;
  schema: z.ZodType<T>;
}
export interface TextRequest { purpose: LlmPurpose; model: ModelId; effort: Effort; maxTokens: number; system: string; user: Anthropic.ContentBlockParam[] | string }
export interface LlmClient {
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  text(req: TextRequest): Promise<{ text: string; usage: LlmUsage }>;
}
export class BudgetExceededError extends Error {}
export class RefusalError extends Error {}
export class LlmNotConfiguredError extends Error {}

export class AnthropicLlmClient implements LlmClient {
  constructor(opts: {
    getApiKey: () => string | null;                    // read per call; throw LlmNotConfiguredError if null
    budget: { monthUsd: () => number; limitUsd: () => number };  // checked BEFORE each call -> BudgetExceededError
    onUsage: (u: LlmUsage & { purpose: LlmPurpose }) => void;   // store.recordUsage
    anthropicFactory?: (apiKey: string) => Anthropic;  // tests inject a fake
  });
}
```

Implementation rules (from the Claude API reference for SDK 1.6, Nov 2026):

- Construct `new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 })` (cache per key).
- **Thinking**: never send `thinking: {type: "disabled"}` or `budget_tokens` (400 on Opus 5.5 / Sonnet 5.5 /
  Haiku 5.5). Omit `thinking` entirely. Control depth only with `output_config.effort`.
- **Structured output**: send `output_config: { effort, format: zodOutputFormat(schema) }`
  (`import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`). Do not use `minLength`, `maxLength`,
  `min`, `max`, `.int().min()` etc. in schemas sent to the API: the API ignores numeric/string constraints.
  Clamp and truncate in code after parsing.
- **Refusal fallback**: for `claude-opus-5-5` and `claude-sonnet-5-5`, call
  `client.beta.messages.create({ ..., betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })`.
  For `claude-haiku-5-5`, call the same endpoint without `betas`/`fallbacks` (Haiku has no server fallback).
  If the installed SDK types don't accept `zodOutputFormat` on the beta endpoint, pass
  `format: { type: "json_schema", schema: <JSON schema from zod> }` and validate with `schema.parse` yourself.
  Check the SDK's `.d.ts` files in node_modules rather than guessing.
- Always check `stop_reason` before reading content: `"refusal"` -> `RefusalError`; `"max_tokens"` -> Error
  ("response truncated"). Find the first `text` block, `JSON.parse`, then `schema.parse`.
- System blocks: `system: [{ type: "text", text, cache_control?: { type: "ephemeral" } }]`.
- Prompt caching minimum on these models is 512 tokens; the scoring system prompt is well above that.
- Typed errors: map `Anthropic.AuthenticationError` -> message "Invalid Anthropic API key",
  `Anthropic.RateLimitError` -> retry once after 20 s then rethrow, others rethrow with status in message.
- Usage: `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens ?? 0`,
  `usage.cache_creation_input_tokens ?? 0`. Cost via `llm/pricing.ts`.

### 7.2 Pricing (`llm/pricing.ts` + `src/shared/models.ts`)

USD per million tokens (Anthropic list prices as of Oct 2026):

| Model | Input | Output | Cache read | Cache write |
|---|---|---|---|---|
| claude-opus-5-5 | 4.00 | 20.00 | 0.20 | 5.00 |
| claude-sonnet-5-5 | 2.00 | 10.00 | 0.20 | 2.50 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 |

`costUsd(model, usage)`. `src/shared/models.ts` exports `MODELS: { id: ModelId; label: string; note: string }[]`
for the settings dropdown (Opus 5.5 "best judgment", Sonnet 5.5 "balanced", Haiku 5.5 "cheapest").

### 7.3 Schemas (`llm/schemas.ts`, zod)

```ts
ScoreSchema = z.object({
  summary: z.string(), organization: z.string(), location: z.string(),
  sector: z.string(), is_social_sector: z.boolean(),
  hours: z.string(), contract: z.string(), diploma_required: z.string(),
  experience_required: z.string(), pay_scale: z.string(), deadline: z.string(),
  score: z.number(), bucket: z.enum(["strong","possible","weak","knockout"]),
  subscores: z.object({ diploma: z.number(), experience: z.number(), skills: z.number(), preferences: z.number() }),
  reasons: z.array(z.string()), gaps: z.array(z.string()),
  knockout_reason: z.string(), confidence: z.enum(["high","medium","low"]),
});
RecipeSchema = z.object({
  found: z.boolean(), item_selector: z.string(), title_selector: z.string(), link_selector: z.string(),
  organization_selector: z.string(), location_selector: z.string(), date_selector: z.string(),
  next_page_selector: z.string(), notes: z.string(),
});
ListingExtractSchema = z.object({
  vacancies: z.array(z.object({ title: z.string(), url: z.string(), organization: z.string(), location: z.string() })),
});
```

### 7.4 Prompts (`llm/prompts.ts`)

**Scoring** (`buildScoringSystem(profile: Profile, lang: OutputLanguage): {text, cache}[]`,
`buildScoringUser(v, feedback): string`):

System block 1 (cache: false, stable text) contains:
- Role: careful career advisor for the Flemish social-profit sector, assessing fit between ONE candidate
  and ONE vacancy. Honest, not flattering. A vacancy that is a poor fit should score low.
- Context on the Flemish sector: diploma requirements are often hard gates (e.g. "bachelor sociaal werk",
  "orthopedagogie", "of gelijkwaardig door ervaring" softens it); pay is often set by joint committee
  (PC 319.01, 330, 331, 329, IFIC) or local-government scales (B1-B3, C1-C3, A1a...); "werfreserve" means
  a recruitment reserve; "vervangingscontract" is a replacement contract; local governments (lokaal bestuur/OCMW)
  post many non-social roles.
- Rubric: subscores 0..100 for diploma (meets formal requirement?), experience (relevant years/domains),
  skills (competences, methods, target groups), preferences (location/commute, hours, contract, ambitions,
  deal-breakers). Overall score is a judgment, not an average, and must respect knock-outs.
- Anchors: 85-100 excellent fit, apply now; 70-84 strong; 50-69 possible with caveats; 25-49 weak;
  0-24 not relevant. Bucket: strong >= 70, possible 50-69, weak < 50, knockout if a hard requirement is
  clearly unmet or a deal-breaker is hit (then score <= 30 and knockout_reason explains it).
- If the vacancy is not in the social sector or is not a job vacancy at all, set is_social_sector false
  and score accordingly.
- Field instructions: empty string when unknown; deadline as YYYY-MM-DD; reasons and gaps max 4 items,
  each one short sentence, concrete, referring to the vacancy text; summary max 2 sentences.
- Output language: English or Dutch per setting (applies to summary, reasons, gaps, knockout_reason).

System block 2 (cache: true): `# Candidate profile\n{markdown}\n\n# Candidate preferences\n{rendered preferences}`.

User message: recent feedback (max 10, "The candidate liked/disliked: <title> at <org>. Note: ...") as
calibration hints, then `# Vacancy\nTitle: ..\nOrganization: ..\nLocation: ..\nSource: ..\nURL: ..\n\n{description truncated to 12000 chars}`.

**Recipe learning** (`buildRecipePrompt(cleanedHtml, url)`): system explains the task: given a cleaned job
listing page, return CSS selectors (CSS3 only, compatible with cheerio/css-select; no XPath, no `:contains`)
that select each individual vacancy card and, relative to the card, the title, the link to the vacancy detail
page, organization, location and date. Prefer stable class names over positional selectors; avoid
framework-generated hashes. `found: false` if the page lists no vacancies. Retry prompt
(`buildRecipeRetryPrompt(prev, problem, sample)`) explains what went wrong ("matched 0 items", "titles empty",
"all links identical") and asks for corrected selectors.

**Listing extraction fallback** (`buildListingExtractPrompt(compact, url)`): from the numbered anchor list,
return only links that point to an individual job vacancy detail page; exclude navigation, category, filter,
login, social-media and pagination links. Copy urls exactly.

**Profile PDF** (`buildProfilePdfPrompt()`): convert the attached LinkedIn "Save to PDF" export into a concise
markdown profile with sections: Headline, Summary, Experience (role, organization, period, 1-3 bullet
responsibilities each), Education, Skills, Languages, Certifications, Volunteering. Do not invent anything.

### 7.5 Operations

- `llm/score.ts`: `scoreVacancy(llm, settings, profile, vacancy: { title; organization; location; sourceName; url; description }, feedback): Promise<{ fields: VacancyFields; score: ScoreResult; usage }>`.
  maxTokens 6000. Post-process: clamp all scores to integers 0..100; truncate reasons/gaps to 4; if
  `knockout_reason` non-empty force bucket "knockout" and score <= 30; else derive bucket from score
  (>=70 strong, >=50 possible, else weak) so bucket and score never disagree.
- `llm/recipe-learn.ts`: `learnRecipe(llm, settings, cleanedHtml, url, rawHtml): Promise<Recipe | null>`:
  call with utilityModel, maxTokens 4000; if `found` false -> null; apply to rawHtml with `applyRecipe`;
  if not healthy, one retry with the retry prompt; return the recipe only if healthy.
- `llm/extract-llm.ts`: `llmExtractListing(llm, settings, compact, url): Promise<ListingItem[]>`: resolve and
  canonicalize urls, drop items whose url is not in the compact list (no hallucinated links).
- `profile/linkedin-zip.ts`: `linkedinZipToMarkdown(buf: Uint8Array): string`. Unzip with fflate. Match
  files case-insensitively by basename: Profile.csv, Positions.csv, Education.csv, Skills.csv,
  Languages.csv, Certifications.csv, Projects.csv, Volunteering.csv (others ignored). Parse with papaparse
  (`header: true, skipEmptyLines: true`); if the first line does not look like a header (e.g. starts with
  "Notes:"), skip lines until a line with >= 2 commas that parses into >= 2 columns. Do not hard-code
  column names: render every non-empty field as `Key: value`, but order known keys first when present
  (Profile: First Name, Last Name, Headline, Summary, Industry, Geo Location; Positions: Title, Company Name,
  Started On, Finished On, Location, Description). Throw a clear Error if no recognised CSV is found.
- `profile/linkedin-pdf.ts`: `linkedinPdfToMarkdown(llm, settings, buf): Promise<string>`: document block
  `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }` then the text
  instruction, utilityModel, maxTokens 8000, `llm.text(...)`.

---

## 8. Scanning (`src/core/scan/*`)

### 8.1 ScanService (`scan/scanner.ts`)

```ts
export interface ScanDeps {
  store: Store; fetcher: PoliteFetcher; renderer: PageRenderer | null; // null in contexts without a browser
  llm: LlmClient | null; notifier: Notifier; now: () => Date;
  emit: <E extends keyof RadarEvents>(event: E, payload: RadarEvents[E]) => void;
}
export class ScanService {
  constructor(deps: ScanDeps);
  scanSource(sourceId: number): Promise<void>;
  scanMany(sourceIds: number[]): Promise<void>;     // serial; skips if already running (queue merge)
  testSource(input: { url; renderMode; maxPages }): Promise<SourceTestResult>; // no DB writes except llm usage
  scoreOne(vacancyId: number): Promise<void>;       // used by rescore
  get status(): { scanning: boolean; currentSourceId: number | null; queueLength: number };
}
```

`scanSource` algorithm:

1. Load source; `now = deps.now()`. Log "Scan started".
2. `robots = fetcher.isAllowed(url)`; if false -> status "error", lastError "Blocked by robots.txt", stop.
3. Load listing page per mode: `static` -> fetcher; `browser` -> `fetcher.throttle(url)` then renderer;
   `auto` -> use `detectedMode` if set, else static first and, if `looksJsRendered(html)` or the
   extraction below yields 0 items, retry with the renderer (when available) and set `detectedMode`.
4. `pageHash = sha256(cleanHtmlForLlm(html))`.
   Cost guard: if the source has no healthy recipe AND `pageHash === lastPageHash` AND `strategy === "llm"`,
   skip LLM tiers this time (pass no `learnRecipe`/`llmExtract`), because the page did not change.
5. `extractListing` with `learnRecipe` / `llmExtract` bound to the LLM layer (only if llm configured and
   budget not exceeded). Follow `findNextPage` up to `maxPages` when strategy is "recipe" (same recipe).
6. If 0 items: status "empty" (or "error" with the exception message), `consecutiveFailures++`, log warn,
   do NOT mark anything missed, stop.
7. Upsert items: existing url -> `touchVacancySeen`; new -> `insertVacancy` with `dedupeKey`; if
   `findDuplicateCandidate` finds a match -> `setDuplicateOf(new, existing)` (no scoring for duplicates).
8. `markMissed(sourceId, seenIds, settings.closeAfterMissedScans)`.
9. For new, non-duplicate vacancies in page order, up to `settings.maxNewScoredPerScan`:
   `prefilter` against profile preferences -> if fail `setScoreState(id, "filtered", {prefilterReason})`;
   else fetch detail page (same mode as listing), `extractDetail`, `saveDetail`, leave `pending`.
   Remaining new vacancies beyond the cap get state "skipped" (user can rescore manually).
   Detail fetch failures: `setScoreState(id, "error", {error})`, continue.
10. Update source runtime: status "ok", lastSuccessAt, lastFound, strategy, recipe, lastPageHash,
    consecutiveFailures 0. Emit `vacancies.changed` and `sources.changed`.
11. Run the scoring queue: `store.pendingScoring(50)` serially. Skip entirely (leave pending) if LLM is not
    configured, profile markdown is empty, or budget exceeded (log once per scan). For each:
    `scoreVacancy` -> `saveScore`; on BudgetExceededError stop the queue; on other errors `setScoreState("error")`.
12. Notifications: collect newly scored vacancies with `score >= notifyThreshold`, bucket != knockout,
    `notifiedAt` null. If 1..3: one notification each ("82 · Maatschappelijk werker", body "OCMW Lendelede · Lendelede").
    If more: one summary ("5 new strong matches", body top 3 titles). `markNotified`. Respect `notificationsEnabled`.
13. Log "Scan finished: N found, M new, K scored".

Any thrown error inside steps 3-10 -> status "error", lastError = message, consecutiveFailures++, log error.

`testSource` runs steps 2-5 without writing (LLM usage is still recorded) and returns `SourceTestResult`.

### 8.2 Scheduler (`scan/scheduler.ts`)

```ts
export class Scheduler {
  constructor(opts: { store: Store; scanner: ScanService; now: () => Date; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval });
  start(): void;          // tick immediately (after 10 s delay) and every 60 s
  stop(): void;
  tick(): Promise<void>;  // collects due sources and calls scanner.scanMany
  dueSources(now: Date): number[];   // enabled && (lastScanAt null || lastScanAt + interval <= now); interval = source.scanIntervalHours ?? settings.scanIntervalHours
  nextScanAt(now: Date): string | null;
  onResume(): void;       // called on system wake: tick()
}
```

### 8.3 Service facade (`core/service.ts`)

`class RadarService` implements every `RadarApi` method (same names, e.g. `service["sources.list"]()`),
wiring Store, ScanService, Scheduler, LLM operations and a `SecretsPort { get(): string | null; set(k): void; clear(): void }`
plus `ShellPort { openExternal(url): void; pickImportFile(): Promise<{ path: string; data: Uint8Array } | null> }`.
`apiKey.set` validates by calling `new Anthropic({apiKey}).models.list({ limit: 1 })` (inject for tests).
`scan.now` fires and forgets (`void scanner.scanMany(...)`). `vacancies.get` marks `new -> seen`.
After every mutating call emit the relevant event. `app.status` composes scanner status, scheduler
`nextScanAt`, secrets, budget and profile readiness.

### 8.4 Seed sources (`core/seed.ts`)

Inserted on first run only (when the sources table is empty):

| Name | URL | Mode | Enabled |
|---|---|---|---|
| VDAB: maatschappelijk werker | `https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker` | browser | yes |
| VDAB: sociaal werker | `https://www.vdab.be/vindeenjob/vacatures?trefwoord=sociaal%20werker` | browser | yes |
| VVSG (lokale besturen) | `https://www.vvsg.be/vacatures/overzicht-vacatures` | static | yes |
| Jobsolutions | `https://www.jobsolutions.be/` | static | yes |
| CAW (cawpro.be) | `https://www.cawpro.be/jobs/?caw-type=job` | auto | no (untested) |
| Zorgnet-Icuro | `https://www.zorgneticuro.be/content/overzicht-jobs` | auto | no (untested) |

Notes field explains: "Seeded 2026-11-08. Use Test before enabling." for the disabled ones.

Site survey facts (2026-11-08): VDAB listing and detail pages are an Angular SPA (static HTML has no
vacancies; rendered DOM has `li.c-vacature` cards with `h4.c-vacature__content-title a`, 20 per page);
VDAB robots.txt allows `/vindeenjob/vacatures` but disallows `/api/vindeenjob/` (never call that API
directly). VVSG and Jobsolutions are static HTML with ~20 vacancy links. VVSG detail pages contain
JobPosting JSON-LD. No site offered a job RSS feed.

---

## 9. Electron main (`src/main/*`)

- `index.ts`: `app.requestSingleInstanceLock()`; on second instance show window. App name "Vacature Radar".
  DB at `app.getPath("userData")/radar.db`. Build deps: Store, ElectronRawFetch, PoliteFetcher,
  ElectronRenderer, AnthropicLlmClient (getApiKey from secrets, budget from store), Notifier, ScanService,
  Scheduler, RadarService. Seed sources. Register IPC. Create tray. Create window on launch.
  `powerMonitor.on("resume", () => scheduler.onResume())`. Apply `launchAtLogin` via
  `app.setLoginItemSettings({ openAtLogin })` on start and whenever the setting changes.
- Window: 1180x780, min 900x600, `titleBarStyle: "hiddenInset"`, loads `dist/renderer/index.html`.
  Closing the window hides it (app stays in tray). `app.dock.hide()` when hidden, `app.dock.show()` when shown.
  Quit only via tray menu or Cmd+Q (set a `quitting` flag in `before-quit`).
- `tray.ts`: `new Tray(nativeImage.createEmpty())` + `tray.setTitle("◎")` (shows `◎ 3` when there are
  new strong matches). Menu: "Open Vacature Radar", "Scan now", separator, status line (disabled item:
  "Scanning..." / "Next scan 14:05" / "Budget reached"), separator, "Quit". Refresh on `app.status` changes.
- `electron-fetch.ts`: `RawFetch` built on `net.fetch` (Chromium network stack, handles gzip/br and system
  proxy). Read body as text (decode using charset from content-type, default utf-8).
- `electron-render.ts`: one hidden `BrowserWindow` (`show: false`, `webPreferences: { partition: "persist:scraper",
  javascript: true, images: false, contextIsolation: true, sandbox: true }`), user agent = `USER_AGENT`.
  Renders are serialized. `loadURL`, then poll every 500 ms via `executeJavaScript` the
  `document.body.innerText.length`; done when unchanged for 3 consecutive polls after `did-finish-load`, or
  after 25 s. Return `{ url: webContents.getURL(), html: document.documentElement.outerHTML }`.
  Block navigation to non-http(s) schemes. Destroy and recreate the window after 50 renders.
- `secrets.ts`: `SecretsPort` using `safeStorage.encryptString` stored base64 in `userData/secret.bin`
  (mode 0600). If `safeStorage.isEncryptionAvailable()` is false, refuse to store and return an error.
- Notifier: `new Notification({ title, body, silent: false })`; on click: show window and emit
  `navigate { view: "inbox", vacancyId }`.
- `ipc.ts`: registers handlers for `RADAR_METHODS`, wraps errors so the renderer receives `Error.message`.
- `shell.openExternal` only for `http:`/`https:` urls.

---

## 10. Renderer UI (`src/renderer/*`)

Look: calm macOS-native utility. System font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text"`),
13px base, 8px spacing grid, left sidebar (with 28px top padding for the inset traffic lights,
`-webkit-app-region: drag` on the sidebar top strip and header), content area. CSS variables for colors,
`@media (prefers-color-scheme: dark)` overrides. Bucket colors: strong = green, possible = amber,
weak = gray, knockout = red (also show the word, never color alone).

`api.ts`: `export const api = window.radar` with the typed interface from `src/shared/ipc.ts`
(declare `window.radar` in a `global.d.ts`).

Views (sidebar items with counts):

1. **Inbox** (default): toolbar with search box, status chips (New, Seen, Interested, Applied, Dismissed,
   Closed; multi-select), min-score slider (0-100, step 5), source dropdown, sort toggle (Score/Date),
   "include unscored" checkbox. List of rows: score pill (number + bucket word), title (bold if status new),
   organization · location, source name, "first seen 2 d ago", deadline if any, small "+2 duplicates" tag.
   Selecting a row opens the detail pane on the right (split view, list 45% / detail 55%).
   Empty states: no API key -> card linking to Settings; no profile -> card linking to Profile;
   no vacancies yet -> "Scan now" button.
2. **Vacancy detail** (right pane): title, organization, location, source, links "Open vacancy" (external)
   and duplicates. Score block: big number, bucket word, confidence, four subscore bars, Reasons list (✓),
   Gaps list (△), knockout banner if any. Fields grid (sector, hours, contract, diploma, experience, pay scale,
   deadline). Summary. Status buttons (Interested, Applied, Dismiss, back to Seen). Feedback 👍/👎 with
   optional note input. "Re-score" button. Collapsible "Full vacancy text". If filtered/skipped/error show
   why and a "Score anyway" button (calls rescore).
3. **Sources**: table (enabled toggle, name, url host, mode, strategy, last scan relative time, status dot
   with tooltip lastError, items found). Row actions: Edit, Scan now, Reset recipe, Delete (confirm).
   "Add source" button opens the **Source editor** modal: name, URL, render mode (Auto / Plain HTML /
   Browser), max pages (1-5), interval override (empty = global), notes, enabled. "Test" button calls
   `sources.test` and shows: robots verdict, mode used, strategy, LLM cost of the test, and a preview table
   of found items (title, organization, location, link). Save is allowed without testing but shows a hint.
4. **Profile**: "Import LinkedIn export" button (accepts the data-export .zip or the "Save to PDF" .pdf)
   with a short how-to (LinkedIn > Settings > Data privacy > Get a copy of your data; or Profile > More >
   Save to PDF). Large monospace textarea for the profile markdown. Preferences form for every
   `Preferences` field (keyword lists as comma-separated inputs). Save button; show version and last update.
5. **Settings**: Anthropic API key (password input, Save validates, shows masked key + Clear),
   models (scoring model, utility model) with price hints, effort, output language, scan interval (hours),
   notifications toggle + threshold, max new scored per scan, close after missed scans, monthly budget,
   launch at login. Usage card: this month $ vs budget (progress bar), by purpose, simple 30-day bar list.
6. **Activity**: log table (time, level, source, message), auto-refresh on events, newest first.

Global: status bar at the bottom of the sidebar: "Scanning VVSG..." / "Next scan 14:05" + "Scan all now"
button. Listen to `navigate` events. Refresh data on `vacancies.changed` / `sources.changed` / `app.status`.
Relative times via a small helper (no date library). Keyboard: up/down moves selection in Inbox,
`o` opens externally, `i`/`a`/`d` set Interested/Applied/Dismissed.

---

## 11. Packaging

electron-builder config in `package.json` `"build"`: `appId: "local.vacatureradar"`, `productName: "Vacature Radar"`,
`files: ["dist/**/*", "package.json"]`, `directories.output: "release"`, `mac: { target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }], category: "public.app-category.productivity", identity: null, hardenedRuntime: false }`.
README explains the unsigned-app first launch (right-click > Open, or `xattr -cr`), and an optional ad-hoc
signature: `codesign --force --deep -s - "release/mac-arm64/Vacature Radar.app"`.

---

## 12. Dev CLI (`scripts/scan-cli.ts`)

For testing the core pipeline outside Electron (used in CI-less dev on Linux too):

```
tsx scripts/scan-cli.ts test <url> [--browser] [--recipe '<json>']   # prints strategy + items
tsx scripts/scan-cli.ts detail <url> [--browser]                       # prints extracted detail text
tsx scripts/scan-cli.ts scan --db ./dev.db [--source <id>]            # full scan incl. scoring if ANTHROPIC_API_KEY set
```

Uses global `fetch` as RawFetch and, for `--browser`, a Playwright renderer loaded with
`require("playwright")` at runtime (not a dependency; pass `proxy: { server: process.env.HTTPS_PROXY }` when
that variable is set). LLM is enabled only when `ANTHROPIC_API_KEY` is set.

---

## 13. Tests (vitest, `test/`)

Fixtures in `test/fixtures/sites/`: `vdab_list.html` (rendered), `vdab_detail.html` (rendered),
`vvsg_list.html`, `vvsg_detail.html` (has JobPosting JSON-LD), `jobsolutions_list.html`,
`jobsolutions_detail.html`, `werkenvoor_list.html`, `vdab_robots.txt`.

Required coverage:
- urls: canonicalize VDAB tracking params; resolve relative links.
- html: `looksJsRendered` false for vvsg, true-ish heuristics; `cleanHtmlForLlm` strips `_ngcontent` and
  scripts and shrinks vdab_list by > 50%; `extractMainText` on detail fixtures contains the job title.
- recipe: hand-written recipes for vdab_list (`li.c-vacature`), vvsg_list and jobsolutions_list each yield
  >= 10 healthy items with absolute urls; invalid selector returns [].
- jsonld: vvsg_detail yields a JobPosting with non-empty title and description.
- listing orchestration with fake `learnRecipe`/`llmExtract`; tier order respected.
- dedupe + prefilter edge cases (gender markers, diacritics, word boundaries).
- store: migrations, CRUD, markMissed/closing, duplicates excluded from list, usage summary.
- llm client with a fake Anthropic: budget guard, refusal, cost calc, beta fallbacks params for Opus/Sonnet
  and not for Haiku, cache_control placement.
- score post-processing (clamping, bucket consistency, knockout).
- recipe-learn retry path; extract-llm drops hallucinated urls.
- linkedin zip -> markdown with a synthetic zip built in the test via fflate.
- scanner end-to-end with fake fetcher/renderer/llm on fixtures: new items inserted, duplicates linked,
  prefilter applied, cap respected, notifications batched, missed/closed logic, error paths.
- scheduler: due computation, per-source interval override.

---

## 14. Travel time from home (added 2026-11-08)

Owner's choice: **driving time via a routing API** (OpenRouteService, "ORS"), shown on every vacancy,
sortable and filterable in the Inbox, and **fed into the AI score**. No hard cutoff before scoring.

### 14.1 ORS API contract (verified from the official docs and the official JS client, Nov 2026)

- Geocode: `GET https://api.openrouteservice.org/geocode/search?api_key=<KEY>&text=<urlencoded>&boundary.country=BE&size=1`
  Response: GeoJSON FeatureCollection. `features[0].geometry.coordinates` is `[lon, lat]`;
  `features[0].properties` has `label`, `confidence` (0..1), `layer` (e.g. `address`, `street`, `venue`,
  `postalcode`, `locality`, `localadmin`, `county`, `region`, `macroregion`). Empty `features` = not found.
- Matrix: `POST https://api.openrouteservice.org/v2/matrix/driving-car`, headers
  `Authorization: <KEY>`, `Content-Type: application/json`, body
  `{ "locations": [[lon,lat], ...], "sources": ["0"], "destinations": ["1","2",...], "metrics": ["duration","distance"], "units": "km" }`.
  Response: `durations[0][i]` seconds, `distances[0][i]` km, `null` when a pair is unroutable.
  Max 3500 source x destination pairs per request: send at most 50 destinations per call.
- Free-plan quotas differ between official pages (roughly 500 to 10,000 per day depending on endpoint,
  about 40 per minute for matrix). Design for few calls: cache every geocode forever, batch matrix calls,
  throttle to one ORS request per 1600 ms. HTTP 401/403 = "invalid key or access denied",
  429 = "ORS rate limit or daily quota reached" (stop this run, retry next scan). Never fail a scan because of ORS.
- Durations are free-flow car times (no traffic). Say "by car, without traffic" in the UI and the prompt.

### 14.2 Shared types and IPC (src/shared)

```ts
export type GeoState = "pending" | "ok" | "approximate" | "not_found" | "error" | "unavailable";
// unavailable = no ORS key or no resolved home; approximate = only a region/province matched

// VacancyListItem: add
travelMinutes: number | null; travelKm: number | null; geoState: GeoState;
// VacancyDetail: add
geoQuery: string; geoLabel: string; geoError: string | null;
// VacancyFilter: add
maxTravelMinutes: number | null;   // rows with KNOWN travel above this are hidden; unknown travel stays visible
sort: "score" | "date" | "distance"; // distance: ascending travelMinutes, unknown last
// Profile: add
homeGeo: { label: string; lat: number; lon: number } | null;
homeGeoError: string | null;
// AppStatus: add
travelConfigured: boolean;          // ORS key stored AND homeGeo resolved
```

RadarApi additions:

```ts
"orsKey.status"(): { configured: boolean; masked: string | null };
"orsKey.set"(key: string): Promise<{ ok: boolean; error: string | null }>; // validates by geocoding "Gent"
"orsKey.clear"(): void;
"travel.recompute"(): Promise<{ updated: number; failed: number }>;       // re-geocode home, (re)compute all non-closed vacancies
```

### 14.3 Storage (migration to user_version 2)

```sql
ALTER TABLE vacancies ADD COLUMN geo_query TEXT NOT NULL DEFAULT '';
ALTER TABLE vacancies ADD COLUMN geo_label TEXT NOT NULL DEFAULT '';
ALTER TABLE vacancies ADD COLUMN geo_lat REAL;
ALTER TABLE vacancies ADD COLUMN geo_lon REAL;
ALTER TABLE vacancies ADD COLUMN geo_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE vacancies ADD COLUMN geo_error TEXT;
ALTER TABLE vacancies ADD COLUMN travel_minutes REAL;
ALTER TABLE vacancies ADD COLUMN travel_km REAL;
ALTER TABLE vacancies ADD COLUMN travel_home_key TEXT;   -- normalized home query the travel was computed for
ALTER TABLE profile ADD COLUMN home_query TEXT NOT NULL DEFAULT '';
ALTER TABLE profile ADD COLUMN home_label TEXT NOT NULL DEFAULT '';
ALTER TABLE profile ADD COLUMN home_lat REAL;
ALTER TABLE profile ADD COLUMN home_lon REAL;
ALTER TABLE profile ADD COLUMN home_error TEXT;
CREATE TABLE geo_cache(query TEXT PRIMARY KEY, found INTEGER NOT NULL, lat REAL, lon REAL,
  label TEXT NOT NULL DEFAULT '', layer TEXT NOT NULL DEFAULT '', confidence REAL, at TEXT NOT NULL);
```

New Store methods: `getGeoCache(query)`, `putGeoCache(entry)`, `setHomeGeo({ query, label, lat, lon } | { query, error })`,
`saveVacancyGeo(id, { query, label, lat, lon, state, error })`, `saveTravel(id, { minutes, km, homeKey })`,
`clearTravel()` (all rows), `vacanciesNeedingGeo(limit)` (non-closed, duplicate_of NULL, geo_state 'pending'),
`vacanciesNeedingTravel(homeKey, limit)` (geo_lat not null, state ok/approximate, travel_home_key IS NOT homeKey, non-closed).
`listVacancies` implements `maxTravelMinutes` and `sort: "distance"`. Cache keys are normalized queries
(lowercase, diacritics kept, whitespace collapsed).

**Fix (existing bug):** `saveDetail` must only fill `organization` / `location` when the current value is empty.
VDAB detail JSON-LD has only the province ("Oost-Vlaanderen") and currently overwrites the listing's town.
`updateIdentity` (after scoring) keeps overwriting with non-empty values, but if it changes `location`,
reset `geo_state` to 'pending' so travel is recomputed for the better location.

### 14.4 Core modules (src/core/geo)

- `ors.ts`: `export type JsonHttp = (url, init: { method: "GET" | "POST"; headers: Record<string,string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; body: string }>`.
  `class OrsClient { constructor(opts: { http: JsonHttp; getKey: () => string | null; minIntervalMs?: 1600; timeoutMs?: 20000; now?; sleep? }); geocode(text): Promise<GeoHit | null>; matrix(origin: LatLon, dests: LatLon[]): Promise<({ minutes: number; km: number } | null)[]> }`
  with `GeoHit = { lat, lon, label, layer, confidence }`, `class OrsError extends Error { status: number | null; kind: "auth" | "quota" | "network" | "bad_response" }`.
  `matrix` splits into chunks of 50 destinations and returns results in input order. Minutes rounded to integers, km to 1 decimal.
- `locate.ts`: `locationQuery(v: { location: string; organization: string }): { query: string; fromOrganization: boolean } | null`.
  Rules: use `location` when non-empty (strip "Provincie ", "Regio ", "Arrondissement " prefixes, uppercase-only text to title case,
  drop text in parentheses). Otherwise derive from `organization` only when confident: take the part after the last " - "
  ("Stad Nieuwpoort - Nieuwpoort" gives "Nieuwpoort", "VGC - Brussel" gives "Brussel"), or strip a known public-body prefix
  ("Lokaal bestuur", "Gemeente", "Stad", "OCMW", "Zorgpunt", "Welzijnsvereniging", "Hulpverleningszone", "Politiezone", "AGB", "Gemeentebestuur", "Stadsbestuur")
  when 1-3 words remain ("Lokaal bestuur Aalst" gives "Aalst"). Anything else returns null (never geocode a vzw name).
  `classifyHit(hit, fromOrganization)`: accept when confidence >= 0.6; `layer` in region/macroregion/county gives "approximate";
  for `fromOrganization` queries require layer locality/localadmin/borough, else treat as not found.
- `travel.ts`: `class TravelService { constructor(deps: { store; ors: OrsClient; orsConfigured: () => boolean; now; log }); ensureHome(): Promise<boolean>; computeFor(ids?: number[]): Promise<{ updated; failed }>; recomputeAll(): Promise<{ updated; failed }> }`.
  `ensureHome` geocodes `preferences.homeLocation` when the stored `home_query` differs or no coords (cache first) and stores the result.
  `computeFor`: if not configured or no home, mark the given pending rows 'unavailable' and return. Else geocode rows needing geo
  (cache first; not found and errors are cached per query too, as `found = 0`), then one batched matrix call for rows needing travel.
  On OrsError kind auth/quota: log once, stop, leave rows pending. Rows whose state is 'unavailable' become 'pending' again once
  ORS is configured (do this at the start of computeFor/recomputeAll). `recomputeAll` = `clearTravel` then ensureHome then compute everything non-closed.
  Never throws to callers except programming errors.
- `formatTravel(v): string` helper in `src/shared/travel.ts` (used by UI and prompt): "34 min by car, 41 km" (prefix "about " when approximate).

### 14.5 Integration

- Scanner: after step 9 (detail fetches), call `travel.computeFor(freshIds)` (catch + log). Also inside `scorePending()` and
  before `scoreOne()` for that row. The scoring queue then sees travel data.
- Scoring prompt: `buildScoringUser` gets an optional `travel` argument. When present add, right after the Location line:
  `Travel from the candidate's home (<home label>): <formatTravel> (car, without traffic; computed by a routing service)`.
  When approximate add "(only the region of the job is known)". Add to SCORING_ROLE (rubric, preferences): "When a Travel line
  is present, use it for the commute part of the preferences subscore instead of estimating from place names. Compare it with the
  candidate's stated maximum commute. Public-transport travel is usually slower than the car time given."
- Service: `profile.save` / `profile.import`: if `homeLocation` changed, `void travel.recomputeAll()` then emit events.
  `orsKey.set`: validate (geocode "Gent" through a temporary OrsClient with the candidate key; map auth errors to
  "Invalid OpenRouteService API key"), store via a second SecretsPort, then `void travel.recomputeAll()`.
  `orsKey.clear`: clear secret, mark non-closed rows 'unavailable' is NOT needed (keep last known travel). `travel.recompute` awaits recomputeAll.
  `app.status.travelConfigured` = ORS key present AND profile.homeGeo not null.
- Main: second `SafeStorageSecrets(userData, "ors-secret.bin")` (generalize the class with a filename parameter); `JsonHttp`
  implemented with `net.fetch`. Pass `orsConfigured: () => orsSecrets.get() !== null`.
- scan-cli: `geo <text>` and `travel <from> <to>` commands using env `ORS_API_KEY` and global fetch.

### 14.6 UI

- Inbox rows: after "organization · location" show a small car icon + "34 min" (title attribute with full `formatTravel`),
  "≈ 50 min" when approximate, nothing when unknown.
- Inbox toolbar: "Max drive" select (Any, 15, 30, 45, 60, 90 min) and "Distance" as a third sort option.
- Detail: line under the location: "34 min by car, 41 km from Gent (without traffic)" plus muted "matched: Lendelede, West-Vlaanderen";
  approximate adds "(region only)"; not_found shows "Could not place “<query>”"; unavailable shows
  "Add an OpenRouteService key and your home location to see travel time" linking to Settings/Profile.
- Profile: under Home location show the resolved label ("Resolved: Gent, Oost-Vlaanderen, BE") or the error, with the hint
  "A street address is more precise than a town."
- Settings: card "Travel time (OpenRouteService)": key input with Save (validates), masked key + Clear, short how-to
  ("Free account at openrouteservice.org, then copy the API key from the dashboard"), "Recompute all travel times" button with result,
  note "Car travel time without traffic. Free plan quotas are enough for normal use."
- Mock: realistic travel data on most vacancies, one approximate, one not_found, one unavailable; orsKey and travel.recompute fakes.

---

## 15. Embedded job widgets and "why nothing?" diagnostics (added 2026-11-09)

Trigger: Zorgnet-Icuro's job page (`test/fixtures/sites/zorgneticuro_list.html`, captured 2026-11-09) holds no vacancies.
It contains `<div id="jbtcls_136_2067_content">` plus `<script src="//www.jobat.be/api/script/jobsitesscripts.js">` and
`jbtClsInit(...)`: a Jobat widget fills the list after load, possibly inside a cross-origin iframe. The renderer missed it because
(a) it serializes only the main document and (b) it stops when `innerText` is stable for 1.5 s, before late widgets arrive.
A local reproduction (architect's harness, two origins: late iframe, iframe from the start, late DOM injection) returns 0 items
for all three variants on the current build. Target: 5 items for each.

### 15.1 Renderer (src/main/electron-render.ts)

- Network-aware settling. Track in-flight requests of the scraper window through the `persist:scraper` session's
  `webRequest.onBeforeRequest` / `onCompleted` / `onErrorOccurred` (filter on `details.webContentsId` of the scraper window; the
  session is dedicated to scraping, so registering these listeners once is fine; always call the callback in onBeforeRequest).
  A page is settled when ALL hold: at least 3000 ms since `did-finish-load`; zero in-flight requests for 1000 ms
  (ignore long-polling: requests open longer than 10 s don't count); the combined text length of all frames unchanged over
  3 polls (500 ms apart). Hard cap 30 s total, then capture whatever is there.
- Frame capture. After settling, for every frame in `webContents.mainFrame.framesInSubtree` (main first), run in that frame:
  rewrite links to absolute (`document.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', a.href))`, same for
  `iframe[src]`), then return `document.documentElement.outerHTML` (main) or `.innerHTML` (child frames).
  Skip child frames whose URL is not http(s), is about:blank, or whose host matches a small denylist of non-content frames
  (googletagmanager.com, google-analytics.com, doubleclick.net, google.com/recaptcha, facebook.com, youtube.com,
  youtube-nocookie.com, vimeo.com, hotjar.com, cookiebot.com, onetrust.com). At most 10 child frames, each truncated to 2 MB.
  Append each included child frame to the main HTML just before `</body>` as
  `<section data-vr-frame-src="<frame url>">…</section>`. Frame failures (detached, timeout) are skipped, never fatal.
- Return type: `PageRenderer.render(url)` becomes `Promise<{ url: string; html: string; frames?: { url: string; included: boolean }[] }>`
  (optional field, backward compatible). List every child frame seen, with `included` false for skipped ones.

### 15.2 Diagnostics (src/core/extract/diagnose.ts + SourceTestResult + scanner)

```ts
export interface PageDiagnostics {
  modeUsed: "static" | "browser";
  visibleTextChars: number;
  linkCount: number;                                  // a[href] in the captured HTML (frames included)
  frames: { url: string; included: boolean }[];       // browser mode only, else []
  embeddedHosts: string[];                            // hosts of iframe[src] and script[src] that differ from the page host,
                                                      // minus a denylist of trackers/CDNs (same list as 15.1 plus cdnjs, jsdelivr,
                                                      // unpkg, googleapis, gstatic, cloudflare, jquery, cookielaw, polyfill.io)
  llmUsed: boolean;                                   // LLM tiers were available and attempted
  hint: string | null;                                // plain-language explanation, only when 0 items
}
export function diagnosePage(input: { html: string; pageUrl: string; modeUsed; frames; llmUsed: boolean; itemCount: number; llmAvailable: boolean }): PageDiagnostics;
```

Hint rules for itemCount 0, first match wins:
1. `visibleTextChars < 300`: "The page is almost empty for an automated visitor. Try Browser mode; the site may also block automated access."
2. embeddedHosts non-empty and modeUsed "static": "This page loads content from <hosts>. Switch the source to Browser mode so that content is included."
3. embeddedHosts non-empty: "Vacancies may come from an embedded service (<hosts>). If they are still missing, add that service's own listing page as a source."
4. `!llmAvailable`: keep the existing "No vacancies found. Add an Anthropic API key so Claude can learn this page's layout." (or the budget variant).
5. llmUsed: "Claude looked at the page and found no individual vacancies on it."
6. otherwise null.

`SourceTestResult` gets `diagnostics: PageDiagnostics` (always present). The scanner computes diagnostics on 0-item scans too and
uses the hint (when not null) as the source's `lastError` and log message, so the Sources table explains failures.
Auto mode: if the static page has embeddedHosts (an iframe or widget script from another host) and yielded 0 items, the existing
fallback to browser mode applies (it already retries on 0 items; keep that).

### 15.3 UI

Source editor Test panel: below the existing stats, a muted diagnostics line
"Text 4,812 chars · 63 links · Frames: www.jobat.be (included), www.googletagmanager.com (skipped)" and, when items are 0 and a
hint exists, the hint in a callout (info style) above the empty preview. Mock: one test URL returns a 0-item result with a Jobat
embedded-service hint, others unchanged.

### 15.4 Seed

Zorgnet-Icuro seed source: renderMode "browser" (was auto) and notes "Vacancies come from an embedded Jobat widget. Use Test before enabling."
Only affects new installs; do not migrate existing rows.

---

## 16. Hosted job portals and seed revisions (added 2026-11-09)

Trigger: the owner asked to add Fiola vzw (`https://fiolavzw.be/vacatures/#vacatures`), whose vacancies live on the
Belgian ATS **Jobtoolz** (`https://fiola-vzw.jobtoolz.com/nl`, detail pages `https://fiola-vzw.jobtoolz.com/nl/<slug>`,
confirmed via web search 2026-11-09). Neither host was reachable from the build sandbox, so the markup is unverified.
Many Flemish social-profit employers use hosted portals (Jobtoolz, Jobat widgets, Recruitee, Homerun, Teamtailor, Starring Jane,
VAIA Talents), so the fix is generic.

### 16.1 Seed revisions (add new recommended sources to existing installs)

- Each seed entry gets `since: number` (existing seeds: 1). Settings key `seedRevision` (number, not in `Settings` type; store via a
  new `Store.getMeta(key)` / `setMeta(key, value)` backed by the settings table under a `meta:` prefix, or a small `meta` table).
- On startup `seedSources(store)`: `rev = meta.seedRevision ?? (sourcesTableEmpty ? 0 : 1)`; insert seeds with `since > rev` whose
  canonical URL is not already present (compare with `canonicalizeUrl`); then `seedRevision = max(since)`. A seed the owner deleted is
  therefore never re-added, and a fresh install gets everything.
- New seed (since 2): name "Fiola vzw (Jobtoolz)", url `https://fiola-vzw.jobtoolz.com/nl`, renderMode "auto", enabled true, no recipe
  (Claude learns the layout on the first scan), notes "Fiola's vacancies are hosted on Jobtoolz; fiolavzw.be/vacatures shows the same list.
  Added 2026-11-09, layout not yet verified: check the first scan."

### 16.2 Known hosted portals in diagnostics

- `src/core/extract/portals.ts`: `KNOWN_PORTALS: { name: string; hostSuffix: string }[]` with Jobtoolz (`jobtoolz.com`),
  Jobat (`jobat.be`), Recruitee (`recruitee.com`), Homerun (`homerun.co`), Teamtailor (`teamtailor.com`), Starring Jane
  (`starringjane.com`), VAIA Talents (`talents.vaia.com`), Personio (`jobs.personio.de`, `jobs.personio.com`), Workable (`apply.workable.com`).
  `findPortals(html, pageUrl): { name: string; host: string; sampleUrl: string }[]` scans `a[href]`, `iframe[src]` and `script[src]`
  (absolute after resolving) for hosts ending in a known suffix that differ from the page host; one entry per host.
- `PageDiagnostics` gains `portals: { name; host; sampleUrl }[]`. New hint rule, inserted BEFORE rule 2 of 15.2 and applied whenever
  portals is non-empty and itemCount is 0 OR every extracted item URL is on the page's own host while portal links exist:
  "Vacancies on this page are hosted on <Name> (<host>). For the most reliable results, add <portal root URL> as a source."
  The portal root URL is `https://<host>/` plus the first path segment of sampleUrl when it is a 2-letter language code
  (e.g. `https://fiola-vzw.jobtoolz.com/nl`).
- UI: when diagnostics.portals is non-empty, the Test panel shows the hint with a button "Add <host> as a source" that pre-fills a new
  source (name = "<page source name or host> (<Portal name>)", url = portal root URL, renderMode auto) in the Source editor.
