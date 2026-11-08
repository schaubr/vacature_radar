import type {
  AppStatus,
  Feedback,
  LogEntry,
  Preferences,
  Profile,
  RenderMode,
  Settings,
  Source,
  SourceInput,
  SourceTestResult,
  UsageSummary,
  VacancyCounts,
  VacancyDetail,
  VacancyFilter,
  VacancyListItem,
  VacancyStatus,
} from "./types";

export interface RadarApi {
  "sources.list"(): Source[];
  "sources.create"(input: SourceInput): Source;
  "sources.update"(id: number, patch: Partial<SourceInput>): Source;
  "sources.delete"(id: number): void; // also deletes its vacancies
  "sources.test"(input: { url: string; renderMode: RenderMode; maxPages: number }): Promise<SourceTestResult>;
  "sources.resetRecipe"(id: number): Source; // clears recipe+strategy so next scan relearns
  "scan.now"(sourceId: number | null): void; // null = all enabled; returns immediately
  "vacancies.list"(filter: VacancyFilter): VacancyListItem[];
  "vacancies.get"(id: number): VacancyDetail | null; // marks status new -> seen
  "vacancies.setStatus"(id: number, status: VacancyStatus): void;
  "vacancies.setFeedback"(id: number, feedback: Feedback | null, note: string): void;
  "vacancies.rescore"(id: number): Promise<void>;
  "vacancies.openExternal"(id: number): void;
  "vacancies.counts"(): VacancyCounts;
  "profile.get"(): Profile;
  "profile.save"(input: { markdown: string; preferences: Preferences }): Profile;
  "profile.import"(): Promise<Profile | null>; // main shows file dialog (.zip or .pdf); null if cancelled
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
  navigate: { view: "inbox" | "sources" | "profile" | "settings" | "activity"; vacancyId?: number };
}

/** What the preload exposes as `window.radar`. */
export interface RadarBridge {
  invoke<K extends keyof RadarApi>(
    method: K,
    ...args: Parameters<RadarApi[K]>
  ): Promise<Awaited<ReturnType<RadarApi[K]>>>;
  on<E extends keyof RadarEvents>(event: E, cb: (payload: RadarEvents[E]) => void): () => void;
}

// Typed as a Record so the compiler fails if a RadarApi key is missing here.
const METHOD_KEYS: Record<keyof RadarApi, true> = {
  "sources.list": true,
  "sources.create": true,
  "sources.update": true,
  "sources.delete": true,
  "sources.test": true,
  "sources.resetRecipe": true,
  "scan.now": true,
  "vacancies.list": true,
  "vacancies.get": true,
  "vacancies.setStatus": true,
  "vacancies.setFeedback": true,
  "vacancies.rescore": true,
  "vacancies.openExternal": true,
  "vacancies.counts": true,
  "profile.get": true,
  "profile.save": true,
  "profile.import": true,
  "settings.get": true,
  "settings.save": true,
  "apiKey.status": true,
  "apiKey.set": true,
  "apiKey.clear": true,
  "usage.summary": true,
  "log.list": true,
  "app.status": true,
};

export const RADAR_METHODS = Object.keys(METHOD_KEYS) as (keyof RadarApi)[];
