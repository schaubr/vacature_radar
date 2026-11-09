import { describe, expect, it } from "vitest";
import { cleanHtmlForLlm, extractMainText } from "../src/core/extract/html";
import { inlineFrames } from "../src/core/extract/frames";

const ifr = (u: string) => `<iframe src="${u}" data-vr-frame="${u}"></iframe>`;

describe("inlineFrames", () => {
  it("replaces the matching iframe in place", () => {
    const out = inlineFrames(`<body><main>A${ifr("https://w.example/x")}B</main></body>`, [{ url: "https://w.example/x", html: "<p>hi</p>" }]);
    expect(out).toBe(`<body><main>A<section data-vr-frame-src="https://w.example/x"><p>hi</p></section>B</main></body>`);
  });
  it("appends before </body> when nothing matches", () => {
    const out = inlineFrames(`<body><main>A</main></body>`, [{ url: "https://w.example/x", html: "<p>hi</p>" }]);
    expect(out).toBe(`<body><main>A</main><section data-vr-frame-src="https://w.example/x"><p>hi</p></section></body>`);
  });
  it("handles multiple frames, mixing matched and unmatched", () => {
    const out = inlineFrames(`<body>${ifr("https://a.example/")}${ifr("https://b.example/")}</body>`, [
      { url: "https://b.example/", html: "B" },
      { url: "https://c.example/", html: "C" },
    ]);
    expect(out).toContain(`${ifr("https://a.example/")}<section data-vr-frame-src="https://b.example/">B</section>`);
    expect(out).toMatch(/<section data-vr-frame-src="https:\/\/c.example\/">C<\/section><\/body>$/);
  });
  it("uses each iframe once when the same url appears twice", () => {
    const out = inlineFrames(`<body>${ifr("https://a.example/w")}-${ifr("https://a.example/w")}</body>`, [
      { url: "https://a.example/w", html: "1" },
      { url: "https://a.example/w", html: "2" },
    ]);
    expect(out).toBe(`<body><section data-vr-frame-src="https://a.example/w">1</section>-<section data-vr-frame-src="https://a.example/w">2</section></body>`);
  });
  it("ignores fragments and trailing slashes, and unescapes attributes", () => {
    const html = `<body><iframe data-vr-frame="https://a.example/w?x=1&amp;y=2/"></iframe></body>`;
    const out = inlineFrames(html, [{ url: "https://a.example/w?x=1&y=2#top", html: "Z" }]);
    expect(out).toBe(`<body><section data-vr-frame-src="https://a.example/w?x=1&amp;y=2#top">Z</section></body>`);
  });
});

describe("frame sections outside the main content", () => {
  const frame = `<section data-vr-frame-src="https://w.example/x"><ul>${[1, 2, 3].map((n) => `<li><a href="https://w.example/job/${n}">Widget job ${n}</a></li>`).join("")}</ul></section>`;
  const filler = Array.from({ length: 400 }, (_, i) => `<p>Filler paragraph number ${i} with some words.</p>`).join("");
  const page = `<html><head><title>T</title></head><body><div>${filler}</div><main>${filler}</main>${frame}</body></html>`;

  it("cleanHtmlForLlm keeps the frame links when it narrows to <main>", () => {
    const out = cleanHtmlForLlm(page, filler.length + 1000);
    expect(out).toContain("data-vr-frame-src");
    expect(out).toContain("https://w.example/job/3");
    expect(out.length).toBeLessThanOrEqual(filler.length + 1000);
  });
  it("extractMainText appends frame text outside main", () => {
    const out = extractMainText(`<html><body><main><p>Detail text</p></main>${frame}</body></html>`);
    expect(out).toContain("Detail text");
    expect(out).toContain("Widget job 2");
  });
});
