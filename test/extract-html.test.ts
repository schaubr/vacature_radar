import { describe, expect, it } from "vitest";
import { cleanHtmlForLlm, extractMainText, looksJsRendered, sha256, visibleTextLength } from "../src/core/extract/html";
import { fixture } from "./helpers";

describe("looksJsRendered", () => {
  it("is false for the static vvsg listing", () => {
    expect(looksJsRendered(fixture("vvsg_list.html"))).toBe(false);
  });
  it("is true for an Angular shell", () => {
    const shell = `<html><head><title>VDAB</title><script src="main.js"></script></head><body><app-root ng-version="19"></app-root><noscript>Enable JavaScript</noscript></body></html>`;
    expect(looksJsRendered(shell)).toBe(true);
  });
  it("is true for a text-rich page with an #app shell and few links", () => {
    const text = "woord ".repeat(600);
    expect(looksJsRendered(`<body><div id="app"><p>${text}</p></div></body>`)).toBe(true);
    expect(looksJsRendered(`<body><div><p>${text}</p></div></body>`)).toBe(false);
  });
});

describe("visibleTextLength", () => {
  it("ignores scripts and styles", () => {
    expect(visibleTextLength("<body><script>var a=1234567890;</script><style>p{}</style><p>abc</p></body>")).toBe(3);
  });
});

describe("cleanHtmlForLlm", () => {
  const html = fixture("vdab_list.html");
  const cleaned = cleanHtmlForLlm(html);
  it("strips angular attributes, scripts and data attributes", () => {
    expect(cleaned).not.toMatch(/_ngcontent|_nghost|<script|<style|data-/);
    expect(cleaned).not.toContain("style=");
  });
  it("keeps the title line and links", () => {
    expect(cleaned.split("\n")[0].length).toBeGreaterThan(0);
    expect(cleaned).toContain("c-vacature__content-title");
    expect(cleaned).toContain("/vindeenjob/vacatures/");
  });
  it("shrinks every fixture", () => {
    for (const f of ["vdab_list.html", "vvsg_list.html", "jobsolutions_list.html"]) {
      const raw = fixture(f);
      expect(cleanHtmlForLlm(raw).length).toBeLessThan(raw.length * 0.6);
    }
    expect(cleaned.length).toBeLessThan(html.length * 0.5);
  });
  it("respects maxChars", () => {
    expect(cleanHtmlForLlm(html, 5000).length).toBeLessThanOrEqual(5000);
  });
  it("prefers main subtree when the whole body does not fit", () => {
    const body = `<header><a href="/a">x</a></header><main>${'<li><a href="/j">job title here</a></li>'.repeat(20)}</main><footer>${"foot ".repeat(400)}</footer>`;
    const out = cleanHtmlForLlm(`<html><head><title>T</title></head><body>${body}</body></html>`, 1500);
    expect(out).toContain("job title here");
    expect(out).not.toContain("foot foot");
  });
  it("removes comments and empty elements", () => {
    const out = cleanHtmlForLlm(`<html><body><!-- c --><div><span></span></div><p data-x="1" style="x">hi</p></body></html>`);
    expect(out).toBe("<p>hi</p>");
  });
});

describe("extractMainText", () => {
  it("contains the job title for the detail fixtures", () => {
    expect(extractMainText(fixture("vdab_detail.html"))).toContain("Consultant Maatschappelijk werk");
    const js = extractMainText(fixture("jobsolutions_detail.html"));
    expect(js.length).toBeGreaterThan(200);
    expect(extractMainText(fixture("vvsg_detail.html")).length).toBeGreaterThan(200);
  });
  it("drops nav, cookie banners and scripts, keeps block structure", () => {
    const t = extractMainText(
      `<body><nav>Menu</nav><div class="cookie-banner">Accept</div><main><h1>Title</h1><p>One</p><p>Two</p><script>x</script></main></body>`,
    );
    expect(t).toBe("Title\nOne\nTwo");
  });
  it("truncates", () => {
    expect(extractMainText(`<body><p>${"a".repeat(100)}</p></body>`, 10)).toHaveLength(10);
  });
});

describe("sha256", () => {
  it("is a hex digest", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
