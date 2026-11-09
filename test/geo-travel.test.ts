import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/db/store";
import { OrsClient, type JsonHttp } from "../src/core/geo/ors";
import { TravelService } from "../src/core/geo/travel";
import { DEFAULT_PREFERENCES } from "../src/shared/types";

const PLACES: Record<string, { lon: number; lat: number; label: string; layer: string; confidence: number }> = {
  gent: { lon: 3.72, lat: 51.05, label: "Gent, Oost-Vlaanderen, Belgium", layer: "locality", confidence: 0.95 },
  lendelede: { lon: 3.25, lat: 50.88, label: "Lendelede, West-Vlaanderen, Belgium", layer: "locality", confidence: 0.9 },
  aalst: { lon: 4.04, lat: 50.94, label: "Aalst, Oost-Vlaanderen, Belgium", layer: "locality", confidence: 0.9 },
  "oost-vlaanderen": { lon: 3.9, lat: 51.0, label: "Oost-Vlaanderen, Belgium", layer: "region", confidence: 0.8 },
  meerdonk: { lon: 4.2, lat: 51.2, label: "Meerdonk, Oost-Vlaanderen, Belgium", layer: "locality", confidence: 0.85 },
  hamme: { lon: 4.1, lat: 51.1, label: "Hamme, Oost-Vlaanderen, Belgium", layer: "region", confidence: 0.8 },
  venue: { lon: 4.3, lat: 51.3, label: "Venue", layer: "venue", confidence: 0.9 },
  fuzzy: { lon: 4.0, lat: 51.0, label: "Fuzzy", layer: "locality", confidence: 0.3 },
};

class FakeOrs {
  geocodes: string[] = [];
  matrices: number[] = [];
  key: string | null = "KEY";
  failWith: number | null = null;
  http: JsonHttp = async (url, init) => {
    if (this.failWith) return { status: this.failWith, body: "{}" };
    if (init.method === "GET") {
      const text = (new URL(url).searchParams.get("text") ?? "").toLowerCase();
      this.geocodes.push(text);
      const p = PLACES[text];
      if (!p) return { status: 200, body: JSON.stringify({ features: [] }) };
      return {
        status: 200,
        body: JSON.stringify({ features: [{ geometry: { coordinates: [p.lon, p.lat] }, properties: { label: p.label, confidence: p.confidence, layer: p.layer } }] }),
      };
    }
    const b = JSON.parse(init.body!);
    this.matrices.push(b.destinations.length);
    const durs = b.locations.slice(1).map(([lon]: number[]) => Math.round(Math.abs(lon - b.locations[0][0]) * 3600 + 600));
    const dists = durs.map((d: number) => d / 60);
    return { status: 200, body: JSON.stringify({ durations: [durs], distances: [dists] }) };
  };
}

interface Env {
  store: Store;
  fake: FakeOrs;
  travel: TravelService;
  logs: string[];
  sid: number;
  add(location: string, organization?: string, title?: string): number;
  setHome(home: string): void;
}

function mk(): Env {
  const store = new Store(":memory:");
  const fake = new FakeOrs();
  const logs: string[] = [];
  const ors = new OrsClient({ http: fake.http, getKey: () => fake.key, minIntervalMs: 0 });
  const travel = new TravelService({
    store,
    ors,
    orsConfigured: () => fake.key !== null,
    now: () => new Date("2026-11-08T10:00:00Z"),
    log: (l, m) => logs.push(`${l}: ${m}`),
  });
  const sid = store.createSource({ name: "S", url: "https://x.test", enabled: true, renderMode: "static", scanIntervalHours: null, maxPages: 1, notes: "" }).id;
  let n = 0;
  return {
    store, fake, travel, logs, sid,
    add: (location, organization = "", title = `J${n + 1}`) => {
      n++;
      return store.insertVacancy({
        sourceId: sid, title, url: `https://x.test/${n}`, organization, location, dateText: "", snippet: "",
        dedupeKey: `k${n}`, now: "2026-11-01T00:00:00Z",
      }).id;
    },
    setHome: (home) => store.saveProfile({ markdown: "m", preferences: { ...DEFAULT_PREFERENCES, homeLocation: home } }),
  };
}

describe("TravelService", () => {
  let e: Env;
  beforeEach(() => {
    e = mk();
    e.setHome("Gent");
  });

  it("resolves home once (cached) and computes travel with one batched matrix call", async () => {
    const a = e.add("LENDELEDE");
    const b = e.add("Provincie Oost-Vlaanderen");
    const c = e.add("", "Lokaal bestuur Aalst");
    const r = await e.travel.computeFor([a, b, c]);
    expect(r).toEqual({ updated: 3, failed: 0 });
    expect(e.fake.geocodes.sort()).toEqual(["aalst", "gent", "lendelede", "oost-vlaanderen"]);
    expect(e.fake.matrices).toEqual([3]);
    expect(e.store.getProfile().homeGeo).toMatchObject({ label: "Gent, Oost-Vlaanderen, Belgium", lat: 51.05, lon: 3.72 });
    expect(e.store.getVacancy(a)).toMatchObject({ geoState: "ok", geoLabel: "Lendelede, West-Vlaanderen, Belgium", geoQuery: "Lendelede" });
    expect(e.store.getVacancy(a)!.travelMinutes).toBeGreaterThan(0);
    expect(e.store.getVacancy(b)!.geoState).toBe("approximate");
    expect(e.store.getVacancy(c)).toMatchObject({ geoState: "ok", geoQuery: "Aalst" });

    // Second run: everything cached / nothing to do, no further HTTP calls.
    const before = e.fake.geocodes.length;
    const d = e.add("Lendelede");
    await e.travel.computeFor([d]);
    expect(e.fake.geocodes).toHaveLength(before); // cache hit
    expect(e.fake.matrices).toEqual([3, 1]);
    expect(e.store.getVacancy(d)!.travelMinutes).toBe(e.store.getVacancy(a)!.travelMinutes);
  });

  it("caches not-found places and low-confidence hits, and does not retry them", async () => {
    const a = e.add("Nergenshuizen");
    const b = e.add("Fuzzy");
    const c = e.add("", "Vzw Jeugdzorg Emmaüs");
    await e.travel.computeFor();
    expect(e.store.getVacancy(a)).toMatchObject({ geoState: "not_found" });
    expect(e.store.getVacancy(b)).toMatchObject({ geoState: "not_found" });
    expect(e.store.getVacancy(c)).toMatchObject({ geoState: "not_found", geoQuery: "" });
    expect(e.fake.matrices).toEqual([]);
    const n = e.fake.geocodes.length;
    const d = e.add("Nergenshuizen");
    await e.travel.computeFor();
    expect(e.fake.geocodes).toHaveLength(n);
    expect(e.store.getVacancy(d)!.geoState).toBe("not_found");
    expect(e.store.getGeoCache("nergenshuizen")?.found).toBe(false);
  });

  it("marks rows unavailable without a key, and pending again once configured", async () => {
    e.fake.key = null;
    const a = e.add("Lendelede");
    expect(await e.travel.computeFor([a])).toEqual({ updated: 0, failed: 0 });
    expect(e.store.getVacancy(a)!.geoState).toBe("unavailable");
    expect(e.fake.geocodes).toEqual([]);
    e.fake.key = "KEY";
    const r = await e.travel.computeFor([a]);
    expect(r.updated).toBe(1);
    expect(e.store.getVacancy(a)!.geoState).toBe("ok");
  });

  it("marks rows unavailable when the home cannot be found, with an error message", async () => {
    e.setHome("Nergenshuizen");
    const a = e.add("Lendelede");
    await e.travel.computeFor([a]);
    expect(e.store.getVacancy(a)!.geoState).toBe("unavailable");
    expect(e.store.getProfile()).toMatchObject({ homeGeo: null });
    expect(e.store.getProfile().homeGeoError).toMatch(/Nergenshuizen/);
    // fixing the home resolves it again
    e.setHome("Gent");
    expect((await e.travel.recomputeAll()).updated).toBe(1);
    expect(e.store.getProfile().homeGeoError).toBeNull();
  });

  it("an empty home location leaves rows unavailable", async () => {
    e.setHome("");
    const a = e.add("Lendelede");
    await e.travel.computeFor([a]);
    expect(e.store.getVacancy(a)!.geoState).toBe("unavailable");
    expect(e.fake.geocodes).toEqual([]);
  });

  it("stops on quota (429) and leaves rows pending; works next time", async () => {
    const a = e.add("Lendelede");
    const b = e.add("Aalst");
    e.fake.failWith = 429;
    expect(await e.travel.computeFor()).toEqual({ updated: 0, failed: 0 });
    expect(e.store.getVacancy(a)!.geoState).toBe("pending");
    expect(e.store.getVacancy(b)!.geoState).toBe("pending");
    expect(e.logs.some((l) => /quota/.test(l))).toBe(true);
    e.fake.failWith = null;
    expect((await e.travel.computeFor()).updated).toBe(2);
  });

  it("a quota error mid-way keeps rows resolved so far", async () => {
    const a = e.add("Lendelede");
    const b = e.add("Aalst");
    await e.travel.ensureHome();
    const orig = e.fake.http;
    let calls = 0;
    e.fake.http = async (u, i) => (++calls > 1 ? { status: 429, body: "{}" } : orig(u, i));
    // rebuild service to use the patched http
    const ors = new OrsClient({ http: (u, i) => e.fake.http(u, i), getKey: () => "KEY", minIntervalMs: 0 });
    const t = new TravelService({ store: e.store, ors, orsConfigured: () => true });
    await t.computeFor();
    expect(e.store.getVacancy(a)!.geoState).toBe("ok");
    expect(e.store.getVacancy(b)!.geoState).toBe("pending");
    expect(e.store.getVacancy(a)!.travelMinutes).toBeNull();
  });

  it("an auth error stops without marking anything unavailable", async () => {
    const a = e.add("Lendelede");
    e.fake.failWith = 401;
    await e.travel.computeFor();
    expect(e.store.getVacancy(a)!.geoState).toBe("pending");
    expect(e.store.getProfile().homeGeoError).toMatch(/Invalid/);
  });

  it("unroutable pairs become error rows and count as failed", async () => {
    const a = e.add("Lendelede");
    const orig = e.fake.http;
    e.fake.http = async (u, i) => (i.method === "POST" ? { status: 200, body: JSON.stringify({ durations: [[null]], distances: [[null]] }) } : orig(u, i));
    const ors = new OrsClient({ http: (u, i) => e.fake.http(u, i), getKey: () => "KEY", minIntervalMs: 0 });
    const t = new TravelService({ store: e.store, ors, orsConfigured: () => true });
    expect(await t.computeFor([a])).toEqual({ updated: 0, failed: 1 });
    expect(e.store.getVacancy(a)).toMatchObject({ geoState: "error", geoError: "No driving route found", travelMinutes: null });
  });

  it("recomputeAll after a home change recalculates all travel without re-geocoding places", async () => {
    const a = e.add("Lendelede");
    const b = e.add("Aalst");
    await e.travel.computeFor();
    const first = e.store.getVacancy(a)!.travelMinutes;
    const geocodesBefore = e.fake.geocodes.length;
    e.setHome("Aalst");
    const r = await e.travel.recomputeAll();
    expect(r.updated).toBe(2);
    expect(e.store.getProfile().homeGeo?.label).toMatch(/Aalst/);
    expect(e.store.getVacancy(a)!.travelMinutes).not.toBe(first);
    expect(e.store.getVacancy(b)!.travelHomeKey).toBe("aalst");
    expect(e.fake.geocodes.slice(geocodesBefore)).toEqual(["aalst"]); // only the new home; places come from the cache
  });

  it("batches more than 50 destinations into chunks", async () => {
    for (let i = 0; i < 120; i++) e.add("Lendelede");
    const r = await e.travel.computeFor();
    expect(r.updated).toBe(120);
    expect(e.fake.matrices).toEqual([50, 50, 20]);
    expect(e.fake.geocodes.filter((g) => g === "lendelede")).toHaveLength(1);
  });

  it("skips closed and duplicate rows", async () => {
    const a = e.add("Lendelede");
    const b = e.add("Lendelede");
    const c = e.add("Lendelede");
    e.store.setStatus(a, "closed");
    e.store.setDuplicateOf(b, c);
    await e.travel.computeFor();
    expect(e.store.getVacancy(a)!.geoState).toBe("pending");
    expect(e.store.getVacancy(b)!.geoState).toBe("pending");
    expect(e.store.getVacancy(c)!.geoState).toBe("ok");
  });

  describe("town from title", () => {
    it("upgrades an approximate region hit to the title town and computes travel from it", async () => {
      const a = e.add("Oost-Vlaanderen", "Helan Kinderopvang", "Onthaalouder groepsopvang - Meerdonk");
      const r = await e.travel.computeFor([a]);
      expect(r).toEqual({ updated: 1, failed: 0 });
      expect(e.store.getVacancy(a)).toMatchObject({
        geoState: "ok", geoQuery: "Meerdonk", geoLabel: "Meerdonk, Oost-Vlaanderen, Belgium", geoLat: 51.2, geoLon: 4.2,
      });
      expect(e.store.getVacancy(a)!.travelMinutes).toBe(Math.round((Math.abs(4.2 - 3.72) * 3600 + 600) / 60));
      // cached: no new geocode calls on a second vacancy with the same inputs
      const before = e.fake.geocodes.length;
      const b = e.add("Oost-Vlaanderen", "Helan Kinderopvang", "Onthaalouder groepsopvang - Meerdonk");
      await e.travel.computeFor([b]);
      expect(e.fake.geocodes).toHaveLength(before);
      expect(e.store.getVacancy(b)).toMatchObject({ geoState: "ok", geoQuery: "Meerdonk" });
    });

    it("keeps the approximate result when the title town only hits a non-locality layer", async () => {
      const a = e.add("Oost-Vlaanderen", "", "Begeleider - Hamme");
      const b = e.add("Oost-Vlaanderen", "", "Begeleider - Venue");
      await e.travel.computeFor([a, b]);
      expect(e.store.getVacancy(a)).toMatchObject({ geoState: "approximate", geoQuery: "Oost-Vlaanderen" });
      expect(e.store.getVacancy(b)).toMatchObject({ geoState: "approximate", geoQuery: "Oost-Vlaanderen" });
    });

    it("rescues a not_found location with a valid title town", async () => {
      const a = e.add("Koek en Kokola", "", "Onthaalouder - Meerdonk");
      await e.travel.computeFor([a]);
      expect(e.store.getVacancy(a)).toMatchObject({ geoState: "ok", geoQuery: "Meerdonk" });
    });

    it("leaves behavior unchanged without a title town", async () => {
      const a = e.add("Oost-Vlaanderen", "", "Klantenadviseur Service Center");
      const b = e.add("Nergenshuizen", "", "Teamcoach - voltijds");
      await e.travel.computeFor([a, b]);
      expect(e.store.getVacancy(a)).toMatchObject({ geoState: "approximate", geoQuery: "Oost-Vlaanderen" });
      expect(e.store.getVacancy(b)).toMatchObject({ geoState: "not_found" });
      expect(e.fake.geocodes.sort()).toEqual(["gent", "nergenshuizen", "oost-vlaanderen"]);
    });
  });
});
