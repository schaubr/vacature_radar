import { load } from "cheerio";
import type { PageDiagnostics } from "../../shared/types";
import { NON_CONTENT_FRAME_HOSTS, matchesHostList } from "../net/render";
import { visibleTextLength } from "./html";

/** Extra hosts that are libraries/CDNs, not content providers (on top of the non-content frame hosts). */
const CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "jsdelivr.net",
  "unpkg.com",
  "googleapis.com",
  "gstatic.com",
  "cloudflare.com",
  "jquery.com",
  "cookielaw.org",
  "polyfill.io",
];

export const NO_KEY_HINT = "No vacancies found. Add an Anthropic API key so Claude can learn this page's layout.";

export interface DiagnoseInput {
  html: string;
  pageUrl: string;
  modeUsed: "static" | "browser";
  frames: { url: string; included: boolean }[];
  llmUsed: boolean;
  itemCount: number;
  llmAvailable: boolean;
}

function hostOf(u: string, base?: string): string | null {
  try {
    return new URL(u, base).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Facts about a fetched page and, when it yielded no items, a plain-language reason. Pure. */
export function diagnosePage(input: DiagnoseInput): PageDiagnostics {
  const $ = load(input.html);
  const linkCount = $("a[href]").length;
  const visibleTextChars = visibleTextLength(input.html);

  const pageHost = hostOf(input.pageUrl);
  const hosts = new Set<string>();
  $("iframe[src], script[src]").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    if (!/^(https?:)?\/\//i.test(src.trim())) return; // relative = same host
    const abs = src.trim().startsWith("//") ? "https:" + src.trim() : src.trim();
    const h = hostOf(abs);
    if (!h || h === pageHost) return;
    if (matchesHostList(abs, NON_CONTENT_FRAME_HOSTS) || matchesHostList(abs, CDN_HOSTS)) return;
    hosts.add(h);
  });
  const embeddedHosts = [...hosts].sort();

  let hint: string | null = null;
  if (input.itemCount === 0) {
    const list = embeddedHosts.join(", ");
    if (visibleTextChars < 300) {
      hint = "The page is almost empty for an automated visitor. Try Browser mode; the site may also block automated access.";
    } else if (embeddedHosts.length > 0 && input.modeUsed === "static") {
      hint = `This page loads content from ${list}. Switch the source to Browser mode so that content is included.`;
    } else if (embeddedHosts.length > 0) {
      hint = `Vacancies may come from an embedded service (${list}). If they are still missing, add that service's own listing page as a source.`;
    } else if (!input.llmAvailable) {
      hint = NO_KEY_HINT;
    } else if (input.llmUsed) {
      hint = "Claude looked at the page and found no individual vacancies on it.";
    }
  }

  return {
    modeUsed: input.modeUsed,
    visibleTextChars,
    linkCount,
    frames: input.modeUsed === "browser" ? input.frames : [],
    embeddedHosts,
    llmUsed: input.llmUsed,
    hint,
  };
}
