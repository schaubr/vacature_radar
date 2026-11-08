import { load } from "cheerio";
import type { Element } from "domhandler";
import { collapseWs, nodeText } from "./html";
import { canonicalizeUrl, resolveUrl } from "./urls";

const BLOCK = new Set(["li", "article", "tr", "div", "section", "p", "dd", "dt", "td", "main"]);

/** One line per vacancy-link candidate: `[n] anchor text | url | surrounding block text`. */
export function compactAnchors(html: string, baseUrl: string, max = 400): string {
  const $ = load(html);
  $("script, style, noscript, svg, template").remove();
  const lines: string[] = [];
  const seen = new Set<string>();
  $("body a[href]").each((_, node) => {
    if (lines.length >= max) return false;
    const a = $(node);
    if (a.closest("nav, header, footer").length) return;
    const text = collapseWs(nodeText(node, true));
    if (!text) return;
    const abs = resolveUrl(a.attr("href"), baseUrl);
    if (!abs) return;
    const url = canonicalizeUrl(abs);
    if (seen.has(url)) return;
    seen.add(url);
    let ctx = "";
    let firstBlock = "";
    let p = node.parent as Element | null;
    for (let i = 0; p && i < 5 && p.type === "tag"; i++, p = p.parent as Element | null) {
      if (!BLOCK.has(p.name)) continue;
      const t = nodeText(p, true);
      if (!firstBlock) firstBlock = t;
      if (t.length > text.length + 5 || i >= 4) {
        ctx = t;
        break;
      }
    }
    ctx = (ctx || firstBlock).slice(0, 200);
    lines.push(`[${lines.length + 1}] ${text.slice(0, 200)} | ${url} | ${ctx}`);
  });
  return lines.join("\n");
}
