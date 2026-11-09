/** A child frame (iframe) seen while rendering; `included` is false when it was skipped (tracker, limits, non-http...). */
export interface RenderedFrame {
  url: string;
  included: boolean;
}

/** Renders a URL in a real browser and returns the DOM after JavaScript has run. */
export interface PageRenderer {
  /**
   * `html` is the main document; the content of included child frames is appended to it as
   * `<section data-vr-frame-src="<frame url>">…</section>` blocks just before `</body>`.
   */
  render(url: string): Promise<{ url: string; html: string; frames?: RenderedFrame[] }>;
}

/** Hosts (optionally with a path prefix) that never hold vacancy content: trackers, consent banners, video and social embeds. */
export const NON_CONTENT_FRAME_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "google.com/recaptcha",
  "facebook.com",
  "youtube.com",
  "youtube-nocookie.com",
  "vimeo.com",
  "hotjar.com",
  "cookiebot.com",
  "onetrust.com",
];

/** True when the URL belongs to a tracker/embed host from `list` (host or subdomain, plus optional path prefix). */
export function matchesHostList(url: string, list: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return list.some((entry) => {
    const slash = entry.indexOf("/");
    const h = slash === -1 ? entry : entry.slice(0, slash);
    const p = slash === -1 ? "" : entry.slice(slash);
    return (host === h || host.endsWith("." + h)) && (p === "" || u.pathname.startsWith(p));
  });
}
