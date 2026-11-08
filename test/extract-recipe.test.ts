import { describe, expect, it } from "vitest";
import { applyRecipe, findNextPage, recipeLooksHealthy } from "../src/core/extract/recipe";
import type { Recipe } from "../src/shared/types";
import { fixture, JOBSOLUTIONS_RECIPE, JOBSOLUTIONS_URL, VDAB_RECIPE, VDAB_URL, VVSG_RECIPE, VVSG_URL } from "./helpers";

describe("applyRecipe on fixtures", () => {
  it("vdab_list: 15 healthy items with canonical absolute urls", () => {
    const items = applyRecipe(fixture("vdab_list.html"), VDAB_URL, VDAB_RECIPE);
    expect(items).toHaveLength(15);
    expect(recipeLooksHealthy(items)).toBe(true);
    expect(items[0].url).toBe("https://www.vdab.be/vindeenjob/vacatures/74890892/maatschappelijk-werker");
    expect(items[0].title).toBe("Maatschappelijk werker");
    expect(items[0].organization).toBe("OCMW LENDELEDE");
    expect(items[0].location).toBe("LENDELEDE");
    expect(items.every((i) => i.url.startsWith("https://www.vdab.be/") && !i.url.includes("?"))).toBe(true);
    expect(items.every((i) => i.snippet.length <= 400 && i.snippet.length > 0)).toBe(true);
  });
  it("vvsg_list: items with organization, date and index.php-normalized urls", () => {
    const items = applyRecipe(fixture("vvsg_list.html"), VVSG_URL, VVSG_RECIPE);
    expect(items).toHaveLength(5); // fixture only contains 5 cards
    expect(recipeLooksHealthy(items)).toBe(true);
    expect(items.every((i) => i.url.startsWith("https://www.vvsg.be/vacatures/"))).toBe(true);
    expect(items.some((i) => i.url.includes("index"))).toBe(false);
    expect(items[0].organization).toBe("Lokaal bestuur Lommel");
    expect(items[0].dateText).toBe("08/11/2026");
    expect(items[0].title).toBe("Teamcoach samenleven");
  });
  it("jobsolutions_list: item is the link itself", () => {
    const items = applyRecipe(fixture("jobsolutions_list.html"), JOBSOLUTIONS_URL, JOBSOLUTIONS_RECIPE);
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(recipeLooksHealthy(items)).toBe(true);
    expect(items[0].url).toBe("https://www.jobsolutions.be/jobs/18042-technisch-assistent-netheid-openbaar-domein");
    expect(items[0].title).toBe("Technisch assistent netheid openbaar domein");
    expect(items[0].organization).toContain("Stad Nieuwpoort");
  });
});

describe("applyRecipe semantics", () => {
  const base: Recipe = {
    itemSelector: "li", titleSelector: "", linkSelector: "", organizationSelector: "", locationSelector: "",
    dateSelector: "", nextPageSelector: "",
  };
  it("uses item text and first a[href] for empty selectors", () => {
    const items = applyRecipe(`<ul><li><span>Sociaal werker</span> <a href="/a">meer</a></li></ul>`, "https://x.be/", base);
    expect(items).toEqual([
      { title: "Sociaal werker meer", url: "https://x.be/a", organization: "", location: "", dateText: "", snippet: "Sociaal werker meer" },
    ]);
  });
  it("returns [] for invalid selectors", () => {
    expect(applyRecipe("<li>a</li>", "https://x.be/", { ...base, itemSelector: "li[" })).toEqual([]);
    expect(applyRecipe("<li>a</li>", "https://x.be/", { ...base, itemSelector: "" })).toEqual([]);
    expect(applyRecipe("<li><a href='/a'>abcd</a></li>", "https://x.be/", { ...base, titleSelector: "a:::x" })).toEqual([]);
  });
  it("skips items without title or url and dedupes by url", () => {
    const html = `<ul><li><a href="/a">First job</a></li><li><a href="/a?utm_source=z">First job again</a></li><li>No link here</li><li><a href="javascript:x()">JS link</a></li><li><a href="/b"></a></li></ul>`;
    const items = applyRecipe(html, "https://x.be/", base);
    expect(items.map((i) => i.url)).toEqual(["https://x.be/a"]);
  });
  it("missing sub-selector matches give empty strings", () => {
    const items = applyRecipe(`<li><h2>Titel hier</h2><a href="/a">x</a></li>`, "https://x.be/", {
      ...base, titleSelector: "h2", linkSelector: "a", organizationSelector: ".nope", locationSelector: "strong:last-child",
    });
    expect(items[0].organization).toBe("");
    expect(items[0].location).toBe("");
  });
  it("prefers the innermost match for nested items", () => {
    const html = `<ul class="x"><li class="job"><a href="/a">Outer job</a><ul><li class="job"><a href="/b">Inner job</a></li></ul></li></ul>`;
    const items = applyRecipe(html, "https://x.be/", { ...base, itemSelector: "li.job" });
    expect(items.map((i) => i.url)).toEqual(["https://x.be/b"]);
  });
  it("is robust to messy html and truncates snippet to 400 chars", () => {
    const html = `<li><a href=/a>${"long ".repeat(200)}<li><a>unclosed`;
    const items = applyRecipe(html, "https://x.be/", base);
    expect(items[0].snippet.length).toBeLessThanOrEqual(400);
  });
});

describe("findNextPage", () => {
  const r = { ...VVSG_RECIPE, nextPageSelector: "a.next" };
  it("resolves the next link", () => {
    expect(findNextPage(`<a class="next" href="?page=2">Volgende</a>`, "https://x.be/jobs", r)).toBe("https://x.be/jobs?page=2");
    expect(findNextPage(`<li class="next"><a href="/p/3#top">3</a></li>`, "https://x.be/jobs", { ...r, nextPageSelector: "li.next" })).toBe("https://x.be/p/3");
  });
  it("returns null when absent, empty, invalid or self-referencing", () => {
    expect(findNextPage("<p>none</p>", "https://x.be/", r)).toBeNull();
    expect(findNextPage("<a class='next' href='#'>x</a>", "https://x.be/", r)).toBeNull();
    expect(findNextPage("<a>x</a>", "https://x.be/", { ...r, nextPageSelector: "" })).toBeNull();
    expect(findNextPage("<a>x</a>", "https://x.be/", { ...r, nextPageSelector: "a[" })).toBeNull();
    expect(findNextPage(`<a class="next" href="/jobs">x</a>`, "https://x.be/jobs", r)).toBeNull();
  });
});

describe("recipeLooksHealthy", () => {
  const it1 = (title: string, url: string) => ({ title, url, organization: "", location: "", dateText: "", snippet: "" });
  it("needs items, decent titles and distinct urls", () => {
    expect(recipeLooksHealthy([])).toBe(false);
    expect(recipeLooksHealthy([it1("Good title", "https://x.be/1")])).toBe(true);
    expect(recipeLooksHealthy([it1("ab", "https://x.be/1"), it1("cd", "https://x.be/2")])).toBe(false);
    expect(recipeLooksHealthy([it1("Good title", "https://x.be/1"), it1("Good title 2", "https://x.be/1")])).toBe(false);
    expect(recipeLooksHealthy([it1("x".repeat(201), "https://x.be/1"), it1("Good title", "https://x.be/2")])).toBe(false);
    expect(
      recipeLooksHealthy([it1("Good one", "u1"), it1("Good two", "u2"), it1("Good three", "u3"), it1("x", "u4"), it1("y", "u5")]),
    ).toBe(true); // exactly 60%
  });
});
