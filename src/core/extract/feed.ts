import { load } from "cheerio";
import type { ListingItem } from "../../shared/types";
import { canonicalizeUrl, resolveUrl } from "./urls";
import { collapseWs, nodeText } from "./html";

export function isFeed(contentType: string, body: string): boolean {
  const head = body.slice(0, 3000);
  if (/<html[\s>]/i.test(head) || /<!doctype html/i.test(head)) return false;
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) return false;
  // content type is advisory: some servers send text/html for feeds
  return /xml|rss|atom/i.test(contentType) || /^\s*(<\?xml|<rss|<feed|<rdf)/i.test(head);
}

function plain(htmlish: string): string {
  if (!htmlish) return "";
  const $ = load(htmlish);
  const n = $.root().get(0);
  return n ? collapseWs(nodeText(n, true)) : "";
}

export function parseFeed(body: string, baseUrl: string): ListingItem[] {
  const $ = load(body, { xmlMode: true });
  const out: ListingItem[] = [];
  const seen = new Set<string>();
  const push = (title: string, href: string | undefined, desc: string, date: string, org: string): void => {
    const t = collapseWs(title);
    const abs = resolveUrl(href?.trim(), baseUrl);
    if (!t || !abs) return;
    const url = canonicalizeUrl(abs);
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ title: t, url, organization: collapseWs(org), location: "", dateText: collapseWs(date), snippet: plain(desc).slice(0, 400) });
  };
  $("item").each((_, el) => {
    const e = $(el);
    const link = e.children("link").first().text().trim() || e.children("guid").first().text().trim();
    push(
      e.children("title").first().text(),
      link,
      e.children("description").first().text() || e.children("content\\:encoded").first().text(),
      e.children("pubDate").first().text() || e.children("dc\\:date").first().text(),
      e.children("dc\\:creator").first().text() || e.children("author").first().text(),
    );
  });
  $("entry").each((_, el) => {
    const e = $(el);
    const links = e.children("link").toArray();
    const alt = links.find((l) => !$(l).attr("rel") || $(l).attr("rel") === "alternate") ?? links[0];
    push(
      e.children("title").first().text(),
      alt ? $(alt).attr("href") || $(alt).text() : undefined,
      e.children("summary").first().text() || e.children("content").first().text(),
      e.children("published").first().text() || e.children("updated").first().text(),
      e.children("author").children("name").first().text(),
    );
  });
  return out;
}

export function findFeedLink(html: string, baseUrl: string): string | null {
  const $ = load(html);
  let found: string | null = null;
  $("link[rel~='alternate'][type]").each((_, el) => {
    if (found) return;
    const type = ($(el).attr("type") ?? "").toLowerCase();
    if (type.includes("rss") || type.includes("atom")) {
      found = resolveUrl($(el).attr("href"), baseUrl);
    }
  });
  return found;
}
