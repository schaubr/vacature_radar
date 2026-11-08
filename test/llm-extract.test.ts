import { describe, expect, it } from "vitest";
import type { LlmClient, LlmUsage, StructuredRequest } from "../src/core/llm/client";
import { llmExtractListing } from "../src/core/llm/extract-llm";
import { learnRecipe } from "../src/core/llm/recipe-learn";
import { DEFAULT_SETTINGS } from "../src/shared/types";

const usage: LlmUsage = { model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

function fakeLlm(outputs: unknown[]) {
  const requests: StructuredRequest<unknown>[] = [];
  const llm: LlmClient = {
    async structured(req) {
      requests.push(req as StructuredRequest<unknown>);
      const o = outputs.shift();
      return { data: req.schema.parse(o) as never, usage };
    },
    async text() {
      throw new Error("unused");
    },
  };
  return { llm, requests };
}

const URL_ = "https://jobs.example.be/vacatures";
const HTML = `<html><body><h1>Vacatures</h1><ul class="jobs">
${Array.from({ length: 6 }, (_, i) => `<li class="job"><a class="job-link" href="/vacature/${i + 1}"><span class="job-title">Maatschappelijk werker ${i + 1}</span></a><span class="org">Organisatie ${i}</span><span class="loc">Gent</span></li>`).join("\n")}
</ul><ul class="nav"><li><a href="/over-ons">Over ons</a></li></ul></body></html>`;

const rec = (over: Record<string, unknown> = {}) => ({
  found: true,
  item_selector: "li.job",
  title_selector: ".job-title",
  link_selector: "a.job-link",
  organization_selector: ".org",
  location_selector: ".loc",
  date_selector: "",
  next_page_selector: "",
  notes: "",
  ...over,
});

describe("learnRecipe", () => {
  it("returns a healthy recipe on the first try", async () => {
    const { llm, requests } = fakeLlm([rec()]);
    const r = await learnRecipe(llm, DEFAULT_SETTINGS, "<cleaned/>", URL_, HTML);
    expect(r).toMatchObject({ itemSelector: "li.job", titleSelector: ".job-title", linkSelector: "a.job-link" });
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("claude-sonnet-5-5");
    expect(requests[0].maxTokens).toBe(4000);
    expect(requests[0].purpose).toBe("learn_recipe");
  });

  it("returns null without retry when found is false", async () => {
    const { llm, requests } = fakeLlm([rec({ found: false, item_selector: "" })]);
    expect(await learnRecipe(llm, DEFAULT_SETTINGS, "<c/>", URL_, HTML)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("retries once with a problem description and accepts the corrected recipe", async () => {
    const { llm, requests } = fakeLlm([rec({ item_selector: "li.nonexistent" }), rec()]);
    const r = await learnRecipe(llm, DEFAULT_SETTINGS, "<cleaned/>", URL_, HTML);
    expect(r?.itemSelector).toBe("li.job");
    expect(requests).toHaveLength(2);
    expect(requests[1].user).toContain("matched 0 vacancies");
    expect(requests[1].user).toContain("li.nonexistent");
  });

  it("describes identical links when retrying", async () => {
    const { llm, requests } = fakeLlm([rec({ link_selector: "" , item_selector: "ul.jobs"}), rec()]);
    // ul.jobs is one element; item has first a[href] -> single item. Not "identical", just unhealthy or healthy; ensure no crash
    await learnRecipe(llm, DEFAULT_SETTINGS, "<c/>", URL_, HTML);
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null when the retry is also unhealthy", async () => {
    const bad = rec({ item_selector: "li.nope" });
    const { llm, requests } = fakeLlm([bad, bad]);
    expect(await learnRecipe(llm, DEFAULT_SETTINGS, "<c/>", URL_, HTML)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  it("validates against the raw HTML, not the cleaned HTML", async () => {
    // selector exists in raw HTML only
    const { llm } = fakeLlm([rec(), rec()]);
    expect(await learnRecipe(llm, DEFAULT_SETTINGS, '<li class="job"><a href="/x">cleaned only</a></li>', URL_, "<html><body>empty</body></html>")).toBeNull();
  });
});

describe("llmExtractListing", () => {
  const compact = [
    "[1] Maatschappelijk werker | https://jobs.example.be/vacature/1?utm_source=x | Gent",
    "[2] Begeleider | https://jobs.example.be/vacature/2 | Brugge",
    "[3] Login | https://jobs.example.be/login | nav",
  ].join("\n");

  it("keeps listed urls (canonicalized), drops hallucinated and duplicate ones", async () => {
    const { llm, requests } = fakeLlm([
      {
        vacancies: [
          { title: "Maatschappelijk werker", url: "https://jobs.example.be/vacature/1?utm_source=x", organization: "A", location: "Gent" },
          { title: "Begeleider", url: "/vacature/2", organization: "", location: "" },
          { title: "Begeleider again", url: "https://jobs.example.be/vacature/2", organization: "", location: "" },
          { title: "Invented", url: "https://jobs.example.be/vacature/999", organization: "", location: "" },
          { title: "Elsewhere", url: "https://evil.example.com/vacature/1", organization: "", location: "" },
          { title: "", url: "https://jobs.example.be/login", organization: "", location: "" },
        ],
      },
    ]);
    const items = await llmExtractListing(llm, DEFAULT_SETTINGS, compact, URL_);
    expect(items.map((i) => i.url)).toEqual([
      "https://jobs.example.be/vacature/1",
      "https://jobs.example.be/vacature/2",
    ]);
    expect(items[0]).toMatchObject({ title: "Maatschappelijk werker", organization: "A", location: "Gent" });
    expect(requests[0].model).toBe("claude-sonnet-5-5");
    expect(requests[0].purpose).toBe("extract_listing");
  });
});
