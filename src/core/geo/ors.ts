/** Minimal OpenRouteService client (geocode + driving matrix). Contract: DESIGN.md 14.1. */

export type JsonHttp = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; body: string }>;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface GeoHit extends LatLon {
  label: string;
  layer: string;
  confidence: number;
}

export type OrsErrorKind = "auth" | "quota" | "network" | "bad_response";

export class OrsError extends Error {
  constructor(
    message: string,
    public readonly kind: OrsErrorKind,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OrsError";
  }
}

export interface OrsOptions {
  http: JsonHttp;
  getKey: () => string | null;
  minIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const BASE = "https://api.openrouteservice.org";
export const MATRIX_CHUNK = 50;

export class OrsClient {
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastStart = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: OrsOptions) {
    this.minIntervalMs = o.minIntervalMs ?? 1600;
    this.timeoutMs = o.timeoutMs ?? 20_000;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async geocode(text: string): Promise<GeoHit | null> {
    const key = this.requireKey();
    const url =
      `${BASE}/geocode/search?api_key=${encodeURIComponent(key)}` +
      `&text=${encodeURIComponent(text)}&boundary.country=BE&size=1`;
    const json = await this.request(url, { method: "GET", headers: { Accept: "application/json" } });
    const features = (json as { features?: unknown })?.features;
    if (!Array.isArray(features)) throw new OrsError("Unexpected geocode response", "bad_response");
    if (features.length === 0) return null;
    const f = features[0] as {
      geometry?: { coordinates?: unknown };
      properties?: { label?: unknown; confidence?: unknown; layer?: unknown };
    };
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") {
      throw new OrsError("Unexpected geocode response", "bad_response");
    }
    const p = f.properties ?? {};
    return {
      lon: c[0],
      lat: c[1],
      label: typeof p.label === "string" ? p.label : "",
      layer: typeof p.layer === "string" ? p.layer : "",
      confidence: typeof p.confidence === "number" ? p.confidence : 0,
    };
  }

  /** Driving time/distance from origin to each destination, in input order; null where unroutable. */
  async matrix(origin: LatLon, dests: LatLon[]): Promise<({ minutes: number; km: number } | null)[]> {
    const key = this.requireKey();
    const out: ({ minutes: number; km: number } | null)[] = [];
    for (let i = 0; i < dests.length; i += MATRIX_CHUNK) {
      const chunk = dests.slice(i, i + MATRIX_CHUNK);
      const body = {
        locations: [[origin.lon, origin.lat], ...chunk.map((d) => [d.lon, d.lat])],
        sources: ["0"],
        destinations: chunk.map((_, j) => String(j + 1)),
        metrics: ["duration", "distance"],
        units: "km",
      };
      const json = (await this.request(`${BASE}/v2/matrix/driving-car`, {
        method: "POST",
        headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      })) as { durations?: (number | null)[][]; distances?: (number | null)[][] };
      const dur = json?.durations?.[0];
      const dist = json?.distances?.[0];
      if (!Array.isArray(dur) || !Array.isArray(dist) || dur.length !== chunk.length || dist.length !== chunk.length) {
        throw new OrsError("Unexpected matrix response", "bad_response");
      }
      for (let j = 0; j < chunk.length; j++) {
        const s = dur[j];
        const k = dist[j];
        if (typeof s !== "number" || typeof k !== "number") out.push(null);
        else out.push({ minutes: Math.round(s / 60), km: Math.round(k * 10) / 10 });
      }
    }
    return out;
  }

  private requireKey(): string {
    const k = this.o.getKey();
    if (!k) throw new OrsError("No OpenRouteService API key configured", "auth");
    return k;
  }

  /** Serialized and throttled: one request per minIntervalMs, in call order. */
  private request(
    url: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let res: { status: number; body: string };
      try {
        const timeout = new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            ctrl.abort();
            rej(new Error("timeout"));
          }, this.timeoutMs);
        });
        res = await Promise.race([this.o.http(url, { ...init, signal: ctrl.signal }), timeout]);
      } catch (e) {
        throw new OrsError(
          `Could not reach OpenRouteService: ${e instanceof Error ? e.message : String(e)}`,
          "network",
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status === 401 || res.status === 403) {
        throw new OrsError("Invalid OpenRouteService API key or access denied", "auth", res.status);
      }
      if (res.status === 429) {
        throw new OrsError("OpenRouteService rate limit or daily quota reached", "quota", res.status);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new OrsError(`OpenRouteService returned HTTP ${res.status}`, "bad_response", res.status);
      }
      try {
        return JSON.parse(res.body);
      } catch {
        throw new OrsError("OpenRouteService returned invalid JSON", "bad_response", res.status);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
