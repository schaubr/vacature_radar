import { RobotsCache } from "./robots";
import { tEn, type Translator } from "../../shared/i18n";

export interface RawResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}
export type RawFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<RawResponse>;

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Safari/537.36 VacatureRadar/1.0 (personal job monitor)";

export class FetchError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "FetchError";
    this.status = status;
  }
}

export interface PoliteFetcherOptions {
  minIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWarn?: (message: string) => void;
  /** Translator for error and warning texts, resolved at call time (default English). */
  t?: Translator;
}

const HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.7",
};

export class PoliteFetcher {
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lastStart = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly robots: RobotsCache;
  private readonly translator: () => Translator;

  constructor(
    private readonly raw: RawFetch,
    opts: PoliteFetcherOptions = {},
  ) {
    this.translator = () => opts.t ?? tEn;
    this.minIntervalMs = opts.minIntervalMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.robots = new RobotsCache(
      async (robotsUrl) => {
        const res = await this.request(robotsUrl);
        return { status: res.status, body: res.body };
      },
      { now: this.now, userAgent: "VacatureRadar", onWarn: opts.onWarn, t: opts.t },
    );
  }

  /** Waits until a request to this URL's host is allowed, and books the slot. */
  throttle(url: string): Promise<void> {
    return this.schedule(hostOf(url), async () => {
      await this.waitTurn(hostOf(url));
    });
  }

  async fetch(url: string): Promise<RawResponse> {
    const res = await this.schedule(hostOf(url), async () => {
      await this.waitTurn(hostOf(url));
      return this.rawWithTimeout(url);
    });
    if (res.status >= 400) throw new FetchError(this.translator()("fetch.http", { status: res.status, url }), res.status);
    return res;
  }

  isAllowed(url: string): Promise<boolean> {
    return this.robots.isAllowed(url);
  }

  /** Throttled request that does not throw on HTTP status (used for robots.txt). */
  private request(url: string): Promise<RawResponse> {
    return this.schedule(hostOf(url), async () => {
      await this.waitTurn(hostOf(url));
      return this.rawWithTimeout(url);
    });
  }

  private async rawWithTimeout(url: string): Promise<RawResponse> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
        reject(new FetchError(this.translator()("fetch.timeout", { ms: this.timeoutMs, url }), null));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.raw(url, { headers: { ...HEADERS }, signal: ctrl.signal }), timeout]);
    } catch (e) {
      if (e instanceof FetchError) throw e;
      if (timedOut) throw new FetchError(this.translator()("fetch.timeout", { ms: this.timeoutMs, url }), null);
      throw new FetchError(this.translator()("fetch.network", { url, error: e instanceof Error ? e.message : String(e) }), null);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async waitTurn(host: string): Promise<void> {
    const last = this.lastStart.get(host);
    if (last !== undefined) {
      const wait = last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart.set(host, this.now());
  }

  private schedule<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(
      host,
      run.catch(() => undefined),
    );
    return run;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
