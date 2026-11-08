import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/db/store";
import { Scheduler } from "../src/core/scan/scheduler";
import type { SourceInput } from "../src/shared/types";

const NOW = new Date("2026-11-08T12:00:00Z");
const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  name: "S", url: "https://example.org/jobs", enabled: true, renderMode: "auto", scanIntervalHours: null, maxPages: 1, notes: "", ...over,
});
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function setup() {
  const store = new Store(":memory:");
  const scanMany = vi.fn(async (_ids: number[]) => {});
  const scheduler = new Scheduler({ store, scanner: { scanMany }, now: () => NOW });
  return { store, scanMany, scheduler };
}

describe("Scheduler", () => {
  it("never-scanned enabled sources are due; disabled ones are not", () => {
    const { store, scheduler } = setup();
    const a = store.createSource(input());
    store.createSource(input({ enabled: false }));
    expect(scheduler.dueSources(NOW)).toEqual([a.id]);
  });

  it("uses the global interval (6 h default) and the per-source override", () => {
    const { store, scheduler } = setup();
    const a = store.createSource(input());
    const b = store.createSource(input({ scanIntervalHours: 1 }));
    const c = store.createSource(input({ scanIntervalHours: 24 }));
    for (const s of [a, b, c]) store.updateSourceRuntime(s.id, { lastScanAt: hoursAgo(5) });
    expect(scheduler.dueSources(NOW)).toEqual([b.id]); // a: 5h < 6h, c: 5h < 24h
    store.saveSettings({ scanIntervalHours: 4 });
    expect(scheduler.dueSources(NOW).sort()).toEqual([a.id, b.id].sort());
    store.updateSourceRuntime(a.id, { lastScanAt: hoursAgo(4) }); // exactly on the boundary
    expect(scheduler.dueSources(NOW)).toContain(a.id);
  });

  it("computes nextScanAt", () => {
    const { store, scheduler } = setup();
    expect(scheduler.nextScanAt(NOW)).toBeNull();
    const a = store.createSource(input());
    expect(scheduler.nextScanAt(NOW)).toBe(NOW.toISOString()); // never scanned: due now
    store.updateSourceRuntime(a.id, { lastScanAt: hoursAgo(2) });
    expect(scheduler.nextScanAt(NOW)).toBe(new Date(NOW.getTime() + 4 * 3_600_000).toISOString());
    const b = store.createSource(input({ scanIntervalHours: 1 }));
    store.updateSourceRuntime(b.id, { lastScanAt: hoursAgo(0.5) });
    expect(scheduler.nextScanAt(NOW)).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    store.updateSource(b.id, { enabled: false });
    expect(scheduler.nextScanAt(NOW)).toBe(new Date(NOW.getTime() + 4 * 3_600_000).toISOString());
    store.updateSourceRuntime(a.id, { lastScanAt: hoursAgo(10) });
    expect(scheduler.nextScanAt(NOW)).toBe(NOW.toISOString()); // overdue: now, not the past
  });

  it("tick scans due sources only, and onResume ticks", async () => {
    const { store, scanMany, scheduler } = setup();
    const a = store.createSource(input());
    const b = store.createSource(input());
    store.updateSourceRuntime(b.id, { lastScanAt: hoursAgo(1) });
    await scheduler.tick();
    expect(scanMany).toHaveBeenCalledWith([a.id]);
    scanMany.mockClear();
    store.updateSourceRuntime(a.id, { lastScanAt: hoursAgo(0) });
    await scheduler.tick();
    expect(scanMany).not.toHaveBeenCalled();
    store.updateSourceRuntime(a.id, { lastScanAt: hoursAgo(7) });
    scheduler.onResume();
    await vi.waitFor(() => expect(scanMany).toHaveBeenCalledWith([a.id]));
  });

  it("a failing scanner does not break tick", async () => {
    const store = new Store(":memory:");
    store.createSource(input());
    const scheduler = new Scheduler({ store, scanner: { scanMany: async () => { throw new Error("x"); } }, now: () => NOW });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(store.listLog(5)[0].message).toMatch(/Scheduler tick failed: x/);
  });

  it("start schedules an initial tick after 10 s and a 60 s interval; stop clears both", () => {
    const { scanMany: _s, ...rest } = setup();
    const calls: { fn: () => void; ms: number }[] = [];
    const cleared: unknown[] = [];
    const scheduler = new Scheduler({
      store: rest.store,
      scanner: { scanMany: async () => {} },
      now: () => NOW,
      setInterval: ((fn: () => void, ms: number) => (calls.push({ fn, ms }), "I")) as never,
      clearInterval: ((h: unknown) => cleared.push(h)) as never,
      setTimeout: ((fn: () => void, ms: number) => (calls.push({ fn, ms }), "T")) as never,
      clearTimeout: ((h: unknown) => cleared.push(h)) as never,
    });
    scheduler.start();
    scheduler.start(); // idempotent
    expect(calls.map((c) => c.ms)).toEqual([10_000, 60_000]);
    scheduler.stop();
    expect(cleared.sort()).toEqual(["I", "T"]);
  });
});
