import type { ListingItem, Recipe, Settings } from "../../shared/types";
import { applyRecipe, recipeLooksHealthy } from "../extract/recipe";
import type { LlmClient } from "./client";
import { buildRecipePrompt, buildRecipeRetryPrompt, buildRecipeSystem } from "./prompts";
import { RecipeSchema, type RecipeOutput } from "./schemas";

function toRecipe(o: RecipeOutput): Recipe {
  return {
    itemSelector: o.item_selector.trim(),
    titleSelector: o.title_selector.trim(),
    linkSelector: o.link_selector.trim(),
    organizationSelector: o.organization_selector.trim(),
    locationSelector: o.location_selector.trim(),
    dateSelector: o.date_selector.trim(),
    nextPageSelector: o.next_page_selector.trim(),
  };
}

function describeProblem(items: ListingItem[]): { problem: string; sample: string } {
  if (items.length === 0) {
    return { problem: "the item selector matched 0 vacancies with a usable title and link", sample: "" };
  }
  const sample = items
    .slice(0, 5)
    .map((i) => `- title: ${JSON.stringify(i.title.slice(0, 120))} | url: ${i.url}`)
    .join("\n");
  const urls = new Set(items.map((i) => i.url));
  if (items.length > 1 && urls.size === 1) {
    return { problem: "all extracted links are identical, so the link selector is wrong", sample };
  }
  const goodTitles = items.filter((i) => i.title.length >= 4 && i.title.length <= 200).length;
  if (goodTitles / items.length < 0.6) {
    return {
      problem: "most extracted titles are empty, too short or far too long, so the title selector is wrong",
      sample,
    };
  }
  return { problem: "the extracted items do not look like a list of vacancies", sample };
}

/**
 * Ask the model for a recipe, validate it against the RAW html (what the
 * scanner will really apply it to), retry once with feedback, and return it
 * only if it yields a healthy item list.
 */
export async function learnRecipe(
  llm: LlmClient,
  settings: Settings,
  cleanedHtml: string,
  url: string,
  rawHtml: string,
): Promise<Recipe | null> {
  // Deliberately not cached (cache: false): the system prompt is ~460 tokens, below the 512-token minimum
  // for Opus/Sonnet/Haiku 5.5 (the API silently ignores the marker), the page content differs per call and
  // there is no reuse; a marker would only add the 1.25x write premium. See DESIGN.md section 20.
  const system = buildRecipeSystem();
  const base = buildRecipePrompt(cleanedHtml, url);

  const ask = async (user: string): Promise<Recipe | null> => {
    const { data } = await llm.structured({
      purpose: "learn_recipe",
      model: settings.utilityModel,
      effort: settings.effort,
      maxTokens: 4000,
      system: [{ text: system, cache: false }],
      user,
      schema: RecipeSchema,
    });
    if (!data.found || !data.item_selector.trim()) return null;
    return toRecipe(data);
  };

  const first = await ask(base);
  if (!first) return null;
  const firstItems = applyRecipe(rawHtml, url, first);
  if (recipeLooksHealthy(firstItems)) return first;

  const { problem, sample } = describeProblem(firstItems);
  const second = await ask(`${base}\n\n---\n\n${buildRecipeRetryPrompt(first, problem, sample)}`);
  if (!second) return null;
  return recipeLooksHealthy(applyRecipe(rawHtml, url, second)) ? second : null;
}
