import { describe, expect, it } from "vitest";
import { canonicalizeUrl, resolveUrl } from "../src/core/extract/urls";

describe("resolveUrl", () => {
  const base = "https://www.vvsg.be/vacatures/overzicht";
  it("resolves relative and absolute links", () => {
    expect(resolveUrl("/jobs/1", base)).toBe("https://www.vvsg.be/jobs/1");
    expect(resolveUrl("detail?id=2", base)).toBe("https://www.vvsg.be/vacatures/detail?id=2");
    expect(resolveUrl("https://x.be/a", base)).toBe("https://x.be/a");
  });
  it("ignores non-navigable links", () => {
    for (const h of ["javascript:void(0)", "mailto:a@b.be", "tel:+32", "#top", "", "  ", null, undefined]) {
      expect(resolveUrl(h as string, base)).toBeNull();
    }
  });
});

describe("canonicalizeUrl", () => {
  it("drops VDAB tracking params", () => {
    expect(
      canonicalizeUrl("https://www.vdab.be/vindeenjob/vacatures/74890892/maatschappelijk-werker?source=vindeenjob&medium=vacaturedashboard"),
    ).toBe("https://www.vdab.be/vindeenjob/vacatures/74890892/maatschappelijk-werker");
  });
  it("lowercases host, drops fragment and trailing slash, sorts params", () => {
    expect(canonicalizeUrl("https://WWW.Example.BE/Jobs/?b=2&a=1&utm_source=x&fbclid=z#frag")).toBe(
      "https://www.example.be/Jobs?a=1&b=2",
    );
    expect(canonicalizeUrl("https://example.be/")).toBe("https://example.be/");
  });
  it("removes the Drupal index.php prefix in both spellings", () => {
    const a = canonicalizeUrl("https://www.vvsg.be/vacatures/overzicht-vacatures/x");
    expect(canonicalizeUrl("https://www.vvsg.be/index%2Ephp/vacatures/overzicht-vacatures/x")).toBe(a);
    expect(canonicalizeUrl("https://www.vvsg.be/index.php/vacatures/overzicht-vacatures/x")).toBe(a);
    expect(canonicalizeUrl("https://www.vvsg.be/index.php")).toBe("https://www.vvsg.be/");
  });
  it("returns invalid urls unchanged", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});
