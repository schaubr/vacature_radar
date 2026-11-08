import { net } from "electron";
import type { JsonHttp } from "../core/geo/ors";
import type { RawFetch } from "../core/net/fetcher";

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : "utf-8";
}

/** RawFetch on Chromium's network stack (gzip/br, system proxy, certificates). */
export const electronRawFetch: RawFetch = async (url, init) => {
  const res = await net.fetch(url, { headers: init.headers, signal: init.signal, redirect: "follow" });
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: string;
  try {
    body = new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    body = new TextDecoder("utf-8").decode(bytes);
  }
  return { status: res.status, url: res.url || url, contentType, body };
};

/** JsonHttp (OpenRouteService) on Chromium's network stack. */
export const electronJsonHttp: JsonHttp = async (url, init) => {
  const res = await net.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { status: res.status, body: await res.text() };
};
