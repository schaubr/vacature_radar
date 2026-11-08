import { BrowserWindow } from "electron";
import { USER_AGENT } from "../core/net/fetcher";
import type { PageRenderer } from "../core/net/render";

const POLL_MS = 500;
const STABLE_POLLS = 3;
const MAX_MS = 25_000;
const RECREATE_AFTER = 50;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isHttp = (u: string) => /^https?:\/\//i.test(u);

/** Renders pages in one hidden BrowserWindow, one at a time. Rate limiting is done by the caller (fetcher.throttle). */
export class ElectronRenderer implements PageRenderer {
  private win: BrowserWindow | null = null;
  private renders = 0;
  private chain: Promise<unknown> = Promise.resolve();

  render(url: string): Promise<{ url: string; html: string }> {
    if (!isHttp(url)) return Promise.reject(new Error(`Refusing to render non-http(s) URL: ${url}`));
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
        partition: "persist:scraper",
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
    this.win = win;
    return win;
  }

  private async renderOnce(url: string): Promise<{ url: string; html: string }> {
    const win = this.window();
    this.renders++;
    const wc = win.webContents;
    const started = Date.now();
    try {
      try {
        await wc.loadURL(url);
      } catch (e) {
        // ERR_ABORTED happens on client-side redirects; carry on if something loaded.
        const cur = wc.getURL();
        if (!cur || cur === "about:blank") throw e;
      }
      let last = -1;
      let stable = 0;
      while (Date.now() - started < MAX_MS) {
        await sleep(POLL_MS);
        if (win.isDestroyed()) throw new Error("Render window was closed");
        let len = 0;
        try {
          len = Number(await wc.executeJavaScript("document.body ? document.body.innerText.length : 0"));
        } catch {
          len = -1;
        }
        if (len === last && len >= 0) stable++;
        else stable = 0;
        last = len;
        if (stable >= STABLE_POLLS) break;
      }
      const html = String(await wc.executeJavaScript("document.documentElement.outerHTML"));
      return { url: wc.getURL() || url, html };
    } catch (e) {
      // A broken window is not reused.
      this.dispose();
      throw new Error(`Render failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
