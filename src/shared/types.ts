export type RenderMode = "auto" | "static" | "browser";
export type ExtractStrategy = "feed" | "jsonld" | "recipe" | "llm";
export type SourceStatus = "ok" | "empty" | "error" | "never";
export type VacancyStatus = "new" | "seen" | "interested" | "applied" | "dismissed" | "closed";
export type Bucket = "strong" | "possible" | "weak" | "knockout";
export type Feedback = "up" | "down";
export type ModelId = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
export type Effort = "low" | "medium" | "high";
export type OutputLanguage = "en" | "nl";
export type GeoState = "pending" | "ok" | "approximate" | "not_found" | "error" | "unavailable";
export type LlmPurpose = "score" | "learn_recipe" | "extract_listing" | "profile_import";

export interface Recipe {
  itemSelector: string; // CSS selector for each vacancy card in the listing
  titleSelector: string; // relative to item; "" = item text
  linkSelector: string; // relative to item; "" = item itself (an <a>) or first a[href] inside
  organizationSelector: string; // "" if unknown
  locationSelector: string; // "" if unknown
  dateSelector: string; // "" if unknown
  nextPageSelector: string; // absolute selector on page for the "next page" link, "" if none
}

export interface Source {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  renderMode: RenderMode;
  detectedMode: "static" | "browser" | null; // what "auto" resolved to last time
  scanIntervalHours: number | null; // null = use global setting
  maxPages: number; // 1..5, default 1
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
  lastScanAt: string | null; // ISO
  lastSuccessAt: string | null;
  lastStatus: SourceStatus;
  lastError: string | null;
  lastFound: number; // items found in last scan
  lastPageHash: string | null;
  consecutiveFailures: number;
  notes: string;
  createdAt: string;
}

export interface SourceInput {
  name: string;
  url: string;
  enabled: boolean;
  renderMode: RenderMode;
  scanIntervalHours: number | null;
  maxPages: number;
  notes: string;
}

export interface ListingItem {
  // what extraction yields per vacancy on a listing page
  title: string;
  url: string; // absolute, canonicalized
  organization: string;
  location: string;
  dateText: string;
  snippet: string; // card text, max 400 chars
}

export interface VacancyFields {
  // structured fields produced by the scoring call
  summary: string;
  sector: string;
  isSocialSector: boolean;
  hours: string;
  contract: string;
  diplomaRequired: string;
  experienceRequired: string;
  payScale: string;
  deadline: string;
}

export interface ScoreResult {
  score: number; // 0..100 integer, clamped in code
  bucket: Bucket;
  subscores: { diploma: number; experience: number; skills: number; preferences: number };
  reasons: string[];
  gaps: string[];
  knockoutReason: string; // "" if none
  confidence: "high" | "medium" | "low";
}

export interface VacancyListItem {
  id: number;
  sourceId: number;
  sourceName: string;
  title: string;
  organization: string;
  location: string;
  url: string;
  status: VacancyStatus;
  score: number | null;
  bucket: Bucket | null;
  firstSeenAt: string;
  deadline: string;
  feedback: Feedback | null;
  scoreState: "scored" | "pending" | "filtered" | "error" | "skipped";
  duplicateCount: number; // how many other vacancies point to this one as duplicate_of
  travelMinutes: number | null; // driving time from home, free-flow
  travelKm: number | null;
  geoState: GeoState;
}

export interface VacancyDetail extends VacancyListItem {
  description: string; // detail text
  snippet: string;
  fields: VacancyFields | null;
  scoreResult: ScoreResult | null;
  scoreModel: string | null;
  scoredAt: string | null;
  scoreError: string | null;
  prefilterReason: string | null; // why it was filtered out, if it was
  feedbackNote: string;
  duplicates: { id: number; url: string; sourceName: string }[];
  lastSeenAt: string;
  geoQuery: string;
  geoLabel: string;
  geoError: string | null;
}

export interface VacancyFilter {
  statuses: VacancyStatus[]; // empty = all except "closed" and "dismissed"
  minScore: number | null;
  sourceId: number | null;
  search: string; // matches title/organization/location, case-insensitive
  includeUnscored: boolean;
  maxTravelMinutes: number | null; // rows with KNOWN travel above this are hidden; unknown travel stays visible
  sort: "score" | "date" | "distance"; // distance: ascending travelMinutes, unknown last
}

export interface VacancyCounts {
  new: number;
  interested: number;
  applied: number;
  strongNew: number;
  total: number;
}

export interface Preferences {
  homeLocation: string; // e.g. "Gent"
  maxCommute: string; // free text, e.g. "max 45 min by train or 40 km"
  regions: string; // free text, e.g. "Oost-Vlaanderen, Brussel"
  hours: "any" | "fulltime" | "parttime";
  contractTypes: string[]; // subset of ["permanent","temporary","replacement","freelance"]
  desiredRoles: string;
  ambitions: string;
  dealBreakers: string;
  salaryNotes: string;
  includeKeywords: string[]; // prefilter: if non-empty, title+snippet must contain one
  excludeKeywords: string[]; // prefilter: title must contain none
}

export interface Profile {
  markdown: string; // the candidate profile text used in prompts
  preferences: Preferences;
  version: number; // increments on every save
  importedFrom: "linkedin_zip" | "linkedin_pdf" | "manual" | null;
  updatedAt: string | null;
  homeGeo: { label: string; lat: number; lon: number } | null;
  homeGeoError: string | null;
}

export interface Settings {
  scanIntervalHours: number; // default 6
  notificationsEnabled: boolean; // default true
  notifyThreshold: number; // default 70
  scoringModel: ModelId; // default "claude-opus-5-5"
  utilityModel: ModelId; // default "claude-sonnet-5-5" (recipes, extraction, PDF import)
  effort: Effort; // default "low"
  outputLanguage: OutputLanguage; // default "en"
  monthlyBudgetUsd: number; // default 5
  maxNewScoredPerScan: number; // default 25, per source per scan
  closeAfterMissedScans: number; // default 3
  launchAtLogin: boolean; // default true
}

/** Facts about a fetched page, plus a plain-language reason when it yielded no vacancies. */
export interface PageDiagnostics {
  modeUsed: "static" | "browser";
  visibleTextChars: number;
  linkCount: number;
  frames: { url: string; included: boolean }[];
  embeddedHosts: string[];
  llmUsed: boolean;
  hint: string | null;
}

export interface SourceTestResult {
  ok: boolean;
  error: string | null;
  modeUsed: "static" | "browser";
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
  items: ListingItem[]; // first 50
  robotsAllowed: boolean;
  llmCostUsd: number;
  diagnostics: PageDiagnostics;
}

export interface UsageSummary {
  monthUsd: number;
  budgetUsd: number;
  budgetExceeded: boolean;
  byPurpose: { purpose: LlmPurpose; usd: number; calls: number }[];
  last30Days: { day: string; usd: number }[];
}

export interface LogEntry {
  id: number;
  at: string;
  sourceId: number | null;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AppStatus {
  scanning: boolean;
  currentSourceId: number | null;
  queueLength: number;
  nextScanAt: string | null;
  apiKeyConfigured: boolean;
  budgetExceeded: boolean;
  profileReady: boolean; // profile markdown non-empty
  travelConfigured: boolean; // ORS key stored AND homeGeo resolved
}

export const DEFAULT_SETTINGS: Settings = {
  scanIntervalHours: 6,
  notificationsEnabled: true,
  notifyThreshold: 70,
  scoringModel: "claude-opus-5-5",
  utilityModel: "claude-sonnet-5-5",
  effort: "low",
  outputLanguage: "en",
  monthlyBudgetUsd: 5,
  maxNewScoredPerScan: 25,
  closeAfterMissedScans: 3,
  launchAtLogin: true,
};

export const DEFAULT_PREFERENCES: Preferences = {
  homeLocation: "",
  maxCommute: "",
  regions: "",
  hours: "any",
  contractTypes: [],
  desiredRoles: "",
  ambitions: "",
  dealBreakers: "",
  salaryNotes: "",
  includeKeywords: [],
  excludeKeywords: [],
};
