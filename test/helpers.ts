import { readFileSync } from "node:fs";
import path from "node:path";

export const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "fixtures", "sites", name), "utf8");

export const VDAB_URL = "https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker";
export const VVSG_URL = "https://www.vvsg.be/vacatures";
export const JOBSOLUTIONS_URL = "https://www.jobsolutions.be/";

export { VDAB_RECIPE, VVSG_RECIPE, JOBSOLUTIONS_RECIPE, FIOLA_RECIPE, SOCIUS_RECIPE, HELAN_RECIPE } from "../src/core/seed";
