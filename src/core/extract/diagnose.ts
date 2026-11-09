import { load } from "cheerio";
import type { PageDiagnostics } from "../../shared/types";
import { NON_CONTENT_FRAME_HOSTS, matchesHostList } from "../net/render";
import { visibleTextLength } from "./html";
import { findPortals, type FoundPortal } from "./portals";
import { tEn, type Translator } from "../../shared/i18n";

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

/** English text of the generic no-key hint; compare with `t("diag.noKey")` for other languages. */
export const NO_KEY_HINT = tEn("diag.noKey");

export interface DiagnoseInput {
  html: string;
  pageUrl: string;
  modeUsed: "static" | "browser";
  frames: { url: string; included: boolean }[];
  llmUsed: boolean;
  itemCount: number;
  /** Extracted item URLs; lets the portal rule see when every item is on the page's own host. */
  itemUrls?: string[];
  llmAvailable: boolean;
  /** Translator for the hint (default English). */
  t?: Translator;
}

function hostOf(u: string, base?: string): string | null {
  try {
    return new URL(u, base).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function portalHint(p: FoundPortal, t: Translator): string {
  return t("diag.portal", { name: p.name, host: p.host, url: p.rootUrl });
}

/** Facts about a fetched page and, when it yielded no items, a plain-language reason. Pure. */
export function diagnosePage(input: DiagnoseInput): PageDiagnostics {
  const t = input.t ?? tEn;
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

  const portals = findPortals(input.html, input.pageUrl);
  const bare = (h: string | null) => (h ?? "").replace(/^www\./, "");
  const itemUrls = input.itemUrls ?? [];
  const allOwnHost = input.itemCount > 0 && itemUrls.length > 0 && itemUrls.every((u) => bare(hostOf(u)) === bare(pageHost));

  let hint: string | null = null;
  // Only an employer's own portal page (link/frame) is worth adding as a source; a script means "use Browser mode".
  const addable = portals.find((p) => p.companySpecific && p.kind !== "script");
  const scripted = portals.find((p) => p.kind !== "link");
  if (addable && allOwnHost) {
    hint = portalHint(addable, t);
  } else if (input.itemCount === 0) {
    const list = embeddedHosts.join(", ");
    if (visibleTextChars < 300) {
      hint = t("diag.almostEmpty");
    } else if (addable) {
      hint = portalHint(addable, t);
    } else if (scripted) {
      hint = input.modeUsed === "static" ? t("diag.scriptStatic", { name: scripted.name }) : t("diag.scriptBrowser", { name: scripted.name });
    } else if (embeddedHosts.length > 0 && input.modeUsed === "static") {
      hint = t("diag.embeddedStatic", { list });
    } else if (embeddedHosts.length > 0) {
      hint = t("diag.embeddedBrowser", { list });
    } else if (!input.llmAvailable) {
      hint = t("diag.noKey");
    } else if (input.llmUsed) {
      hint = t("diag.llmFound");
    }
  }

  return {
    modeUsed: input.modeUsed,
    visibleTextChars,
    linkCount,
    frames: input.modeUsed === "browser" ? input.frames : [],
    embeddedHosts,
    portals,
    llmUsed: input.llmUsed,
    hint,
  };
}
