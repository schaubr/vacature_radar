import type { Store } from "../db/store";
import type { ScanService } from "./scanner";

export interface SchedulerOptions {
  store: Store;
  scanner: Pick<ScanService, "scanMany">;
  now: () => Date;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  initialDelayMs?: number; // default 10 s
  tickMs?: number; // default 60 s
}

const HOUR_MS = 3_600_000;

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initial: ReturnType<typeof setTimeout> | null = null;
  private readonly si: typeof setInterval;
  private readonly ci: typeof clearInterval;
  private readonly st: typeof setTimeout;
  private readonly ct: typeof clearTimeout;

  constructor(private readonly opts: SchedulerOptions) {
    this.si = opts.setInterval ?? setInterval;
    this.ci = opts.clearInterval ?? clearInterval;
    this.st = opts.setTimeout ?? setTimeout;
    this.ct = opts.clearTimeout ?? clearTimeout;
  }

  start(): void {
    if (this.timer || this.initial) return;
    this.initial = this.st(() => {
      this.initial = null;
      void this.tick();
    }, this.opts.initialDelayMs ?? 10_000);
    this.timer = this.si(() => void this.tick(), this.opts.tickMs ?? 60_000);
    // Never keep the process alive just for the scheduler.
    (this.initial as { unref?: () => void }).unref?.();
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.initial) this.ct(this.initial);
    if (this.timer) this.ci(this.timer);
    this.initial = null;
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      const due = this.dueSources(this.opts.now());
      if (due.length > 0) await this.opts.scanner.scanMany(due);
    } catch (e) {
      try {
        this.opts.store.log("error", `Scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
      } catch {
        /* store closed */
      }
    }
  }

  private dueAt(s: { lastScanAt: string | null; scanIntervalHours: number | null }, globalHours: number): number {
    if (!s.lastScanAt) return Number.NEGATIVE_INFINITY;
    const last = Date.parse(s.lastScanAt);
    if (Number.isNaN(last)) return Number.NEGATIVE_INFINITY;
    return last + (s.scanIntervalHours ?? globalHours) * HOUR_MS;
  }

  dueSources(now: Date): number[] {
    const global = this.opts.store.getSettings().scanIntervalHours;
    return this.opts.store
      .listSources()
      .filter((s) => s.enabled && this.dueAt(s, global) <= now.getTime())
      .map((s) => s.id);
  }

  nextScanAt(now: Date): string | null {
    const global = this.opts.store.getSettings().scanIntervalHours;
    let best: number | null = null;
    for (const s of this.opts.store.listSources()) {
      if (!s.enabled) continue;
      const t = Math.max(this.dueAt(s, global), now.getTime());
      if (best === null || t < best) best = t;
    }
    return best === null ? null : new Date(best).toISOString();
  }

  onResume(): void {
    void this.tick();
  }
}
