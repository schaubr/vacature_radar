const DROP_PARAM = /^(utm_.*|fbclid|gclid|source|medium|ref|trk)$/i;

/** Resolve an href against a base. Returns null for non-navigable or non-http(s) links. */
export function resolveUrl(href: string | null | undefined, base: string): string | null {
  if (href == null) return null;
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|sms|data|blob):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Canonical form used as identity of a vacancy: lowercase host, no fragment, no tracking params,
 * sorted params, no trailing slash, and a leading Drupal `/index.php/` prefix removed.
 */
export function canonicalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  // /index.php/foo and /index%2Ephp/foo are the same Drupal page as /foo
  u.pathname = u.pathname.replace(/^\/index(?:\.|%2e)php(?=\/|$)/i, "") || "/";
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!DROP_PARAM.test(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  let out = u.toString();
  // drop trailing slash on the path (except root)
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    out = u.toString();
  }
  return out;
}
