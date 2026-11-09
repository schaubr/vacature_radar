import { load } from "cheerio";
import { resolveUrl } from "./urls";

export interface KnownPortal {
  name: string;
  hostSuffix: string;
}

/** Hosted job portals many employers embed or link to instead of listing vacancies themselves. */
export const KNOWN_PORTALS: KnownPortal[] = [
  { name: "Jobtoolz", hostSuffix: "jobtoolz.com" },
  { name: "Jobat", hostSuffix: "jobat.be" },
  { name: "Recruitee", hostSuffix: "recruitee.com" },
  { name: "Homerun", hostSuffix: "homerun.co" },
  { name: "Teamtailor", hostSuffix: "teamtailor.com" },
  { name: "Starring Jane", hostSuffix: "starringjane.com" },
  { name: "VAIA Talents", hostSuffix: "talents.vaia.com" },
  { name: "Personio", hostSuffix: "jobs.personio.de" },
  { name: "Personio", hostSuffix: "jobs.personio.com" },
  { name: "Workable", hostSuffix: "apply.workable.com" },
];

export interface FoundPortal {
  name: string;
  host: string;
  sampleUrl: string;
  /** How the host was found; link beats frame beats script when it appears several ways. */
  kind: "link" | "frame" | "script";
  /** True when the URL points at one employer's own portal page rather than the portal's generic site. */
  companySpecific: boolean;
  /** The URL to add as a source (the employer's portal root when companySpecific, else the host root). */
  rootUrl: string;
}

const KIND_RANK = { link: 0, frame: 1, script: 2 } as const;

function portalFor(host: string): KnownPortal | undefined {
  return KNOWN_PORTALS.find((p) => host === p.hostSuffix || host.endsWith("." + p.hostSuffix));
}

/** Company label in front of the portal's suffix (acme.recruitee.com), ignoring "www". */
function hasCompanyLabel(host: string, suffix: string): boolean {
  if (host === suffix) return false;
  const label = host.slice(0, host.length - suffix.length - 1);
  return label !== "" && label !== "www";
}

function describe(portal: KnownPortal, host: string, sampleUrl: string, kind: FoundPortal["kind"]): FoundPortal {
  const segs = new URL(sampleUrl).pathname.split("/").filter(Boolean);
  // Path-based portal: talents.vaia.com/companies/<name>
  if (portal.hostSuffix === "talents.vaia.com" && segs[0] === "companies" && segs[1]) {
    return { name: portal.name, host, sampleUrl, kind, companySpecific: true, rootUrl: `https://${host}/companies/${segs[1]}` };
  }
  const companySpecific = hasCompanyLabel(host, portal.hostSuffix);
  const rootUrl = /^[a-z]{2}$/i.test(segs[0] ?? "") ? `https://${host}/${segs[0].toLowerCase()}` : `https://${host}/`;
  return { name: portal.name, host, sampleUrl, kind, companySpecific, rootUrl };
}

/** Known portals referenced by a page's links, iframes and scripts (other host than the page), one entry per host. */
export function findPortals(html: string, pageUrl: string): FoundPortal[] {
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    /* no page host: nothing is "own host" */
  }
  const $ = load(html);
  const out = new Map<string, FoundPortal>();
  const scan = (selector: string, attr: string, kind: FoundPortal["kind"]) => {
    $(selector).each((_, el) => {
      const abs = resolveUrl($(el).attr(attr), pageUrl);
      if (!abs) return;
      let host: string;
      try {
        host = new URL(abs).hostname.toLowerCase();
      } catch {
        return;
      }
      if (host === pageHost) return;
      const known = out.get(host);
      if (known && KIND_RANK[known.kind] <= KIND_RANK[kind]) return;
      const portal = portalFor(host);
      if (portal) out.set(host, describe(portal, host, abs, kind));
    });
  };
  scan("a[href]", "href", "link");
  scan("iframe[src]", "src", "frame");
  scan("script[src]", "src", "script");
  return [...out.values()];
}
