import { describe, expect, it } from "vitest";
import { extractDetail } from "../src/core/extract/detail";
import { findJobPostings, jobPostingsToItems } from "../src/core/extract/jsonld";
import { fixture } from "./helpers";

const ld = (json: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head><body></body></html>`;

describe("findJobPostings", () => {
  it("reads the vvsg_detail @graph posting", () => {
    const p = findJobPostings(fixture("vvsg_detail.html"));
    expect(p).toHaveLength(1);
    expect(p[0].title).toBe("Expert financiën");
    expect(p[0].organization).toBe("VVSG");
    expect(p[0].datePosted).toBe("2026-10-14T16:00:48+0200");
    expect(p[0].url).toBe(""); // the real fixture has no url or description
  });
  it("reads the vdab_detail plain posting with description and region", () => {
    const [p] = findJobPostings(fixture("vdab_detail.html"));
    expect(p.title).toBe("Consultant Maatschappelijk werk");
    expect(p.description).toContain("Valeris Experts");
    expect(p.organization).toBe("VALERIS EXPERTS");
    expect(p.location).toBe("Oost-Vlaanderen");
    expect(p.employmentType).toBe("FULL_TIME");
  });
  it("handles arrays, @graph, ItemList and @type arrays", () => {
    const html = ld([
      { "@type": ["JobPosting", "Thing"], title: "A job", url: "/a", description: "<p>Hello</p><p>World</p>" },
      { "@graph": [{ "@type": "WebPage" }, { "@type": "JobPosting", name: "B job", url: "/b" }] },
      {
        "@type": "ItemList",
        itemListElement: [
          { "@type": "ListItem", position: 1, item: { "@type": "JobPosting", title: "C job", url: "/c" } },
          { "@type": "JobPosting", title: "D job", url: "/d" },
        ],
      },
    ]);
    const p = findJobPostings(html);
    expect(p.map((x) => x.title)).toEqual(["A job", "B job", "C job", "D job"]);
    expect(p[0].description).toBe("Hello\nWorld");
  });
  it("builds a location from address parts and tolerates broken json", () => {
    const [p] = findJobPostings(
      ld({
        "@type": "JobPosting", title: "T",
        jobLocation: { "@type": "Place", address: { streetAddress: "Markt 1", postalCode: "8610", addressLocality: "Kortemark" } },
      }),
    );
    expect(p.location).toBe("Markt 1, 8610 Kortemark");
    expect(findJobPostings(`<script type="application/ld+json">{oops</script>`)).toEqual([]);
    expect(findJobPostings(`<script type="application/ld+json">{"@type":"JobPosting","title":"X\ny"}</script>`)[0].title).toBe("X y");
  });
});

describe("jobPostingsToItems", () => {
  it("keeps only postings with url, resolves and canonicalizes", () => {
    const items = jobPostingsToItems(
      findJobPostings(ld([{ "@type": "JobPosting", title: "A", url: "/a?utm_x=1", description: "d".repeat(900) }, { "@type": "JobPosting", title: "No url" }])),
      "https://x.be/list",
    );
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe("https://x.be/a");
    expect(items[0].snippet).toHaveLength(400);
  });
});

describe("extractDetail", () => {
  it("builds text from JSON-LD (vdab)", () => {
    const d = extractDetail(fixture("vdab_detail.html"), "https://www.vdab.be/x");
    expect(d.text).toContain("Title: Consultant Maatschappelijk werk");
    expect(d.text).toContain("Organization: VALERIS EXPERTS");
    expect(d.text).toContain("Begeleiden van cliënten");
    expect(d.organization).toBe("VALERIS EXPERTS");
    expect(d.location).toBe("Oost-Vlaanderen");
    expect(d.datePosted).toBe("2026-04-08T08:20:00Z");
  });
  it("appends main text when the JSON-LD description is short (vvsg)", () => {
    const d = extractDetail(fixture("vvsg_detail.html"), "https://www.vvsg.be/x");
    expect(d.text).toContain("Title: Expert financiën");
    expect(d.text.length).toBeGreaterThan(1000);
    expect(d.organization).toBe("VVSG");
  });
  it("falls back to main text without JSON-LD (jobsolutions)", () => {
    const d = extractDetail(fixture("jobsolutions_detail.html"), "https://www.jobsolutions.be/x");
    expect(d.text.length).toBeGreaterThan(300);
    expect(d.organization).toBe("");
  });
});
