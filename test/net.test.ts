import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FetchError, PoliteFetcher, USER_AGENT, type RawFetch, type RawResponse } from "../src/core/net/fetcher";
import { RobotsCache } from "../src/core/net/robots";

const res = (over: Partial<RawResponse> = {}): RawResponse => ({ status: 200, url: "https://a.be/", contentType: "text/html", body: "ok", ...over });

function harness(handler: (url: string) => RawResponse | Promise<RawResponse>, minIntervalMs = 3000) {
  let t = 1_000_000;
  const log: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const raw: RawFetch = vi.fn(async (url) => {
    log.push({ url, at: t });
    return handler(url);
  });
  const sleep = async (ms: number) => { sleeps.push(ms); t += ms; };
  const f = new PoliteFetcher(raw, { minIntervalMs, now: () => t, sleep, timeoutMs: 200 });
  return { f, raw, log, sleeps, advance: (ms: number) => { t += ms; } };
}

describe("PoliteFetcher", () => {
  it("sends the user agent and returns the response", async () => {
    const h = harness(() => res());
    const r = await h.f.fetch("https://a.be/x");
    expect(r.body).toBe("ok");
    const init = (h.raw as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("enforces the minimum interval per host, not across hosts", async () => {
    const h = harness(() => res());
    await h.f.fetch("https://a.be/1");
    await h.f.fetch("https://a.be/2");
    await h.f.fetch("https://b.be/1");
    expect(h.sleeps).toEqual([3000]);
    h.advance(10_000);
    await h.f.fetch("https://a.be/3");
    expect(h.sleeps).toEqual([3000]);
    expect(h.log.map((l) => l.at)).toEqual([1_000_000, 1_003_000, 1_003_000, 1_013_000]);
  });
  it("serializes concurrent requests to the same host", async () => {
    let active = 0;
    let maxActive = 0;
    const h = harness(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return res();
    });
    await Promise.all([1, 2, 3].map((i) => h.f.fetch(`https://a.be/${i}`)));
    expect(maxActive).toBe(1);
    expect(h.sleeps).toEqual([3000, 3000]);
  });
  it("throttle shares the same per-host slot", async () => {
    const h = harness(() => res());
    await h.f.throttle("https://a.be/render");
    await h.f.fetch("https://a.be/next");
    expect(h.sleeps).toEqual([3000]);
  });
  it("throws FetchError with status on HTTP >= 400 and keeps working afterwards", async () => {
    const h = harness((u) => (u.endsWith("/bad") ? res({ status: 503 }) : res()));
    const err = await h.f.fetch("https://a.be/bad").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.status).toBe(503);
    await expect(h.f.fetch("https://a.be/good")).resolves.toMatchObject({ status: 200 });
  });
  it("wraps network errors with null status", async () => {
    const h = harness(() => { throw new Error("ECONNRESET"); });
    const err = await h.f.fetch("https://a.be/").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.status).toBeNull();
    expect(err.message).toContain("ECONNRESET");
  });
  it("times out via AbortController", async () => {
    let aborted = false;
    const raw: RawFetch = (_u, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
    const f = new PoliteFetcher(raw, { minIntervalMs: 0, timeoutMs: 30 });
    const err = await f.fetch("https://a.be/").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).toMatch(/Timeout/);
    expect(aborted).toBe(true);
  });
});

describe("PoliteFetcher.isAllowed (robots.txt)", () => {
  const vdabRobots = readFileSync(path.join(__dirname, "fixtures", "sites", "vdab_robots.txt"), "utf8");

  it("applies the real vdab robots.txt", async () => {
    const h = harness((u) => (u.endsWith("/robots.txt") ? res({ body: vdabRobots }) : res()));
    expect(await h.f.isAllowed("https://www.vdab.be/vindeenjob/vacatures?trefwoord=x")).toBe(true);
    expect(await h.f.isAllowed("https://www.vdab.be/api/vindeenjob/v4/vacatures")).toBe(false);
  });
  it("fetches robots.txt once per origin and rate-limits it", async () => {
    const h = harness((u) => (u.endsWith("/robots.txt") ? res({ body: "User-agent: *\nDisallow: /private" }) : res()));
    expect(await h.f.isAllowed("https://a.be/public")).toBe(true);
    expect(await h.f.isAllowed("https://a.be/private/x")).toBe(false);
    expect(h.log.filter((l) => l.url.endsWith("/robots.txt"))).toHaveLength(1);
    await h.f.fetch("https://a.be/public");
    expect(h.sleeps).toEqual([3000]); // robots fetch counted against the host
  });
  it("treats 4xx, 5xx and network failures as allowed", async () => {
    for (const handler of [() => res({ status: 404 }), () => res({ status: 500 }), () => { throw new Error("down"); }]) {
      const warn = vi.fn();
      const raw: RawFetch = async () => handler();
      const f = new PoliteFetcher(raw, { minIntervalMs: 0, onWarn: warn });
      expect(await f.isAllowed("https://a.be/anything")).toBe(true);
    }
  });
  it("logs a warning for 5xx", async () => {
    const warn = vi.fn();
    const f = new PoliteFetcher(async () => res({ status: 502 }), { minIntervalMs: 0, onWarn: warn });
    await f.isAllowed("https://a.be/");
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("RobotsCache", () => {
  it("caches for 24 h per origin then refetches", async () => {
    let now = 0;
    const load = vi.fn(async () => ({ status: 200, body: "User-agent: *\nDisallow: /x" }));
    const c = new RobotsCache(load, { now: () => now });
    await c.isAllowed("https://a.be/1");
    await c.isAllowed("https://a.be/2");
    await c.isAllowed("https://b.be/1");
    expect(load).toHaveBeenCalledTimes(2);
    now += 23 * 3600_000;
    await c.isAllowed("https://a.be/3");
    expect(load).toHaveBeenCalledTimes(2);
    now += 2 * 3600_000;
    await c.isAllowed("https://a.be/4");
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("shares one in-flight load between concurrent callers and ignores non-http urls", async () => {
    const load = vi.fn(async () => ({ status: 200, body: "" }));
    const c = new RobotsCache(load);
    await Promise.all([c.isAllowed("https://a.be/1"), c.isAllowed("https://a.be/2")]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await c.isAllowed("ftp://a.be/x")).toBe(true);
    expect(await c.isAllowed("garbage")).toBe(true);
  });
  it("honours a specific VacatureRadar group", async () => {
    const c = new RobotsCache(async () => ({ status: 200, body: "User-agent: VacatureRadar\nDisallow: /\n\nUser-agent: *\nAllow: /" }));
    expect(await c.isAllowed("https://a.be/x")).toBe(false);
  });
});
