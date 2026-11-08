import Anthropic from "@anthropic-ai/sdk";
import type { RadarApi, RadarEvents } from "../shared/ipc";
import type {
  AppStatus,
  Feedback,
  Preferences,
  Profile,
  RenderMode,
  Settings,
  Source,
  SourceInput,
  VacancyFilter,
  VacancyStatus,
} from "../shared/types";
import type { Store } from "./db/store";
import type { LlmClient } from "./llm/client";
import { linkedinPdfToMarkdown } from "./profile/linkedin-pdf";
import { linkedinZipToMarkdown } from "./profile/linkedin-zip";
import type { ScanService } from "./scan/scanner";
import type { Scheduler } from "./scan/scheduler";

export interface SecretsPort {
  get(): string | null;
  set(key: string): void;
  clear(): void;
  /** Optional: false when secure storage cannot be used on this system. */
  available?(): boolean;
}

export interface ShellPort {
  openExternal(url: string): void;
  pickImportFile(): Promise<{ path: string; data: Uint8Array } | null>;
}

export interface ServiceDeps {
  store: Store;
  scanner: ScanService;
  scheduler: Scheduler;
  llm: LlmClient | null;
  secrets: SecretsPort;
  shell: ShellPort;
  now: () => Date;
  emit: <E extends keyof RadarEvents>(event: E, payload: RadarEvents[E]) => void;
  /** Called after settings.save with the merged settings (main applies launchAtLogin here). */
  onSettingsChanged?: (settings: Settings, patch: Partial<Settings>) => void;
  /** Resolves when the key is valid, throws otherwise. Default: a tiny models.list call. */
  validateKey?: (key: string) => Promise<void>;
}

export async function defaultValidateKey(key: string): Promise<void> {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Invalid API key");
    throw e;
  }
}

function maskKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

const SECURE_STORAGE_ERROR = "Secure storage is not available on this system";

export class RadarService implements RadarApi {
  private readonly validateKey: (key: string) => Promise<void>;

  constructor(private readonly d: ServiceDeps) {
    this.validateKey = d.validateKey ?? defaultValidateKey;
    d.scanner.setStatusListener(() => this.emitStatus());
  }

  // ---------- events ----------

  /** Composes the AppStatus (also used by the tray). */
  computeStatus(): AppStatus {
    const { store, scanner, scheduler, secrets, now } = this.d;
    const s = scanner.status;
    const settings = store.getSettings();
    return {
      scanning: s.scanning,
      currentSourceId: s.currentSourceId,
      queueLength: s.queueLength,
      nextScanAt: scheduler.nextScanAt(now()),
      apiKeyConfigured: secrets.get() !== null,
      budgetExceeded: store.monthUsageUsd(now()) >= settings.monthlyBudgetUsd,
      profileReady: store.getProfile().markdown.trim().length > 0,
    };
  }

  emitStatus(): void {
    try {
      this.d.emit("app.status", this.computeStatus());
    } catch {
      /* store closed during shutdown */
    }
  }

  private sourcesChanged(): void {
    this.d.emit("sources.changed", {});
  }
  private vacanciesChanged(newIds: number[] = []): void {
    this.d.emit("vacancies.changed", { newIds });
  }

  // ---------- sources ----------

  "sources.list"(): Source[] {
    return this.d.store.listSources();
  }

  "sources.create"(input: SourceInput): Source {
    const s = this.d.store.createSource(input);
    this.sourcesChanged();
    this.emitStatus();
    return s;
  }

  "sources.update"(id: number, patch: Partial<SourceInput>): Source {
    const before = this.d.store.getSource(id);
    if (!before) throw new Error("Source not found");
    let s = this.d.store.updateSource(id, patch);
    if (patch.url !== undefined && patch.url !== before.url) {
      // A different page: everything learned about the old one is void.
      s = this.d.store.updateSourceRuntime(id, { recipe: null, strategy: null, lastPageHash: null, detectedMode: null });
    } else if (patch.renderMode !== undefined && patch.renderMode !== before.renderMode) {
      s = this.d.store.updateSourceRuntime(id, { detectedMode: null });
    }
    this.sourcesChanged();
    this.emitStatus();
    return s;
  }

  "sources.delete"(id: number): void {
    this.d.store.deleteSource(id); // vacancies cascade
    this.sourcesChanged();
    this.vacanciesChanged();
    this.emitStatus();
  }

  "sources.test"(input: { url: string; renderMode: RenderMode; maxPages: number }) {
    return this.d.scanner.testSource(input);
  }

  "sources.resetRecipe"(id: number): Source {
    const s = this.d.store.updateSourceRuntime(id, { recipe: null, strategy: null, lastPageHash: null });
    this.sourcesChanged();
    return s;
  }

  "scan.now"(sourceId: number | null): void {
    const ids =
      sourceId === null
        ? this.d.store
            .listSources()
            .filter((s) => s.enabled)
            .map((s) => s.id)
        : [sourceId];
    void this.d.scanner.scanMany(ids);
    this.emitStatus();
  }

  // ---------- vacancies ----------

  "vacancies.list"(filter: VacancyFilter) {
    return this.d.store.listVacancies(filter);
  }

  "vacancies.get"(id: number) {
    let v = this.d.store.getVacancyDetail(id);
    if (v && v.status === "new") {
      this.d.store.setStatus(id, "seen");
      v = this.d.store.getVacancyDetail(id);
      this.vacanciesChanged();
    }
    return v;
  }

  "vacancies.setStatus"(id: number, status: VacancyStatus): void {
    this.d.store.setStatus(id, status);
    this.vacanciesChanged();
  }

  "vacancies.setFeedback"(id: number, feedback: Feedback | null, note: string): void {
    this.d.store.setFeedback(id, feedback, note);
    this.vacanciesChanged();
  }

  async "vacancies.rescore"(id: number): Promise<void> {
    try {
      await this.d.scanner.scoreOne(id);
    } finally {
      this.vacanciesChanged();
      this.emitStatus();
    }
  }

  "vacancies.openExternal"(id: number): void {
    const v = this.d.store.getVacancy(id);
    if (v) this.d.shell.openExternal(v.url);
  }

  "vacancies.counts"() {
    return this.d.store.countVacancies(this.d.store.getSettings().notifyThreshold);
  }

  // ---------- profile ----------

  "profile.get"(): Profile {
    return this.d.store.getProfile();
  }

  "profile.save"(input: { markdown: string; preferences: Preferences }): Profile {
    const current = this.d.store.getProfile();
    const p = this.d.store.saveProfile({ ...input, importedFrom: current.importedFrom ?? "manual" });
    this.emitStatus();
    return p;
  }

  async "profile.import"(): Promise<Profile | null> {
    const file = await this.d.shell.pickImportFile();
    if (!file) return null;
    const lower = file.path.toLowerCase();
    let markdown: string;
    let importedFrom: Profile["importedFrom"];
    if (lower.endsWith(".zip")) {
      markdown = linkedinZipToMarkdown(file.data);
      importedFrom = "linkedin_zip";
    } else if (lower.endsWith(".pdf")) {
      if (!this.d.llm || this.d.secrets.get() === null) {
        throw new Error("Importing a PDF needs an Anthropic API key. Add one in Settings first.");
      }
      markdown = await linkedinPdfToMarkdown(this.d.llm, this.d.store.getSettings(), file.data);
      importedFrom = "linkedin_pdf";
    } else {
      throw new Error("Unsupported file type. Choose the LinkedIn data export (.zip) or a profile PDF.");
    }
    if (!markdown.trim()) throw new Error("The file did not contain any profile text");
    const p = this.d.store.saveProfile({
      markdown,
      preferences: this.d.store.getProfile().preferences,
      importedFrom,
    });
    this.emitStatus();
    return p;
  }

  // ---------- settings / key ----------

  "settings.get"(): Settings {
    return this.d.store.getSettings();
  }

  "settings.save"(patch: Partial<Settings>): Settings {
    const merged = this.d.store.saveSettings(patch);
    try {
      this.d.onSettingsChanged?.(merged, patch);
    } catch (e) {
      this.d.store.log("warn", `Applying settings failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.emitStatus();
    return merged;
  }

  "apiKey.status"(): { configured: boolean; masked: string | null } {
    const k = this.d.secrets.get();
    return { configured: k !== null, masked: k ? maskKey(k) : null };
  }

  async "apiKey.set"(key: string): Promise<{ ok: boolean; error: string | null }> {
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, error: "Enter an API key" };
    if (this.d.secrets.available && !this.d.secrets.available()) return { ok: false, error: SECURE_STORAGE_ERROR };
    try {
      await this.validateKey(trimmed);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      this.d.secrets.set(trimmed);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : SECURE_STORAGE_ERROR };
    }
    this.emitStatus();
    return { ok: true, error: null };
  }

  "apiKey.clear"(): void {
    this.d.secrets.clear();
    this.emitStatus();
  }

  // ---------- misc ----------

  "usage.summary"() {
    const settings = this.d.store.getSettings();
    return this.d.store.usageSummary(this.d.now(), settings.monthlyBudgetUsd);
  }

  "log.list"(limit: number) {
    return this.d.store.listLog(limit);
  }

  "app.status"(): AppStatus {
    return this.computeStatus();
  }
}
