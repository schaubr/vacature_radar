const GENDER = /(?<![a-z0-9])\(?\s*[mvwhfdxn]\s*\/\s*[mvwhfdxn](?:\s*\/\s*[mvwhfdxn])?\s*\)?(?![a-z0-9])/g;
const LEGAL = /(?<![a-z0-9])(?:vzw|cvba|bv|bvba|nv|asbl|vof|cv)(?![a-z0-9])/g;

function base(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(GENDER, " ");
}

function tidy(s: string): string {
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeTitle(t: string): string {
  return tidy(base(t));
}

export function normalizeOrg(o: string): string {
  return tidy(base(o).replace(LEGAL, " "));
}

export function dedupeKey(title: string, org: string): string {
  return normalizeTitle(title) + "|" + normalizeOrg(org);
}
