import type { Store } from "./db/store";
import type { Recipe, SourceInput } from "../shared/types";

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

const UNTESTED = "Seeded 2026-11-08. Use Test before enabling.";

function src(name: string, url: string, renderMode: SourceInput["renderMode"], enabled: boolean): SourceInput {
  return { name, url, enabled, renderMode, scanIntervalHours: null, maxPages: 1, notes: enabled ? "" : UNTESTED };
}

export const SEED_SOURCES: SourceInput[] = [
  src("VDAB: maatschappelijk werker", "https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker", "browser", true),
  src("VDAB: sociaal werker", "https://www.vdab.be/vindeenjob/vacatures?trefwoord=sociaal%20werker", "browser", true),
  src("VVSG (lokale besturen)", "https://www.vvsg.be/vacatures/overzicht-vacatures", "static", true),
  src("Jobsolutions", "https://www.jobsolutions.be/", "static", true),
  src("CAW (cawpro.be)", "https://www.cawpro.be/jobs/?caw-type=job", "auto", false),
  {
    ...src("Zorgnet-Icuro", "https://www.zorgneticuro.be/content/overzicht-jobs", "browser", false),
    notes: "Vacancies come from an embedded Jobat widget. Use Test before enabling.",
  },
];

const SEED_RECIPES: Record<string, Recipe> = {
  "VDAB: maatschappelijk werker": VDAB_RECIPE,
  "VDAB: sociaal werker": VDAB_RECIPE,
  "VVSG (lokale besturen)": VVSG_RECIPE,
  Jobsolutions: JOBSOLUTIONS_RECIPE,
};

/** Inserts the default sources, only when the sources table is empty. Returns how many were inserted. */
export function seedSources(store: Store): number {
  if (store.listSources().length > 0) return 0;
  for (const s of SEED_SOURCES) {
    const created = store.createSource(s);
    const recipe = SEED_RECIPES[s.name];
    if (recipe) store.updateSourceRuntime(created.id, { recipe, strategy: "recipe" });
  }
  return SEED_SOURCES.length;
}
