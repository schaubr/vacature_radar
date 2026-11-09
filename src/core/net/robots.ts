import robotsParser from "robots-parser";
import { tEn, type Translator } from "../../shared/i18n";

export interface RobotsLoadResult {
  status: number;
  body: string;
}

export interface RobotsCacheOptions {
  ttlMs?: number; // default 24 h
  now?: () => number;
  userAgent?: string; // robots.txt product token
  onWarn?: (message: string) => void;
  t?: Translator;
}

type Robots = ReturnType<typeof robotsParser>;
interface Entry {
  at: number;
  robots: Robots | null; // null = everything allowed
}

/**
 * robots.txt cache per origin. `load` fetches the robots.txt URL and returns status + body, or throws
 * on network errors. Missing (4xx), unreachable or 5xx robots.txt means "allowed".
 */
export class RobotsCache {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly onWarn: (message: string) => void;
  private readonly opts: RobotsCacheOptions;

  private get t(): Translator {
    return this.opts.t ?? tEn;
  }

  constructor(
    private readonly load: (robotsUrl: string) => Promise<RobotsLoadResult>,
    opts: RobotsCacheOptions = {},
  ) {
    this.opts = opts;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.userAgent = opts.userAgent ?? "VacatureRadar";
    this.onWarn = opts.onWarn ?? (() => {});
  }

  async isAllowed(url: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return true;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const entry = await this.entryFor(u.origin);
    if (!entry.robots) return true;
    return entry.robots.isAllowed(url, this.userAgent) !== false;
  }

  private async entryFor(origin: string): Promise<Entry> {
    const cached = this.cache.get(origin);
    if (cached && this.now() - cached.at < this.ttlMs) return cached;
    let p = this.pending.get(origin);
    if (!p) {
      p = this.fetchEntry(origin).finally(() => this.pending.delete(origin));
      this.pending.set(origin, p);
    }
    return p;
  }

  private async fetchEntry(origin: string): Promise<Entry> {
    const robotsUrl = origin + "/robots.txt";
    let robots: Robots | null = null;
    try {
      const res = await this.load(robotsUrl);
      if (res.status >= 200 && res.status < 300) {
        robots = robotsParser(robotsUrl, res.body);
      } else if (res.status >= 500) {
        this.onWarn(this.t("robots.status", { origin, status: res.status }));
      }
    } catch (e) {
      this.onWarn(this.t("robots.unreachable", { origin, error: e instanceof Error ? e.message : String(e) }));
    }
    const entry = { at: this.now(), robots };
    this.cache.set(origin, entry);
    return entry;
  }
}
