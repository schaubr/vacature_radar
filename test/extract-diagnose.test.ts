import { describe, expect, it } from "vitest";
import { diagnosePage } from "../src/core/extract/diagnose";
import { fixture } from "./helpers";

const URL_ = "https://www.zorgneticuro.be/content/overzicht-jobs";
const HTML = fixture("zorgneticuro_list.html");
const base = { html: HTML, pageUrl: URL_, modeUsed: "static" as const, frames: [], llmUsed: false, itemCount: 0, llmAvailable: true };

describe("diagnosePage", () => {
  it("finds embedded service hosts and ignores trackers and CDNs", () => {
    const d = diagnosePage(base);
    expect(d.embeddedHosts).toContain("www.jobat.be");
    expect(d.embeddedHosts.some((h) => h.includes("googletagmanager"))).toBe(false);
    expect(d.embeddedHosts).not.toContain("www.zorgneticuro.be");
    expect(d.visibleTextChars).toBeGreaterThan(300);
    expect(d.linkCount).toBeGreaterThan(10);
    expect(d.frames).toEqual([]);
  });

  it("rule 2: static mode with an embedded host says to switch to Browser mode", () => {
    const d = diagnosePage(base);
    expect(d.hint).toMatch(/loads content from .*www\.jobat\.be.*Browser mode/);
  });

  it("rule 3: browser mode with an embedded host suggests the service's own page", () => {
    const frames = [{ url: "https://www.jobat.be/x", included: true }];
    const d = diagnosePage({ ...base, modeUsed: "browser", frames });
    expect(d.hint).toMatch(/embedded service \(.*www\.jobat\.be.*\)/);
    expect(d.frames).toEqual(frames);
  });

  it("rule 1: an almost empty page wins over everything", () => {
    const d = diagnosePage({ ...base, html: "<html><body><p>hi</p></body></html>" });
    expect(d.hint).toMatch(/almost empty/);
    expect(d.visibleTextChars).toBeLessThan(300);
  });

  it("rule 4: no LLM available", () => {
    const html = `<html><body><p>${"vacancy text ".repeat(60)}</p></body></html>`;
    const d = diagnosePage({ ...base, html, llmAvailable: false });
    expect(d.hint).toMatch(/Add an Anthropic API key/);
  });

  it("rule 5: LLM looked and found nothing; rule 6: otherwise null", () => {
    const html = `<html><body><p>${"vacancy text ".repeat(60)}</p></body></html>`;
    expect(diagnosePage({ ...base, html, llmUsed: true }).hint).toMatch(/Claude looked at the page/);
    expect(diagnosePage({ ...base, html, llmUsed: false }).hint).toBeNull();
  });

  it("has no hint when items were found", () => {
    expect(diagnosePage({ ...base, itemCount: 3 }).hint).toBeNull();
  });

  it("does not list same-host or relative scripts, and drops browser-only frames in static mode", () => {
    const html = `<html><body><script src="/a.js"></script><script src="https://www.zorgneticuro.be/b.js"></script>
      <iframe src="https://cdn.jsdelivr.net/x"></iframe><iframe src="//widgets.example.com/w"></iframe></body></html>`;
    const d = diagnosePage({ ...base, html, frames: [{ url: "https://q.example", included: true }] });
    expect(d.embeddedHosts).toEqual(["widgets.example.com"]);
    expect(d.frames).toEqual([]);
  });
});
