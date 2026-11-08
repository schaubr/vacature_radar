import { describe, expect, it, vi } from "vitest";
import { extractListing } from "../src/core/extract/listing";
import type { ListingItem, Recipe } from "../src/shared/types";
import { fixture, JOBSOLUTIONS_RECIPE, JOBSOLUTIONS_URL, VDAB_RECIPE, VDAB_URL, VVSG_URL } from "./helpers";

const item = (n: number): ListingItem => ({ title: `Job number ${n}`, url: `https://x.be/j/${n}`, organization: "", location: "", dateText: "", snippet: "" });
const BAD: Recipe = { ...VDAB_RECIPE, itemSelector: ".does-not-exist" };

describe("extractListing tier order", () => {
  it("1. feed wins", async () => {
    const rss = `<rss><channel><item><title>Sociaal werker</title><link>https://x.be/1</link></item></channel></rss>`;
    const learn = vi.fn();
    const r = await extractListing({ url: "https://x.be/feed", html: rss, contentType: "application/rss+xml", existingRecipe: null, learnRecipe: learn });
    expect(r.strategy).toBe("feed");
    expect(r.items).toHaveLength(1);
    expect(learn).not.toHaveBeenCalled();
  });
  it("2. json-ld needs at least two postings", async () => {
    const ld = (n: number) =>
      `<script type="application/ld+json">${JSON.stringify(Array.from({ length: n }, (_, i) => ({ "@type": "JobPosting", title: `Posting ${i}`, url: `/p/${i}` })))}</script>`;
    const two = await extractListing({ url: "https://x.be/", html: ld(2), contentType: "text/html", existingRecipe: null });
    expect(two.strategy).toBe("jsonld");
    expect(two.items).toHaveLength(2);
    const one = await extractListing({ url: "https://x.be/", html: ld(1), contentType: "text/html", existingRecipe: null });
    expect(one).toEqual({ items: [], strategy: null, recipe: null });
  });
  it("3. healthy existing recipe is used without LLM", async () => {
    const learn = vi.fn();
    const llm = vi.fn();
    const r = await extractListing({ url: VDAB_URL, html: fixture("vdab_list.html"), contentType: "text/html", existingRecipe: VDAB_RECIPE, learnRecipe: learn, llmExtract: llm });
    expect(r.strategy).toBe("recipe");
    expect(r.recipe).toEqual(VDAB_RECIPE);
    expect(r.items).toHaveLength(15);
    expect(learn).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });
  it("4. broken recipe falls through to learnRecipe, which receives cleaned html", async () => {
    const learn = vi.fn(async (_c: string, _u: string) => JOBSOLUTIONS_RECIPE);
    const r = await extractListing({ url: JOBSOLUTIONS_URL, html: fixture("jobsolutions_list.html"), contentType: "text/html", existingRecipe: BAD, learnRecipe: learn });
    expect(r.strategy).toBe("recipe");
    expect(r.recipe).toEqual(JOBSOLUTIONS_RECIPE);
    expect(r.items.length).toBeGreaterThanOrEqual(10);
    const [cleaned, url] = learn.mock.calls[0];
    expect(url).toBe(JOBSOLUTIONS_URL);
    expect(cleaned.length).toBeLessThan(fixture("jobsolutions_list.html").length / 2);
  });
  it("5. unhealthy learned recipe falls through to llmExtract with the anchor list", async () => {
    const llm = vi.fn(async (_c: string, _u: string) => [item(1), item(2)]);
    const r = await extractListing({
      url: VVSG_URL, html: fixture("vvsg_list.html"), contentType: "text/html", existingRecipe: null,
      learnRecipe: async () => BAD, llmExtract: llm,
    });
    expect(r.strategy).toBe("llm");
    expect(r.items).toHaveLength(2);
    expect(llm.mock.calls[0][0]).toContain("| https://www.vvsg.be/vacatures/overzicht-vacatures/");
  });
  it("learnRecipe returning null goes on to llmExtract; keeps existing recipe in result", async () => {
    const r = await extractListing({
      url: VVSG_URL, html: fixture("vvsg_list.html"), contentType: "text/html", existingRecipe: BAD,
      learnRecipe: async () => null, llmExtract: async () => [item(3)],
    });
    expect(r.strategy).toBe("llm");
    expect(r.recipe).toEqual(BAD);
  });
  it("returns empty result when everything fails", async () => {
    const r = await extractListing({ url: VVSG_URL, html: "<html><body><p>nothing</p></body></html>", contentType: "text/html", existingRecipe: BAD, learnRecipe: async () => null, llmExtract: async () => [] });
    expect(r).toEqual({ items: [], strategy: null, recipe: BAD });
  });
  it("tolerates a throwing learnRecipe when llmExtract succeeds, rethrows when nothing does", async () => {
    const ok = await extractListing({
      url: VVSG_URL, html: fixture("vvsg_list.html"), contentType: "text/html", existingRecipe: null,
      learnRecipe: async () => { throw new Error("budget"); }, llmExtract: async () => [item(1)],
    });
    expect(ok.strategy).toBe("llm");
    await expect(
      extractListing({ url: VVSG_URL, html: fixture("vvsg_list.html"), contentType: "text/html", existingRecipe: null, learnRecipe: async () => { throw new Error("budget"); } }),
    ).rejects.toThrow("budget");
  });
});
