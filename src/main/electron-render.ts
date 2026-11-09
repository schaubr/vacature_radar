import { BrowserWindow, type Session, type WebFrameMain } from "electron";
import { tEn, type Translator } from "../shared/i18n";
import { USER_AGENT } from "../core/net/fetcher";
import { inlineFrames } from "../core/extract/frames";
import { NON_CONTENT_FRAME_HOSTS, matchesHostList, type PageRenderer, type RenderedFrame } from "../core/net/render";

const PARTITION = "persist:scraper";
const POLL_MS = 500;
const STABLE_POLLS = 3; // combined text length unchanged over this many polls
const MIN_AFTER_LOAD_MS = 3000; // never capture earlier than this after did-finish-load
const NET_QUIET_MS = 1000; // no in-flight requests for this long
const LONG_POLL_MS = 10_000; // requests open longer than this (long-polling, streams) do not count as in flight
const MAX_MS = 30_000; // hard cap, then capture whatever is there
const RECREATE_AFTER = 50;
const MAX_CHILD_FRAMES = 10;
const MAX_FRAME_HTML = 2 * 1024 * 1024;
const FRAME_JS_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isHttp = (u: string) => /^https?:\/\//i.test(u);
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** Runs inside every frame before capture: makes links absolute so they survive being moved into the main document. */
const ABSOLUTIZE_JS = `(() => {
  document.querySelectorAll('a[href]').forEach(a => a.setAttribute('href', a.href));
  document.querySelectorAll('iframe[src]').forEach(f => { f.setAttribute('src', f.src); f.setAttribute('data-vr-frame', f.src); });
  return true;
})()`;
const TEXT_LENGTH_JS = "document.body ? document.body.innerText.length : 0";

/** Network activity of the scraper windows, keyed by webContents id. */
interface Activity {
  open: Map<number, number>; // request id -> start time
  lastEventAt: number;
}
const activity = new Map<number, Activity>();
const hooked = new WeakSet<Session>();

const activityOf = (wcId: number): Activity => {
  let a = activity.get(wcId);
  if (!a) {
    a = { open: new Map(), lastEventAt: Date.now() };
    activity.set(wcId, a);
  }
  return a;
};

/** Registers the request listeners once per session. They only touch windows we track, so other sessions are unaffected. */
function hookSession(ses: Session): void {
  if (hooked.has(ses)) return;
  hooked.add(ses);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const a = details.webContentsId !== undefined ? activity.get(details.webContentsId) : undefined;
    if (a) {
      if (!a.open.has(details.id)) a.open.set(details.id, Date.now());
      a.lastEventAt = Date.now();
    }
    callback({}); // never block or redirect
  });
  const done = (details: { id: number; webContentsId?: number }) => {
    const a = details.webContentsId !== undefined ? activity.get(details.webContentsId) : undefined;
    if (a) {
      a.open.delete(details.id);
      a.lastEventAt = Date.now();
    }
  };
  ses.webRequest.onCompleted(done);
  ses.webRequest.onErrorOccurred(done);
}

/** True when nothing (except long-polling requests) has been in flight for NET_QUIET_MS. */
function networkQuiet(wcId: number): boolean {
  const a = activity.get(wcId);
  if (!a) return true;
  const now = Date.now();
  for (const started of a.open.values()) if (now - started <= LONG_POLL_MS) return false;
  return now - a.lastEventAt >= NET_QUIET_MS;
}

const frameEligible = (f: WebFrameMain): boolean => {
  const u = f.url;
  return isHttp(u) && !matchesHostList(u, NON_CONTENT_FRAME_HOSTS);
};

/** Renders pages in one hidden BrowserWindow, one at a time. Rate limiting is done by the caller (fetcher.throttle). */
export class ElectronRenderer implements PageRenderer {
  private win: BrowserWindow | null = null;
  private wcId = -1;
  private renders = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /** `t` is resolved on every error so a language switch applies immediately (default English). */
  constructor(private readonly t: Translator = tEn) {}

  render(url: string): Promise<{ url: string; html: string; frames?: RenderedFrame[] }> {
    if (!isHttp(url)) return Promise.reject(new Error(this.t("render.refusing", { url })));
    const run = this.chain.then(
      () => this.renderOnce(url),
      () => this.renderOnce(url),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  destroy(): void {
    this.dispose();
  }

  private dispose(): void {
    const w = this.win;
    this.win = null;
    this.renders = 0;
    activity.delete(this.wcId);
    if (w && !w.isDestroyed()) w.destroy();
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed() && this.renders < RECREATE_AFTER) return this.win;
    this.dispose();
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: PARTITION,
        javascript: true,
        images: false,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setUserAgent(USER_AGENT);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const block = (e: { preventDefault: () => void }, target: string) => {
      if (!isHttp(target)) e.preventDefault();
    };
    win.webContents.on("will-navigate", (e, target) => block(e, target));
    win.webContents.on("will-redirect", (e, target) => block(e, target));
    this.wcId = win.webContents.id;
    activityOf(this.wcId);
    hookSession(win.webContents.session);
    this.win = win;
    return win;
  }

  /** Combined innerText length of all frames plus the frame count; changes while widgets are still filling in. */
  private async signature(wc: Electron.WebContents): Promise<string> {
    const frames = wc.mainFrame.framesInSubtree;
    let total = 0;
    for (const f of frames) {
      if (f.detached) continue;
      try {
        total += Number(await withTimeout(f.executeJavaScript(TEXT_LENGTH_JS), FRAME_JS_TIMEOUT_MS)) || 0;
      } catch {
        /* frame busy, navigating or cross-process: count as 0 this poll */
      }
    }
    return `${total}/${frames.length}`;
  }

  private async capture(wc: Electron.WebContents, url: string): Promise<{ url: string; html: string; frames: RenderedFrame[] }> {
    const [main, ...children] = wc.mainFrame.framesInSubtree;
    await withTimeout(main.executeJavaScript(ABSOLUTIZE_JS), FRAME_JS_TIMEOUT_MS).catch(() => undefined);
    let html = String(await main.executeJavaScript("document.documentElement.outerHTML"));

    const frames: RenderedFrame[] = [];
    const captured: { url: string; html: string }[] = [];
    for (const f of children) {
      const fUrl = f.url;
      if (!fUrl) continue; // about:blank-like frames have an empty url
      let included = false;
      if (!f.detached && frameEligible(f) && captured.length < MAX_CHILD_FRAMES) {
        try {
          await withTimeout(f.executeJavaScript(ABSOLUTIZE_JS), FRAME_JS_TIMEOUT_MS);
          const inner = String(await withTimeout(f.executeJavaScript("document.documentElement.innerHTML"), FRAME_JS_TIMEOUT_MS));
          captured.push({ url: fUrl, html: inner.slice(0, MAX_FRAME_HTML) });
          included = true;
        } catch {
          /* detached, busy or timed out: skip this frame */
        }
      }
      frames.push({ url: fUrl, included });
    }
    // Each frame replaces its <iframe> in place (so it stays inside <main>); unmatched ones go before </body>.
    html = inlineFrames(html, captured);
    return { url: wc.getURL() || url, html, frames };
  }

  private async renderOnce(url: string): Promise<{ url: string; html: string; frames?: RenderedFrame[] }> {
    const win = this.window();
    this.renders++;
    const wc = win.webContents;
    const started = Date.now();
    const act = activityOf(this.wcId);
    act.open.clear();
    act.lastEventAt = started;
    try {
      try {
        await wc.loadURL(url); // resolves on did-finish-load
      } catch (e) {
        // ERR_ABORTED happens on client-side redirects; carry on if something loaded.
        const cur = wc.getURL();
        if (!cur || cur === "about:blank") throw e;
      }
      const loadedAt = Date.now();
      // Settled = 3 s after load AND network quiet for 1 s AND text of all frames unchanged over 3 polls; capped at 30 s.
      let last = "";
      let stable = 0;
      while (Date.now() - started < MAX_MS) {
        await sleep(POLL_MS);
        if (win.isDestroyed()) throw new Error(this.t("render.closed"));
        const sig = await this.signature(wc);
        stable = sig === last ? stable + 1 : 0;
        last = sig;
        if (Date.now() - loadedAt >= MIN_AFTER_LOAD_MS && networkQuiet(this.wcId) && stable >= STABLE_POLLS) break;
      }
      return await this.capture(wc, url);
    } catch (e) {
      // A broken window is not reused.
      this.dispose();
      throw new Error(this.t("render.failed", { url, error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
