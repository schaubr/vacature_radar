/** Helpers for merging captured iframe content into the main document's HTML. Pure. */

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unattr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Comparison key for frame URLs: no fragment, no trailing slash. */
function key(u: string): string {
  return u.replace(/#.*$/, "").replace(/\/+$/, "");
}

const IFRAME_RE = /<iframe\b[^>]*?\sdata-vr-frame="([^"]*)"[^>]*>[\s\S]*?<\/iframe\s*>/gi;

/**
 * Puts each frame's content in a `<section data-vr-frame-src="url">` block. The block replaces the first not-yet-used
 * `<iframe data-vr-frame="url">` with an equal URL (fragment and trailing slash ignored); frames without a matching
 * iframe are appended before `</body>` (or at the end).
 */
export function inlineFrames(html: string, frames: { url: string; html: string }[]): string {
  if (frames.length === 0) return html;
  const found: { start: number; end: number; key: string; used: boolean }[] = [];
  IFRAME_RE.lastIndex = 0;
  for (let m = IFRAME_RE.exec(html); m; m = IFRAME_RE.exec(html)) {
    found.push({ start: m.index, end: m.index + m[0].length, key: key(unattr(m[1])), used: false });
  }
  const section = (f: { url: string; html: string }) => `<section data-vr-frame-src="${attr(f.url)}">${f.html}</section>`;
  const replacements: { start: number; end: number; text: string }[] = [];
  const leftovers: string[] = [];
  for (const f of frames) {
    const k = key(f.url);
    const hit = found.find((x) => !x.used && x.key === k);
    if (hit) {
      hit.used = true;
      replacements.push({ start: hit.start, end: hit.end, text: section(f) });
    } else {
      leftovers.push(section(f));
    }
  }
  replacements.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of replacements) {
    out += html.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  out += html.slice(pos);
  if (leftovers.length > 0) {
    const at = out.toLowerCase().lastIndexOf("</body>");
    const block = leftovers.join("\n");
    out = at === -1 ? out + block : out.slice(0, at) + block + out.slice(at);
  }
  return out;
}
