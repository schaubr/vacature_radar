import { describe, expect, it } from "vitest";
import { findFeedLink, isFeed, parseFeed } from "../src/core/extract/feed";
import { fixture } from "./helpers";

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Jobs</title><link>https://x.be/</link>
<item><title>Sociaal werker</title><link>https://x.be/jobs/1?utm_source=rss</link><description>&lt;p&gt;Werken &lt;b&gt;bij&lt;/b&gt; ons&lt;/p&gt;</description><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><dc:creator>OCMW X</dc:creator></item>
<item><title>Zonder link</title></item>
<item><title>Tweede</title><link>/jobs/2</link></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom job</title><link rel="self" href="https://x.be/self"/><link rel="alternate" href="https://x.be/jobs/9"/><updated>2026-11-01T00:00:00Z</updated><summary>Kort</summary><author><name>Org Y</name></author></entry></feed>`;

describe("isFeed", () => {
  it("detects rss and atom, rejects html", () => {
    expect(isFeed("application/rss+xml", RSS)).toBe(true);
    expect(isFeed("text/html", RSS)).toBe(true); // wrong content type, valid body
    expect(isFeed("application/atom+xml", ATOM)).toBe(true);
    expect(isFeed("text/html", fixture("vvsg_list.html"))).toBe(false);
    expect(isFeed("application/xml", "<sitemap><url/></sitemap>")).toBe(false);
  });
});

describe("parseFeed", () => {
  it("parses RSS items", () => {
    const items = parseFeed(RSS, "https://x.be/feed");
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Sociaal werker", url: "https://x.be/jobs/1", organization: "OCMW X", location: "",
      dateText: "Mon, 02 Nov 2026 10:00:00 GMT", snippet: "Werken bij ons",
    });
    expect(items[1].url).toBe("https://x.be/jobs/2");
  });
  it("parses Atom entries", () => {
    const items = parseFeed(ATOM, "https://x.be/");
    expect(items).toEqual([
      { title: "Atom job", url: "https://x.be/jobs/9", organization: "Org Y", location: "", dateText: "2026-11-01T00:00:00Z", snippet: "Kort" },
    ]);
  });
});

describe("findFeedLink", () => {
  it("finds an alternate feed link", () => {
    expect(findFeedLink(`<head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head>`, "https://x.be/a/b")).toBe("https://x.be/rss.xml");
    expect(findFeedLink(fixture("vvsg_list.html"), "https://www.vvsg.be/vacatures")).toSatisfy((v: string | null) => v === null || v.startsWith("https://"));
    expect(findFeedLink("<head></head>", "https://x.be/")).toBeNull();
  });
});
