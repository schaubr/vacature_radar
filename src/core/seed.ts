import type { Store } from "./db/store";
import type { Recipe, SourceInput } from "../shared/types";
import { canonicalizeUrl } from "./extract/urls";

/** Hand-written recipes for the seeded sites, so they work without an API key. */
export const VDAB_RECIPE: Recipe = {
  itemSelector: "li.c-vacature",
  titleSelector: "h4.c-vacature__content-title a",
  linkSelector: "h4.c-vacature__content-title a",
  organizationSelector: ".c-vacature-meta.-location strong:first-child",
  locationSelector: ".c-vacature-meta.-location strong:last-child",
  dateSelector: "",
  nextPageSelector: "",
};
export const VVSG_RECIPE: Recipe = {
  itemSelector: ".node--type-job",
  titleSelector: "h3 a",
  linkSelector: "h3 a",
  organizationSelector: ".field--vacature-organisatie",
  locationSelector: "",
  dateSelector: "time",
  nextPageSelector: "",
};
export const JOBSOLUTIONS_RECIPE: Recipe = {
  itemSelector: "a.card",
  titleSelector: "h3",
  linkSelector: "",
  organizationSelector: "p",
  locationSelector: "",
  dateSelector: "",
  nextPageSelector: "",
};

export const FIOLA_RECIPE: Recipe = {
  itemSelector: "article.elementor-post",
  titleSelector: ".elementor-post__title a",
  linkSelector: ".elementor-post__title a",
  organizationSelector: "",
  locationSelector: ".elementor-post__badge",
  dateSelector: ".elementor-post__meta-data",
  nextPageSelector: "",
};

export const SOCIUS_RECIPE: Recipe = {
  itemSelector: "table.vacature-lijst tbody.wpv-loop > tr",
  titleSelector: "td:nth-child(1) a",
  linkSelector: "td:nth-child(1) a",
  organizationSelector: "td:nth-child(2)",
  locationSelector: "td:nth-child(3)",
  dateSelector: "td:nth-child(4)",
  nextPageSelector: "li.wpv_page_current + li a",
};

export const HELAN_RECIPE: Recipe = {
  itemSelector: "div.itemContainer",
  titleSelector: "h3.itemTitle a",
  linkSelector: "h3.itemTitle a",
  organizationSelector: ".matchCriteria-BusinessUnit > span",
  locationSelector: ".matchCriteria-Regio > span",
  dateSelector: "",
  nextPageSelector: "a.pnNext",
};

const UNTESTED = "Seeded 2026-11-08. Use Test before enabling.";

/** A seed entry; `since` is the seed revision that introduced it (see DESIGN.md 16.1). */
export type SeedSource = SourceInput & { since: number };

function src(name: string, url: string, renderMode: SourceInput["renderMode"], enabled: boolean, since = 1): SeedSource {
  return { name, url, enabled, renderMode, scanIntervalHours: null, maxPages: 1, notes: enabled ? "" : UNTESTED, since };
}

export const SEED_SOURCES: SeedSource[] = [
  src("VDAB: maatschappelijk werker", "https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker", "browser", true),
  src("VDAB: sociaal werker", "https://www.vdab.be/vindeenjob/vacatures?trefwoord=sociaal%20werker", "browser", true),
  src("VVSG (lokale besturen)", "https://www.vvsg.be/vacatures/overzicht-vacatures", "static", true),
  src("Jobsolutions", "https://www.jobsolutions.be/", "static", true),
  src("CAW (cawpro.be)", "https://www.cawpro.be/jobs/?caw-type=job", "auto", false),
  {
    ...src("Zorgnet-Icuro", "https://www.zorgneticuro.be/content/overzicht-jobs", "browser", false),
    notes: "Vacancies come from an embedded Jobat widget. Use Test before enabling.",
  },
  {
    ...src("Fiola vzw", "https://fiolavzw.be/vacatures/", "static", true, 2),
    notes: "Vacancy list on fiolavzw.be, detail pages on Jobtoolz (fiola-vzw.jobtoolz.com). Verified 2026-11-09.",
  },
  {
    ...src("Socius (sociaal-cultureel werk)", "https://socius.be/vacature/", "static", true, 3),
    maxPages: 3,
    notes: "Vacaturebank van Socius. 3 pages, about 45 vacancies. Verified 2026-11-09.",
  },
  {
    ...src("Helan", "https://www.helanjobs.be/vacatures/", "static", true, 4),
    maxPages: 5,
    notes: "Helan vacatures (kinderopvang, ziekenfonds, huishoudhulp, Heyo). OTYS site, 5 newest pages. Verified 2026-11-09.",
  },
];

const SEED_RECIPES: Record<string, Recipe> = {
  "VDAB: maatschappelijk werker": VDAB_RECIPE,
  "VDAB: sociaal werker": VDAB_RECIPE,
  "VVSG (lokale besturen)": VVSG_RECIPE,
  Jobsolutions: JOBSOLUTIONS_RECIPE,
  "Fiola vzw": FIOLA_RECIPE,
  "Socius (sociaal-cultureel werk)": SOCIUS_RECIPE,
  Helan: HELAN_RECIPE,
};

/**
 * Inserts seed sources the install has not seen yet. A fresh install (no revision, no sources) gets everything;
 * an existing install without a stored revision counts as revision 1. Seeds the owner deleted are not re-added
 * because the stored revision only moves forward. Returns how many were inserted.
 */
export function seedSources(store: Store): number {
  const existing = store.listSources();
  const stored = store.getMeta<number>("seedRevision");
  const rev = typeof stored === "number" ? stored : existing.length === 0 ? 0 : 1;
  const present = new Set(existing.map((s) => canonicalizeUrl(s.url)));
  let inserted = 0;
  for (const { since, ...input } of SEED_SOURCES) {
    if (since <= rev || present.has(canonicalizeUrl(input.url))) continue;
    const created = store.createSource(input);
    const recipe = SEED_RECIPES[input.name];
    if (recipe) store.updateSourceRuntime(created.id, { recipe, strategy: "recipe" });
    present.add(canonicalizeUrl(input.url));
    inserted++;
  }
  const latest = Math.max(rev, ...SEED_SOURCES.map((s) => s.since));
  if (latest !== stored) store.setMeta("seedRevision", latest);
  return inserted;
}
