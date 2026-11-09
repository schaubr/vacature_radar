import { describe, expect, it } from "vitest";
import { en } from "../src/shared/i18n/en";
import { nl } from "../src/shared/i18n/nl";
import { formatDate, formatDateTime, formatNumber, formatRelative, formatTime, formatUsd, translate, tEn } from "../src/shared/i18n";
import { formatTravel } from "../src/shared/travel";

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  const enKeys = Object.keys(en).sort();
  const nlKeys = Object.keys(nl).sort();
  it("have the same keys", () => {
    expect(nlKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !nlKeys.includes(k))).toEqual([]);
  });
  it("use identical placeholders per key", () => {
    for (const k of enKeys) {
      expect(placeholders((nl as Record<string, string>)[k]), k).toEqual(placeholders((en as Record<string, string>)[k]));
    }
  });
  it("have a plural pair for every plural key, and no empty text", () => {
    for (const dict of [en, nl] as Record<string, string>[]) {
      for (const k of Object.keys(dict)) {
        expect(dict[k].length, k).toBeGreaterThan(0);
        if (k.endsWith("_one")) expect(dict[k.replace(/_one$/, "_other")], k).toBeDefined();
        if (k.endsWith("_other")) expect(dict[k.replace(/_other$/, "_one")], k).toBeDefined();
      }
    }
  });
  it("contain no em dash", () => {
    for (const dict of [en, nl] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(dict)) expect(v.includes("—"), k).toBe(false);
    }
  });
  it("follows the binding glossary", () => {
    expect(translate("nl", "nav.sources")).toBe("Bronnen");
    expect(translate("nl", "vstatus.dismissed")).toBe("Niet relevant");
    expect(translate("nl", "bucket.knockout")).toBe("Knock-out");
    expect(translate("nl", "detail.field.payScale")).toBe("Barema");
    expect(translate("nl", "action.scanAll")).toBe("Alles nu scannen");
    expect(translate("nl", "status.nextScan", { time: "14:05" })).toBe("Volgende scan om 14:05");
  });
});

describe("translate", () => {
  it("fills placeholders and the default {app}", () => {
    expect(translate("en", "status.nextScan", { time: "14:05" })).toBe("Next scan 14:05");
    expect(translate("nl", "tray.open")).toBe("Vacature Radar openen");
    expect(tEn("tray.open")).toBe("Open Vacature Radar");
  });
  it("selects plural forms from count", () => {
    expect(translate("en", "inbox.count", { count: 1 })).toBe("1 vacancy");
    expect(translate("en", "inbox.count", { count: 2 })).toBe("2 vacancies");
    expect(translate("nl", "inbox.count", { count: 1 })).toBe("1 vacature");
    expect(translate("nl", "row.duplicates", { count: 2 })).toBe("+2 dubbels");
    expect(translate("en", "inbox.count", { count: 0 })).toBe("0 vacancies");
  });
});

describe("formatters", () => {
  const iso = "2026-11-09T14:05:33";
  it("formats times and dates per locale", () => {
    expect(formatTime("en", iso)).toBe("14:05");
    expect(formatTime("nl", iso)).toBe("14:05");
    expect(formatDateTime("en", iso)).toMatch(/^09 Nov 14:05:33$/);
    expect(formatDateTime("nl", iso)).toMatch(/^09 nov\.? 14:05:33$/);
    expect(formatDate("en", iso)).toBe("9 Nov 2026");
    expect(formatDate("nl", iso)).toMatch(/^9 nov\.? 2026$/);
  });
  it("formats numbers per locale", () => {
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatNumber("nl", 4.1)).toBe("4,1");
  });
  it("formats USD with the narrow symbol", () => {
    expect(formatUsd("en", 1.846)).toBe("$1.85");
    expect(formatUsd("en", 0.048)).toBe("$0.048");
    expect(formatUsd("nl", 1.846).replace(/\s/g, " ")).toMatch(/^\$ ?1,85$/);
    expect(formatUsd("en", 20, 2)).toBe("$20.00");
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(formatRelative("en", ago(5 * 60_000), now)).toBe("5 min ago");
    expect(formatRelative("nl", ago(5 * 60_000), now)).toBe("5 min geleden");
    expect(formatRelative("nl", ago(2 * 86400_000), now)).toBe("2 d geleden");
    expect(formatRelative("nl", ago(3 * 3600_000), now)).toBe("3 u geleden");
    expect(formatRelative("en", ago(1000), now)).toBe("just now");
    expect(formatRelative("nl", new Date(now + 2 * 3600_000).toISOString(), now)).toBe("over 2 u");
    expect(formatRelative("en", null, now)).toBe("never");
    expect(formatRelative("nl", null, now)).toBe("nooit");
  });
  it("formats the travel line in both languages", () => {
    const v = { travelMinutes: 34.2, travelKm: 41.04, geoState: "ok" as const };
    expect(formatTravel(v)).toBe("34 min by car, 41 km");
    expect(formatTravel(v, "nl")).toBe("34 min met de auto, 41 km");
    expect(formatTravel({ ...v, geoState: "approximate" }, "nl")).toBe("ongeveer 34 min met de auto, 41 km");
    expect(formatTravel({ ...v, travelKm: 4.1 }, "nl")).toBe("34 min met de auto, 4,1 km");
  });
});
