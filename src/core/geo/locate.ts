/** Derives a geocodable place query from a vacancy's location/organization. Contract: DESIGN.md 14.4. */
import type { GeoHit } from "./ors";

const PREFIXES_LOCATION = /^(provincie|regio|arrondissement)\s+/i;
const PUBLIC_BODY_PREFIXES = [
  "lokaal bestuur",
  "gemeentebestuur",
  "stadsbestuur",
  "welzijnsvereniging",
  "hulpverleningszone",
  "politiezone",
  "gemeente",
  "zorgpunt",
  "ocmw",
  "stad",
  "agb",
];

function titleCaseIfUpper(s: string): string {
  if (s !== s.toUpperCase() || s === s.toLowerCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

function cleanLocation(raw: string): string {
  let s = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(PREFIXES_LOCATION, "").trim();
  return titleCaseIfUpper(s);
}

const ORG_WORD_TOKENS = new Set(["vzw", "asbl", "bv", "nv", "cv", "cvba", "bvba", "vof", "sa", "srl", "caw", "ocmw"]);
const ORG_SUBSTRING_TOKENS = ["groep", "centrum", "dienst", "huis", "zorg", "school", "vereniging", "federatie", "partners", "jeugd", "welzijn"];

/** A bare organization name that looks like a municipality: 1-2 words, no digits, no org-type/legal-form token. */
function looksLikePlaceName(o: string): boolean {
  const words = o.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 2 || /\d/.test(o)) return false;
  const lower = o.toLowerCase();
  if (PUBLIC_BODY_PREFIXES.includes(lower)) return false;
  const parts = lower.split(/[\s\-]+/).filter(Boolean);
  if (parts.some((w) => ORG_WORD_TOKENS.has(w))) return false;
  return !ORG_SUBSTRING_TOKENS.some((t) => lower.includes(t));
}

function fromOrganization(org: string): string | null {
  const o = org.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!o) return null;
  const dash = o.lastIndexOf(" - ");
  if (dash >= 0) {
    const tail = o.slice(dash + 3).trim();
    const words = tail.split(" ").filter(Boolean);
    if (tail && words.length <= 3) return titleCaseIfUpper(tail);
    return null;
  }
  const lower = o.toLowerCase();
  for (const p of PUBLIC_BODY_PREFIXES) {
    if (lower === p) continue;
    if (lower.startsWith(p + " ")) {
      const rest = o.slice(p.length).trim();
      const words = rest.split(" ").filter(Boolean);
      if (words.length >= 1 && words.length <= 3) return titleCaseIfUpper(rest);
      return null;
    }
  }
  return looksLikePlaceName(o) ? titleCaseIfUpper(o) : null;
}

export function locationQuery(v: {
  location: string;
  organization: string;
}): { query: string; fromOrganization: boolean } | null {
  const loc = cleanLocation(v.location ?? "");
  if (loc) return { query: loc, fromOrganization: false };
  const org = fromOrganization(v.organization ?? "");
  return org ? { query: org, fromOrganization: true } : null;
}

export type HitClass = "ok" | "approximate" | "not_found";

export function classifyHit(
  hit: Pick<GeoHit, "confidence" | "layer"> | null,
  fromOrganization: boolean,
): HitClass {
  if (!hit || hit.confidence < 0.6) return "not_found";
  if (fromOrganization && !["locality", "localadmin", "borough"].includes(hit.layer)) return "not_found";
  if (hit.layer === "region" || hit.layer === "macroregion" || hit.layer === "county") return "approximate";
  return "ok";
}
