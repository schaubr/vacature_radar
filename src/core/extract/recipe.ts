import { load } from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ListingItem, Recipe } from "../../shared/types";
import { collapseWs, nodeText } from "./html";
import { canonicalizeUrl, resolveUrl } from "./urls";

type El = Cheerio<Element>;

function textOf(el: El): string {
  const n = el.get(0);
  return n ? nodeText(n as AnyNode, true) : "";
}

function firstMatch(item: El, selector: string): El | null {
  if (!selector.trim()) return null;
  const found = item.find(selector).first();
  return found.length ? (found as El) : null;
}

function hrefOf(el: El): string | undefined {
  if (el.is("a[href]")) return el.attr("href");
  const inner = el.find("a[href]").first();
  if (inner.length) return inner.attr("href");
  const outer = el.closest("a[href]");
  return outer.length ? outer.attr("href") : undefined;
}

/** Items matched by the selector, innermost only (an element containing another match is dropped). */
function matchItems($: CheerioAPI, selector: string): Element[] {
  const all = $(selector).toArray() as Element[];
  if (all.length < 2) return all;
  const outer = new Set<Element>();
  const set = new Set<Element>(all);
  for (const el of all) {
    for (let p = el.parent; p; p = p.parent) {
      if (set.has(p as Element)) outer.add(p as Element);
    }
  }
  return all.filter((el) => !outer.has(el));
}

export function applyRecipe(html: string, baseUrl: string, recipe: Recipe): ListingItem[] {
  if (!recipe.itemSelector.trim()) return [];
  try {
    const $ = load(html);
    const items: ListingItem[] = [];
    const seen = new Set<string>();
    for (const node of matchItems($, recipe.itemSelector)) {
      const item = $(node) as El;
      const snippet = textOf(item).slice(0, 400);

      let title: string;
      if (recipe.titleSelector.trim()) {
        const t = firstMatch(item, recipe.titleSelector);
        title = t ? textOf(t) : "";
      } else {
        title = textOf(item);
      }
      if (!title) continue;

      let href: string | undefined;
      if (recipe.linkSelector.trim()) {
        const l = firstMatch(item, recipe.linkSelector);
        href = l ? hrefOf(l) : undefined;
      } else {
        href = hrefOf(item);
      }
      const abs = resolveUrl(href, baseUrl);
      if (!abs) continue;
      const url = canonicalizeUrl(abs);
      if (seen.has(url)) continue;
      seen.add(url);

      const pick = (sel: string): string => {
        if (!sel.trim()) return "";
        const e = firstMatch(item, sel);
        return e ? textOf(e) : "";
      };
      items.push({
        title: title.length > 300 ? title.slice(0, 300) : title,
        url,
        organization: pick(recipe.organizationSelector),
        location: pick(recipe.locationSelector),
        dateText: pick(recipe.dateSelector),
        snippet,
      });
    }
    return items;
  } catch {
    return [];
  }
}

export function findNextPage(html: string, baseUrl: string, recipe: Recipe): string | null {
  if (!recipe.nextPageSelector.trim()) return null;
  try {
    const $ = load(html);
    const el = $(recipe.nextPageSelector).first() as El;
    if (!el.length) return null;
    const abs = resolveUrl(hrefOf(el), baseUrl);
    if (!abs) return null;
    const u = new URL(abs);
    u.hash = "";
    const out = u.toString();
    return out === baseUrl ? null : out;
  } catch {
    return null;
  }
}

export function recipeLooksHealthy(items: ListingItem[]): boolean {
  if (items.length < 1) return false;
  const good = items.filter((i) => {
    const n = collapseWs(i.title).length;
    return n >= 4 && n <= 200;
  }).length;
  if (good / items.length < 0.6) return false;
  if (items.length > 1 && new Set(items.map((i) => i.url)).size === 1) return false;
  return true;
}
