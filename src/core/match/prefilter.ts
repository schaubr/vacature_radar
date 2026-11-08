import type { Preferences } from "../../shared/types";

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function matcher(keyword: string): RegExp | null {
  const k = norm(keyword).trim();
  if (!k) return null;
  const body = k
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`);
}

export function prefilter(
  item: { title: string; snippet: string },
  prefs: Pick<Preferences, "includeKeywords" | "excludeKeywords">,
): { pass: true } | { pass: false; reason: string } {
  const title = norm(item.title);
  for (const kw of prefs.excludeKeywords) {
    const m = matcher(kw);
    if (m && m.test(title)) return { pass: false, reason: `Title contains excluded keyword "${kw.trim()}"` };
  }
  const includes = prefs.includeKeywords.filter((k) => matcher(k));
  if (includes.length > 0) {
    const hay = title + " " + norm(item.snippet);
    if (!includes.some((k) => matcher(k)!.test(hay))) {
      return { pass: false, reason: "Title/snippet contains none of the include keywords" };
    }
  }
  return { pass: true };
}
