import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { AnyNode, Element } from "domhandler";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "ul",
]);

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Text of a DOM subtree with block elements separated by newlines (or spaces when `flat`). */
export function nodeText(node: AnyNode, flat = false): string {
  const sep = flat ? " " : "\n";
  const out: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === "text") {
      out.push(n.data);
      return;
    }
    if (n.type === "root") {
      for (const c of (n as unknown as { children: AnyNode[] }).children) walk(c);
      return;
    }
    if (n.type !== "tag" && n.type !== "script" && n.type !== "style") return;
    const el = n as Element;
    const name = el.name.toLowerCase();
    if (["script", "style", "noscript", "svg", "template"].includes(name)) return;
    const block = BLOCK_TAGS.has(name);
    if (block) out.push(sep);
    for (const c of el.children as AnyNode[]) walk(c);
    if (block) out.push(sep);
  };
  walk(node);
  const raw = out.join("");
  if (flat) return collapseWs(raw);
  return raw
    .split("\n")
    .map((l) => collapseWs(l))
    .filter((l) => l !== "")
    .join("\n")
    .trim();
}

export function visibleTextLength(html: string): number {
  const $ = load(html);
  $("script, style, noscript, svg, template").remove();
  return collapseWs($("body").length ? $("body").text() : $.root().text()).length;
}

export function looksJsRendered(html: string): boolean {
  if (visibleTextLength(html) < 2500) return true;
  const $ = load(html);
  const body = $("body");
  const hasShell = body.find("[ng-version], #app, #root, #__next").length > 0 || body.is("[ng-version]");
  return hasShell && body.find("a[href]").length < 15;
}

const KEEP_ATTRS = new Set(["class", "id", "href", "datetime", "role", "aria-label", "data-vr-frame-src"]);

export function cleanHtmlForLlm(html: string, maxChars = 120_000): string {
  const $ = load(html);
  const title = collapseWs($("head > title, title").first().text());
  $("script, style, noscript, svg, iframe, template, link, meta, head").remove();
  // DESIGN-DEVIATION: also drop page chrome and form widgets that never carry vacancy data
  // (header, footer, img, input, select, textarea); without this vdab_list only shrinks ~42%.
  $("header, footer, img, input, select, textarea, [hidden]").remove();
  // comments
  $("*")
    .contents()
    .each((_, n) => {
      if (n.type === "comment") $(n).remove();
    });
  $("*").each((_, el) => {
    const attribs = (el as Element).attribs;
    for (const name of Object.keys(attribs)) {
      if (!KEEP_ATTRS.has(name)) delete attribs[name];
    }
  });
  // remove empty elements without attributes, deepest first, until stable
  for (let pass = 0; pass < 6; pass++) {
    let removed = 0;
    $("body *")
      .toArray()
      .reverse()
      .forEach((el) => {
        const e = $(el);
        if (Object.keys((el as Element).attribs).length === 0 && e.children().length === 0 && e.text().trim() === "") {
          e.remove();
          removed++;
        }
      });
    if (removed === 0) break;
  }
  // collapse whitespace in text nodes
  $("body *")
    .contents()
    .each((_, n) => {
      if (n.type === "text") n.data = n.data.replace(/\s+/g, " ");
    });
  const serialize = (sel: string | null): string => {
    const el = sel ? $(sel).first() : $("body");
    return (el.html() ?? "").replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
  };
  let body = serialize(null);
  const prefix = title ? title + "\n" : "";
  if (prefix.length + body.length > maxChars) {
    let best: { len: number; links: number; html: string } | null = null;
    for (const sel of ["main", "[role=main]", "body"]) {
      const el = $(sel).first();
      if (!el.length) continue;
      const h = serialize(sel === "body" ? null : sel);
      if (prefix.length + h.length <= maxChars) {
        const links = el.find("a[href]").length;
        if (!best || links > best.links) best = { len: h.length, links, html: h };
      }
    }
    body = best ? best.html : body.slice(0, Math.max(0, maxChars - prefix.length));
    // Widget frames outside the chosen subtree (e.g. beside <main>) are re-appended while they fit, most links first.
    if (best) {
      const chosen = best.html;
      const outside = $("section[data-vr-frame-src]")
        .toArray()
        .map((el) => ({ links: $(el).find("a[href]").length, html: $.html(el) }))
        .filter((f) => !chosen.includes(f.html))
        .sort((a, b) => b.links - a.links);
      let used = prefix.length + body.length;
      for (const f of outside) {
        const h = f.html.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
        if (used + h.length > maxChars) continue;
        body += h;
        used += h.length;
      }
    }
  }
  return prefix + body;
}

export function extractMainText(html: string, maxChars = 15_000): string {
  const $ = load(html);
  $("script, style, noscript, svg, nav, header, footer, aside, form, iframe, template").remove();
  $("[id], [class]").each((_, el) => {
    const e = $(el);
    const sig = `${e.attr("id") ?? ""} ${e.attr("class") ?? ""}`.toLowerCase();
    if (sig.includes("cookie") || sig.includes("consent")) e.remove();
  });
  const root =
    ["main", "article", "[role=main]", "body"].map((s) => $(s).first()).find((e) => e.length > 0) ?? $.root();
  const node = root.get(0);
  if (!node) return "";
  let text = nodeText(node);
  // Widget frames outside the chosen container (e.g. beside <main>) are appended.
  const extra = $("section[data-vr-frame-src]")
    .toArray()
    .filter((el) => !$.contains(node, el) && el !== node)
    .map((el) => nodeText(el));
  if (extra.length > 0) text = [text, ...extra].filter((t) => t !== "").join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
