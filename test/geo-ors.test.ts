import { describe, expect, it } from "vitest";
import { OrsClient, OrsError, type JsonHttp } from "../src/core/geo/ors";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mk(handler: (c: Call, n: number) => { status: number; body: string } | Promise<{ status: number; body: string }>, key: string | null = "KEY") {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let t = 1_000_000;
  const http: JsonHttp = async (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    return handler(c, calls.length);
  };
  const ors = new OrsClient({
    http,
    getKey: () => key,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { ors, calls, sleeps, advance: (ms: number) => (t += ms) };
}

const feature = (over: object = {}) => ({
  type: "FeatureCollection",
  features: [{ geometry: { coordinates: [3.72, 51.05] }, properties: { label: "Gent, Oost-Vlaanderen, Belgium", confidence: 0.9, layer: "locality", ...over } }],
});

describe("OrsClient.geocode", () => {
  it("builds the GET request with api_key, text, country and size; reads lon/lat", async () => {
    const { ors, calls } = mk(() => ({ status: 200, body: JSON.stringify(feature()) }));
    const hit = await ors.geocode("Sint-Niklaas & Co");
    expect(hit).toEqual({ lat: 51.05, lon: 3.72, label: "Gent, Oost-Vlaanderen, Belgium", layer: "locality", confidence: 0.9 });
    const u = new URL(calls[0].url);
    expect(calls[0].method).toBe("GET");
    expect(u.origin + u.pathname).toBe("https://api.openrouteservice.org/geocode/search");
    expect(u.searchParams.get("api_key")).toBe("KEY");
    expect(u.searchParams.get("text")).toBe("Sint-Niklaas & Co");
    expect(u.searchParams.get("boundary.country")).toBe("BE");
    expect(u.searchParams.get("size")).toBe("1");
    expect(calls[0].body).toBeUndefined();
  });

  it("returns null for an empty feature list", async () => {
    const { ors } = mk(() => ({ status: 200, body: JSON.stringify({ features: [] }) }));
    expect(await ors.geocode("zzz")).toBeNull();
  });

  it("flags malformed bodies as bad_response", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ features: [{ geometry: {} }] })]) {
      const { ors } = mk(() => ({ status: 200, body }));
      await expect(ors.geocode("x")).rejects.toMatchObject({ kind: "bad_response" });
    }
  });
});

describe("OrsClient.matrix", () => {
  const origin = { lat: 51.05, lon: 3.72 };
  const dests = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 50 + i / 1000, lon: 4 + i / 1000 }));
  const answer = (c: Call) => {
    const b = JSON.parse(c.body!);
    const n = b.destinations.length;
    return {
      status: 200,
      body: JSON.stringify({
        durations: [Array.from({ length: n }, (_, i) => (i % 7 === 3 ? null : 600 + i * 30 + 14))],
        distances: [Array.from({ length: n }, (_, i) => (i % 7 === 3 ? null : 10.04 + i))],
      }),
    };
  };

  it("sends the documented POST body (lon/lat, string indexes, metrics, units) with Authorization", async () => {
    const { ors, calls } = mk(answer);
    const out = await ors.matrix(origin, [{ lat: 50.9, lon: 4.1 }, { lat: 50.8, lon: 4.2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openrouteservice.org/v2/matrix/driving-car");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("KEY");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body!)).toEqual({
      locations: [[3.72, 51.05], [4.1, 50.9], [4.2, 50.8]],
      sources: ["0"],
      destinations: ["1", "2"],
      metrics: ["duration", "distance"],
      units: "km",
    });
    // 614 s -> 10 min (rounded), 10.04 km -> 10 (1 decimal); 644 s -> 11 min, 11.04 -> 11
    expect(out).toEqual([{ minutes: 10, km: 10 }, { minutes: 11, km: 11 }]);
  });

  it("rounds minutes to integers and km to one decimal", async () => {
    const { ors } = mk(() => ({ status: 200, body: JSON.stringify({ durations: [[2010]], distances: [[41.26]] }) }));
    expect(await ors.matrix(origin, dests(1))).toEqual([{ minutes: 34, km: 41.3 }]);
  });

  it("chunks 120 destinations into 50/50/20 and keeps input order, nulls for unroutable", async () => {
    const { ors, calls } = mk(answer);
    const out = await ors.matrix(origin, dests(120));
    expect(calls.map((c) => JSON.parse(c.body!).destinations.length)).toEqual([50, 50, 20]);
    expect(JSON.parse(calls[1].body!).locations[1]).toEqual([4 + 50 / 1000, 50 + 50 / 1000]);
    expect(out).toHaveLength(120);
    expect(out[3]).toBeNull();
    expect(out[10]).toBeNull();
    expect(out[0]).not.toBeNull();
    // index 52 is second chunk position 2 -> 600 + 2*30 = 660 s -> 11 min
    expect(out[52]).toMatchObject({ minutes: 11 });
  });

  it("makes no request for an empty destination list", async () => {
    const { ors, calls } = mk(answer);
    expect(await ors.matrix(origin, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("rejects a response of the wrong size", async () => {
    const { ors } = mk(() => ({ status: 200, body: JSON.stringify({ durations: [[1]], distances: [[1]] }) }));
    await expect(ors.matrix(origin, dests(2))).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("OrsClient errors", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "quota"],
    [500, "bad_response"],
    [404, "bad_response"],
  ])("HTTP %i is %s", async (status, kind) => {
    const { ors } = mk(() => ({ status, body: "{}" }));
    const e = await ors.geocode("x").catch((x) => x);
    expect(e).toBeInstanceOf(OrsError);
    expect(e).toMatchObject({ kind, status });
  });

  it("network failures and timeouts are kind network", async () => {
    const a = mk(() => {
      throw new Error("ECONNRESET");
    });
    await expect(a.ors.geocode("x")).rejects.toMatchObject({ kind: "network", status: null });
    const slow = new OrsClient({ http: () => new Promise(() => {}), getKey: () => "K", timeoutMs: 10, minIntervalMs: 0 });
    await expect(slow.geocode("x")).rejects.toMatchObject({ kind: "network" });
  });

  it("a missing key is an auth error without any request", async () => {
    const { ors, calls } = mk(() => ({ status: 200, body: "{}" }), null);
    await expect(ors.geocode("x")).rejects.toMatchObject({ kind: "auth" });
    await expect(ors.matrix({ lat: 1, lon: 1 }, [{ lat: 1, lon: 1 }])).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0);
  });
});

describe("OrsClient throttle", () => {
  it("spaces requests by 1600 ms using the injected clock, including concurrent callers", async () => {
    const { ors, sleeps, advance } = mk(() => ({ status: 200, body: JSON.stringify({ features: [] }) }));
    await ors.geocode("a"); // first request: no wait
    expect(sleeps).toEqual([]);
    advance(500);
    await ors.geocode("b");
    expect(sleeps).toEqual([1100]);
    advance(5000);
    await ors.geocode("c"); // already long enough ago
    expect(sleeps).toEqual([1100]);
    await Promise.all([ors.geocode("d"), ors.geocode("e")]);
    expect(sleeps).toEqual([1100, 1600, 1600]);
  });
});
