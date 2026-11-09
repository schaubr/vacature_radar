import type { ExtractStrategy, ListingItem, Recipe } from "../../shared/types";
import { compactAnchors } from "./anchors";
import { isFeed, parseFeed } from "./feed";
import { cleanHtmlForLlm } from "./html";
import { findJobPostings, jobPostingsToItems } from "./jsonld";
import { applyRecipe, recipeLooksHealthy } from "./recipe";

export interface ListingContext {
  url: string;
  html: string;
  contentType: string;
  existingRecipe: Recipe | null;
  learnRecipe?: (cleanedHtml: string, url: string) => Promise<Recipe | null>;
  llmExtract?: (compact: string, url: string) => Promise<ListingItem[]>;
}
export interface ListingResult {
  items: ListingItem[];
  strategy: ExtractStrategy | null;
  recipe: Recipe | null;
}

const NON_VACANCY = [
  "spontane sollicitatie",
  "spontaan solliciteren",
  "solliciteer spontaan",
  "open sollicitatie",
  "open application",
  "spontaneous application",
  "candidature spontanee",
];

/** True for listing entries that are only an open/spontaneous application, not a vacancy. */
export function isNonVacancyTitle(title: string): boolean {
  const t = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return NON_VACANCY.includes(t);
}

/** Runs the extraction tiers and drops non-vacancy entries (open applications) from whichever tier answered. */
export async function extractListing(ctx: ListingContext): Promise<ListingResult> {
  const r = await extractTiers(ctx);
  return { ...r, items: r.items.filter((i) => !isNonVacancyTitle(i.title)) };
}

async function extractTiers(ctx: ListingContext): Promise<ListingResult> {
  const { url, html, existingRecipe } = ctx;

  // 1. feed
  if (isFeed(ctx.contentType, html)) {
    const items = parseFeed(html, url);
    if (items.length > 0) return { items, strategy: "feed", recipe: existingRecipe };
  }

  // 2. JSON-LD job postings
  const ld = jobPostingsToItems(findJobPostings(html), url);
  if (ld.length >= 2) return { items: ld, strategy: "jsonld", recipe: existingRecipe };

  // 3. stored recipe
  if (existingRecipe) {
    const items = applyRecipe(html, url, existingRecipe);
    if (recipeLooksHealthy(items)) return { items, strategy: "recipe", recipe: existingRecipe };
  }

  let firstError: unknown = null;

  // 4. learn a new recipe
  if (ctx.learnRecipe) {
    try {
      const recipe = await ctx.learnRecipe(cleanHtmlForLlm(html), url);
      if (recipe) {
        const items = applyRecipe(html, url, recipe);
        if (recipeLooksHealthy(items)) return { items, strategy: "recipe", recipe };
      }
    } catch (e) {
      firstError = e;
    }
  }

  // 5. direct LLM extraction from the anchor list
  if (ctx.llmExtract) {
    try {
      const compact = compactAnchors(html, url);
      if (compact) {
        const items = await ctx.llmExtract(compact, url);
        if (items.length > 0) return { items, strategy: "llm", recipe: existingRecipe };
      }
    } catch (e) {
      firstError ??= e;
    }
  }

  if (firstError) throw firstError;
  return { items: [], strategy: null, recipe: existingRecipe };
}
