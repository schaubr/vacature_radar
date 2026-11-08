import type { Store } from "./db/store";
import type { SourceInput } from "../shared/types";

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
  src("Zorgnet-Icuro", "https://www.zorgneticuro.be/content/overzicht-jobs", "auto", false),
];

/** Inserts the default sources, only when the sources table is empty. Returns how many were inserted. */
export function seedSources(store: Store): number {
  if (store.listSources().length > 0) return 0;
  for (const s of SEED_SOURCES) store.createSource(s);
  return SEED_SOURCES.length;
}
