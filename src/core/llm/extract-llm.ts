import type { ListingItem, Settings } from "../../shared/types";
import { canonicalizeUrl, resolveUrl } from "../extract/urls";
import type { LlmClient } from "./client";
import { buildListingExtractPrompt, buildListingExtractSystem } from "./prompts";
import { ListingExtractSchema } from "./schemas";

/** URLs present in the compact anchor list ("[n] text | url | context"). */
function urlsInCompact(compact: string, base: string): Set<string> {
  const out = new Set<string>();
  for (const line of compact.split("\n")) {
    const m = line.match(/\|\s*(\S+)\s*\|/);
    if (!m) continue;
    const abs = resolveUrl(m[1], base);
    if (abs) out.add(canonicalizeUrl(abs));
  }
  return out;
}

export async function llmExtractListing(
  llm: LlmClient,
  settings: Settings,
  compact: string,
  url: string,
): Promise<ListingItem[]> {
  // Deliberately not cached (cache: false): the system prompt is ~220 tokens, below the 512-token minimum
  // for Opus/Sonnet/Haiku 5.5 (the API silently ignores the marker) and every page differs; a marker would
  // only add the 1.25x write premium. See DESIGN.md section 20.
  const { data } = await llm.structured({
    purpose: "extract_listing",
    model: settings.utilityModel,
    effort: settings.effort,
    maxTokens: 8000,
    system: [{ text: buildListingExtractSystem(), cache: false }],
    user: buildListingExtractPrompt(compact, url),
    schema: ListingExtractSchema,
  });

  const allowed = urlsInCompact(compact, url);
  const seen = new Set<string>();
  const items: ListingItem[] = [];
  for (const v of data.vacancies) {
    const abs = resolveUrl(v.url.trim(), url);
    if (!abs) continue;
    const canon = canonicalizeUrl(abs);
    if (!allowed.has(canon) || seen.has(canon)) continue;
    const title = v.title.trim();
    if (!title) continue;
    seen.add(canon);
    items.push({
      title,
      url: canon,
      organization: v.organization.trim(),
      location: v.location.trim(),
      dateText: "",
      snippet: "",
    });
  }
  return items;
}
