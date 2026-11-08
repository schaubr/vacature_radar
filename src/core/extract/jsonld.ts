import { load } from "cheerio";
import type { ListingItem } from "../../shared/types";
import { canonicalizeUrl, resolveUrl } from "./urls";
import { collapseWs, nodeText } from "./html";

export interface JobPostingLd {
  title: string;
  url: string;
  description: string;
  organization: string;
  location: string;
  datePosted: string;
  validThrough: string;
  employmentType: string;
}

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: Json): string {
  if (typeof v === "string") return collapseWs(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (isObj(v)) return str(v.name ?? v["@id"] ?? "");
  return "";
}

function htmlToText(s: string): string {
  if (!s) return "";
  const $ = load(s);
  const n = $.root().get(0);
  return n ? nodeText(n) : "";
}

function hasType(o: Obj, type: string): boolean {
  const t = o["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && x.toLowerCase() === type.toLowerCase());
}

function locationOf(v: Json): string {
  const items = Array.isArray(v) ? v : v === undefined ? [] : [v];
  const parts: string[] = [];
  for (const it of items) {
    if (typeof it === "string") {
      parts.push(collapseWs(it));
      continue;
    }
    if (!isObj(it)) continue;
    const addr = it.address;
    if (typeof addr === "string") parts.push(collapseWs(addr));
    else if (isObj(addr)) {
      const bits = [str(addr.streetAddress), str(addr.postalCode), str(addr.addressLocality), str(addr.addressRegion)].filter(Boolean);
      const place = [str(addr.postalCode), str(addr.addressLocality)].filter(Boolean).join(" ");
      parts.push([str(addr.streetAddress), place || str(addr.addressRegion)].filter(Boolean).join(", ") || bits.join(" "));
    } else if (typeof it.name === "string") parts.push(collapseWs(it.name));
  }
  return parts.filter(Boolean).join(" | ");
}

function toPosting(o: Obj): JobPostingLd {
  const urlRaw = str(o.url) || (typeof o.mainEntityOfPage === "string" ? o.mainEntityOfPage : "") || str(o.sameAs);
  return {
    title: str(o.title ?? o.name),
    url: urlRaw,
    description: htmlToText(typeof o.description === "string" ? o.description : ""),
    organization: str(o.hiringOrganization),
    location: locationOf(o.jobLocation),
    datePosted: str(o.datePosted),
    validThrough: str(o.validThrough),
    employmentType: str(o.employmentType),
  };
}

function parseJson(raw: string): Json | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      // tolerate raw control characters inside strings
      return JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return undefined;
    }
  }
}

export function findJobPostings(html: string): JobPostingLd[] {
  const $ = load(html);
  const found: JobPostingLd[] = [];
  const visit = (node: Json, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    if (hasType(node, "JobPosting")) found.push(toPosting(node));
    if (node["@graph"]) visit(node["@graph"], depth + 1);
    if (hasType(node, "ItemList") || node.itemListElement) {
      const els = node.itemListElement;
      for (const el of Array.isArray(els) ? els : els ? [els] : []) {
        if (isObj(el) && el.item !== undefined) visit(el.item, depth + 1);
        else visit(el, depth + 1);
      }
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    const parsed = parseJson($(el).text().trim());
    if (parsed !== undefined) visit(parsed, 0);
  });
  return found;
}

export function jobPostingsToItems(postings: JobPostingLd[], baseUrl: string): ListingItem[] {
  const out: ListingItem[] = [];
  const seen = new Set<string>();
  for (const p of postings) {
    const abs = resolveUrl(p.url, baseUrl);
    if (!abs || !p.title) continue;
    const url = canonicalizeUrl(abs);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: p.title,
      url,
      organization: p.organization,
      location: p.location,
      dateText: p.datePosted,
      snippet: collapseWs(p.description).slice(0, 400),
    });
  }
  return out;
}
