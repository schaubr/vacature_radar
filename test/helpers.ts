import { readFileSync } from "node:fs";
import path from "node:path";
import type { Recipe } from "../src/shared/types";

export const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "fixtures", "sites", name), "utf8");

export const VDAB_URL = "https://www.vdab.be/vindeenjob/vacatures?trefwoord=maatschappelijk%20werker";
export const VVSG_URL = "https://www.vvsg.be/vacatures";
export const JOBSOLUTIONS_URL = "https://www.jobsolutions.be/";

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
