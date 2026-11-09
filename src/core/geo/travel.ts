import type { Store, VacancyRow } from "../db/store";
import { normalizeGeoQuery } from "../db/store";
import { classifyHit, locationQuery } from "./locate";
import { OrsError, type GeoHit, type OrsClient } from "./ors";
import { tEn, type Translator } from "../../shared/i18n";

export interface TravelDeps {
  store: Store;
  ors: OrsClient;
  orsConfigured: () => boolean;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Translator for log lines and stored error texts, resolved at call time (default English). */
  t?: Translator;
}

export interface TravelResult {
  updated: number;
  failed: number;
}

type HomeOutcome = "ok" | "none" | "error";

const BATCH = 200;

export class TravelService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: TravelDeps) {}

  private get t(): Translator {
    return this.d.t ?? tEn;
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    try {
      this.d.log?.(level, msg);
    } catch {
      /* ignore */
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Geocodes preferences.homeLocation when needed and stores the result. True when a home is resolved. */
  async ensureHome(): Promise<boolean> {
    return (await this.resolveHome(false)) === "ok";
  }

  private async resolveHome(force: boolean): Promise<HomeOutcome> {
    const { store, ors } = this.d;
    const query = normalizeGeoQuery(store.getProfile().preferences.homeLocation);
    if (!query) {
      if (store.getHomeQuery() !== "" || store.getProfile().homeGeo) store.setHomeGeo({ query: "", error: "" });
      return "none";
    }
    const profile = store.getProfile();
    if (!force && store.getHomeQuery() === query) return profile.homeGeo ? "ok" : "none";

    let hit: Pick<GeoHit, "lat" | "lon" | "label" | "layer" | "confidence"> | null | undefined;
    const cached = force ? null : store.getGeoCache(query);
    if (cached) {
      hit = cached.found && cached.lat !== null && cached.lon !== null
        ? { lat: cached.lat, lon: cached.lon, label: cached.label, layer: cached.layer, confidence: cached.confidence ?? 0 }
        : null;
    } else {
      if (!this.d.orsConfigured()) {
        // query "" marks "not resolved yet", so the next call retries once a key exists
        store.setHomeGeo({ query: "", error: "" });
        return "none";
      }
      try {
        const g = await ors.geocode(query);
        hit = g;
        store.putGeoCache({
          query,
          found: g !== null,
          lat: g?.lat ?? null,
          lon: g?.lon ?? null,
          label: g?.label ?? "",
          layer: g?.layer ?? "",
          confidence: g?.confidence ?? null,
          at: this.d.now?.().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log("warn", this.t("geo.homeLookupFailed", { error: msg }));
        store.setHomeGeo({ query: "", error: msg });
        return e instanceof OrsError ? "error" : "none";
      }
    }
    if (!hit || classifyHit(hit, false) === "not_found") {
      store.setHomeGeo({ query, error: this.t("geo.homeNotFound", { query: store.getProfile().preferences.homeLocation.trim() }) });
      return "none";
    }
    store.setHomeGeo({ query, label: hit.label, lat: hit.lat, lon: hit.lon });
    return "ok";
  }

  computeFor(ids?: number[]): Promise<TravelResult> {
    return this.serial(() => this.computeInner(ids, false));
  }

  recomputeAll(): Promise<TravelResult> {
    return this.serial(async () => {
      this.d.store.clearTravel();
      this.d.store.resetGeoState(["unavailable", "error"]);
      return this.computeInner(undefined, true);
    });
  }

  private async computeInner(ids: number[] | undefined, forceHome: boolean): Promise<TravelResult> {
    const { store } = this.d;
    const result: TravelResult = { updated: 0, failed: 0 };
    try {
      if (ids && ids.length === 0) return result;
      let home: HomeOutcome = "none";
      if (this.d.orsConfigured()) {
        home = await this.resolveHome(forceHome);
        if (home === "error") return result; // auth/quota/network: leave everything pending
      }
      const profile = store.getProfile();
      if (home !== "ok" || !profile.homeGeo) {
        const rows = store.vacanciesNeedingGeo(100_000, ids);
        store.setGeoState(rows.map((r) => r.id), "unavailable");
        return result;
      }
      store.resetGeoState(["unavailable"]);

      if (!(await this.geocodeRows(ids, result))) return result;
      await this.matrixRows(ids, store.getHomeQuery(), profile.homeGeo, result);
    } catch (e) {
      this.log("error", this.t("geo.computeFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
    return result;
  }

  /** Returns false when ORS stopped us (auth/quota/network) and the run should end. */
  private async geocodeRows(ids: number[] | undefined, result: TravelResult): Promise<boolean> {
    const { store, ors } = this.d;
    for (;;) {
      const rows = store.vacanciesNeedingGeo(BATCH, ids);
      if (rows.length === 0) return true;
      for (const row of rows) {
        const q = locationQuery(row);
        if (!q) {
          store.saveVacancyGeo(row.id, {
            query: "", label: "", lat: null, lon: null, state: "not_found", error: this.t("geo.noPlace"),
          });
          continue;
        }
        const key = normalizeGeoQuery(q.query);
        let hit: GeoHit | null;
        const cached = store.getGeoCache(key);
        if (cached) {
          hit = cached.found && cached.lat !== null && cached.lon !== null
            ? { lat: cached.lat, lon: cached.lon, label: cached.label, layer: cached.layer, confidence: cached.confidence ?? 0 }
            : null;
        } else {
          try {
            hit = await ors.geocode(q.query);
          } catch (e) {
            if (e instanceof OrsError && e.kind !== "bad_response") {
              this.log("warn", this.t("geo.lookupStopped", { error: e.message }));
              return false;
            }
            const msg = e instanceof Error ? e.message : String(e);
            store.saveVacancyGeo(row.id, { query: q.query, label: "", lat: null, lon: null, state: "error", error: msg });
            result.failed++;
            continue;
          }
          store.putGeoCache({
            query: key,
            found: hit !== null,
            lat: hit?.lat ?? null,
            lon: hit?.lon ?? null,
            label: hit?.label ?? "",
            layer: hit?.layer ?? "",
            confidence: hit?.confidence ?? null,
            at: this.d.now?.().toISOString(),
          });
        }
        const cls = classifyHit(hit, q.fromOrganization);
        if (!hit || cls === "not_found") {
          store.saveVacancyGeo(row.id, {
            query: q.query, label: "", lat: null, lon: null, state: "not_found", error: this.t("geo.couldNotPlace", { query: q.query }),
          });
        } else {
          store.saveVacancyGeo(row.id, {
            query: q.query, label: hit.label, lat: hit.lat, lon: hit.lon, state: cls, error: null,
          });
        }
      }
    }
  }

  private async matrixRows(
    ids: number[] | undefined,
    homeKey: string,
    home: { lat: number; lon: number },
    result: TravelResult,
  ): Promise<void> {
    const { store, ors } = this.d;
    const rows: VacancyRow[] = store.vacanciesNeedingTravel(homeKey, 100_000, ids);
    if (rows.length === 0) return;
    let out;
    try {
      out = await ors.matrix(
        home,
        rows.map((r) => ({ lat: r.geoLat!, lon: r.geoLon! })),
      );
    } catch (e) {
      this.log("warn", this.t("geo.timeLookupStopped", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    rows.forEach((row, i) => {
      const r = out[i];
      if (r) {
        store.saveTravel(row.id, { minutes: r.minutes, km: r.km, homeKey });
        result.updated++;
      } else {
        store.saveVacancyGeo(row.id, {
          query: row.geoQuery, label: row.geoLabel, lat: row.geoLat, lon: row.geoLon,
          state: "error", error: this.t("geo.noRoute"),
        });
        result.failed++;
      }
    });
  }
}
