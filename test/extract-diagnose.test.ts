import { describe, expect, it } from "vitest";
import { diagnosePage } from "../src/core/extract/diagnose";
import { findPortals } from "../src/core/extract/portals";
import { fixture } from "./helpers";

const URL_ = "https://www.zorgneticuro.be/content/overzicht-jobs";
const HTML = fixture("zorgneticuro_list.html");
// The real fixture embeds Jobat, a known portal, which now triggers the portal hint ahead of rules 2/3.
// Rules 2/3 are tested with the same page pointed at an unknown embedded service.
const NEUTRAL = HTML.replaceAll("jobat.be", "widgets.example-ats.test");
const base = { html: NEUTRAL, pageUrl: URL_, modeUsed: "static" as const, frames: [], llmUsed: false, itemCount: 0, llmAvailable: true };

describe("diagnosePage", () => {
  it("finds embedded service hosts and ignores trackers and CDNs", () => {
    const d = diagnosePage(base);
    expect(d.embeddedHosts).toContain("www.widgets.example-ats.test");
    expect(d.embeddedHosts.some((h) => h.includes("googletagmanager"))).toBe(false);
    expect(d.embeddedHosts).not.toContain("www.zorgneticuro.be");
    expect(d.visibleTextChars).toBeGreaterThan(300);
    expect(d.linkCount).toBeGreaterThan(10);
    expect(d.frames).toEqual([]);
  });

  it("rule 2: static mode with an embedded host says to switch to Browser mode", () => {
    const d = diagnosePage(base);
    expect(d.hint).toMatch(/loads content from .*widgets\.example-ats\.test.*Browser mode/);
  });

  it("rule 3: browser mode with an embedded host suggests the service's own page", () => {
    const frames = [{ url: "https://www.jobat.be/x", included: true }];
    const d = diagnosePage({ ...base, modeUsed: "browser", frames });
    expect(d.hint).toMatch(/embedded service \(.*widgets\.example-ats\.test.*\)/);
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

const FIOLA_URL = "https://fiolavzw.be/vacatures/";
const FIOLA_HTML = `<html><body><h1>Vacatures</h1><p>${"Werken bij Fiola. ".repeat(40)}</p>
  <a href="https://fiola-vzw.jobtoolz.com/nl/begeleider-inclusieve-kinderopvang-fie-ola-herzele">Begeleider</a>
  <a href="https://fiola-vzw.jobtoolz.com/nl/poetshulp">Poetshulp</a>
  <a href="/contact">Contact</a><a href="https://fiolavzw.be/over-ons">Over ons</a></body></html>`;

describe("findPortals", () => {
  it("finds Jobtoolz links, one entry per host, and derives the root with the language segment", () => {
    const p = findPortals(FIOLA_HTML, FIOLA_URL);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: "Jobtoolz", host: "fiola-vzw.jobtoolz.com" });
    expect(p[0]).toMatchObject({ kind: "link", companySpecific: true, rootUrl: "https://fiola-vzw.jobtoolz.com/nl" });
    const r = findPortals(`<a href="https://acme.recruitee.com/o/some-job">x</a>`, FIOLA_URL)[0];
    expect(r).toMatchObject({ companySpecific: true, rootUrl: "https://acme.recruitee.com/" });
  });

  it("recognises the Jobat script on the real zorgneticuro fixture", () => {
    const p = findPortals(HTML, URL_);
    expect(p.find((x) => x.name === "Jobat")).toMatchObject({ host: "www.jobat.be", kind: "script", companySpecific: false });
  });

  it("ignores same-host links and unknown hosts", () => {
    expect(findPortals(`<a href="https://fiola-vzw.jobtoolz.com/nl/x">x</a>`, "https://fiola-vzw.jobtoolz.com/nl")).toEqual([]);
    expect(findPortals(`<a href="https://example.com/x">x</a><a href="https://notjobtoolz.com/x">y</a>`, FIOLA_URL)).toEqual([]);
  });

  it("prefers link over frame over script per host, and classifies company-specific hosts", () => {
    const html = `<script src="https://acme.teamtailor.com/e.js"></script><iframe src="https://acme.teamtailor.com/jobs"></iframe>
      <script src="https://www.homerun.co/x.js"></script><script src="https://apply.workable.com/a.js"></script>
      <a href="https://talents.vaia.com/companies/zorg-x/jobs">v</a>`;
    const p = findPortals(html, FIOLA_URL);
    expect(p.find((x) => x.host === "acme.teamtailor.com")).toMatchObject({ kind: "frame", companySpecific: true });
    expect(p.find((x) => x.host === "www.homerun.co")).toMatchObject({ companySpecific: false });
    expect(p.find((x) => x.host === "apply.workable.com")).toMatchObject({ companySpecific: false });
    expect(p.find((x) => x.host === "talents.vaia.com")).toMatchObject({ companySpecific: true, rootUrl: "https://talents.vaia.com/companies/zorg-x" });
  });

  it("recognises iframes and protocol-relative scripts", () => {
    const html = `<iframe src="//apply.workable.com/acme/"></iframe><script src="https://jobs.example.teamtailor.com/embed.js"></script>`;
    expect(findPortals(html, FIOLA_URL).map((p) => p.name)).toEqual(["Workable", "Teamtailor"]);
  });
});

describe("diagnosePage portal hint", () => {
  const fiola = { html: FIOLA_HTML, pageUrl: FIOLA_URL, modeUsed: "static" as const, frames: [], llmUsed: false, itemCount: 0, llmAvailable: true };
  const HINT = /hosted on Jobtoolz \(fiola-vzw\.jobtoolz\.com\)\. For the most reliable results, add https:\/\/fiola-vzw\.jobtoolz\.com\/nl as a source\./;

  it("fires with zero items and exposes portals", () => {
    const d = diagnosePage(fiola);
    expect(d.hint).toMatch(HINT);
    expect(d.portals).toHaveLength(1);
  });

  it("goes before rule 2/3 (embedded hosts) but after rule 1 (almost empty page)", () => {
    const withScript = FIOLA_HTML.replace("</body>", `<script src="https://widgets.example-ats.test/w.js"></script></body>`);
    expect(diagnosePage({ ...fiola, html: withScript }).hint).toMatch(HINT);
    expect(diagnosePage({ ...fiola, html: withScript, modeUsed: "browser" }).hint).toMatch(HINT);
    const tiny = `<html><body><a href="https://fiola-vzw.jobtoolz.com/nl/x">x</a></body></html>`;
    expect(diagnosePage({ ...fiola, html: tiny }).hint).toMatch(/almost empty/);
  });

  it("fires when every item is on the page's own host while portal links exist", () => {
    const own = ["https://fiolavzw.be/vacatures/a", "https://fiolavzw.be/vacatures/b"];
    expect(diagnosePage({ ...fiola, itemCount: 2, itemUrls: own }).hint).toMatch(HINT);
    expect(diagnosePage({ ...fiola, itemCount: 2, itemUrls: [...own, "https://fiola-vzw.jobtoolz.com/nl/c"] }).hint).toBeNull();
    expect(diagnosePage({ ...fiola, itemCount: 2 }).hint).toBeNull();
  });

  it("script-only or generic portals get the Browser-mode script hint, with no add-source hint", () => {
    const d = diagnosePage({ ...base, html: HTML, pageUrl: URL_ });
    expect(d.portals[0]).toMatchObject({ name: "Jobat", kind: "script", companySpecific: false });
    expect(d.hint).toBe("This page loads its vacancies from Jobat with a script. Use Browser mode; the app then captures the widget's content.");
    const b = diagnosePage({ ...base, html: HTML, pageUrl: URL_, modeUsed: "browser" });
    expect(b.hint).toBe("This page loads its vacancies from Jobat with a script, but nothing was captured. The widget may require interaction or block automated visitors.");
  });

  it("the Fiola fixture, with items found all on jobtoolz, has no hint", () => {
    const html = fixture("fiola_list.html");
    const urls = ["https://fiola-vzw.jobtoolz.com/nl/a", "https://fiola-vzw.jobtoolz.com/nl/b"];
    const d = diagnosePage({ ...fiola, html, itemCount: 2, itemUrls: urls });
    expect(d.portals[0]).toMatchObject({ host: "fiola-vzw.jobtoolz.com", companySpecific: true });
    expect(d.hint).toBeNull();
  });

  it("has no portals and no portal hint on pages without portal links", () => {
    const d = diagnosePage({ ...fiola, html: "<html><body>" + "<p>text text text</p>".repeat(60) + "</body></html>", llmUsed: false });
    expect(d.portals).toEqual([]);
  });
});
