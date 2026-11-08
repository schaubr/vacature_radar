/* Dev CLI for the core pipeline outside Electron. See DESIGN section 12.
 *   tsx scripts/scan-cli.ts test <url> [--browser] [--recipe '<json>']
 *   tsx scripts/scan-cli.ts detail <url> [--browser]
 *   tsx scripts/scan-cli.ts scan --db ./dev.db [--source <id>]
 *   ORS_API_KEY=... tsx scripts/scan-cli.ts geo <text>
 *   ORS_API_KEY=... tsx scripts/scan-cli.ts travel <from> <to>
 */
import { execSync } from "node:child_process";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Store } from "../src/core/db/store";
import { extractDetail } from "../src/core/extract/detail";
import { extractListing } from "../src/core/extract/listing";
import { applyRecipe } from "../src/core/extract/recipe";
import { cleanHtmlForLlm, looksJsRendered } from "../src/core/extract/html";
import { AnthropicLlmClient, type LlmClient } from "../src/core/llm/client";
import { llmExtractListing } from "../src/core/llm/extract-llm";
import { learnRecipe } from "../src/core/llm/recipe-learn";
import { OrsClient, type JsonHttp } from "../src/core/geo/ors";
import { classifyHit, locationQuery } from "../src/core/geo/locate";
import { PoliteFetcher, type RawFetch } from "../src/core/net/fetcher";
import type { PageRenderer } from "../src/core/net/render";
import type { Notifier } from "../src/core/notify";
import { ScanService } from "../src/core/scan/scanner";
import { seedSources } from "../src/core/seed";
import type { ListingItem, Recipe } from "../src/shared/types";

const rawFetch: RawFetch = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: "follow" });
  return { status: res.status, url: res.url || url, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
};

function playwrightRenderer(): PageRenderer & { close(): Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const req = require as NodeRequire;
  const pw = req(path.join(execSync("npm root -g").toString().trim(), "playwright"));
  let browserP: Promise<any> | null = null;
  const browser = () =>
    (browserP ??= pw.chromium.launch({
      proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    }));
  return {
    async render(url) {
      const b = await browser();
      const ctx = await b.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
        return { url: page.url(), html: await page.content() };
      } finally {
        await ctx.close();
      }
    },
    async close() {
      if (browserP) await (await browserP).close();
    },
  };
}

function makeLlm(store: Store | null): LlmClient | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new AnthropicLlmClient({
    getApiKey: () => key,
    budget: { monthUsd: () => store?.monthUsageUsd(new Date()) ?? 0, limitUsd: () => store?.getSettings().monthlyBudgetUsd ?? 5 },
    onUsage: (u) =>
      store?.recordUsage({ ...u, at: new Date().toISOString() }),
    anthropicFactory: (apiKey) => new Anthropic({ apiKey }),
  });
}

const orsHttp: JsonHttp = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  return { status: res.status, body: await res.text() };
};

function makeOrs(): OrsClient {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error("Set ORS_API_KEY (free key from openrouteservice.org)");
  return new OrsClient({ http: orsHttp, getKey: () => key });
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printItems(items: ListingItem[]): void {
  console.log(`items: ${items.length}`);
  for (const it of items.slice(0, 20)) console.log(`  ${it.title} | ${it.organization} | ${it.location} | ${it.url}`);
  if (items.length > 20) console.log(`  ... ${items.length - 20} more`);
}

async function loadHtml(url: string, browser: boolean, fetcher: PoliteFetcher, renderer: (PageRenderer & { close(): Promise<void> }) | null) {
  if (browser) {
    await fetcher.throttle(url);
    const r = await renderer!.render(url);
    return { html: r.html, url: r.url, contentType: "text/html" };
  }
  const r = await fetcher.fetch(url);
  return { html: r.body, url: r.url || url, contentType: r.contentType };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const browser = rest.includes("--browser");
  const fetcher = new PoliteFetcher(rawFetch, { onWarn: (m) => console.warn("warn:", m) });
  const renderer = browser || cmd === "scan" ? lazyRenderer() : null;
  try {
    if (cmd === "test") {
      const url = rest.find((a) => !a.startsWith("--") && a !== flag(rest, "--recipe"));
      if (!url) throw new Error("usage: test <url> [--browser] [--recipe json]");
      const allowed = await fetcher.isAllowed(url);
      console.log(`robots: ${allowed ? "allowed" : "DISALLOWED"}`);
      const page = await loadHtml(url, browser, fetcher, renderer);
      console.log(`mode: ${browser ? "browser" : "static"}  bytes: ${page.html.length}  looksJsRendered: ${looksJsRendered(page.html)}  cleaned: ${cleanHtmlForLlm(page.html).length}`);
      const recipeJson = flag(rest, "--recipe");
      const recipe: Recipe | null = recipeJson ? JSON.parse(recipeJson) : null;
      const llm = makeLlm(null);
      const settings = new Store(":memory:").getSettings();
      const res = await extractListing({
        url: page.url,
        html: page.html,
        contentType: page.contentType,
        existingRecipe: recipe,
        learnRecipe: llm ? (c, u) => learnRecipe(llm, settings, c, u, page.html) : undefined,
        llmExtract: llm ? (c, u) => llmExtractListing(llm, settings, c, u) : undefined,
      });
      console.log(`strategy: ${res.strategy ?? "none"}${llm ? "" : "  (no ANTHROPIC_API_KEY: LLM tiers off)"}`);
      if (res.recipe) console.log(`recipe: ${JSON.stringify(res.recipe)}`);
      if (recipe && res.strategy !== "recipe") console.log(`recipe direct: ${applyRecipe(page.html, page.url, recipe).length} items`);
      printItems(res.items);
    } else if (cmd === "detail") {
      const url = rest.find((a) => !a.startsWith("--"));
      if (!url) throw new Error("usage: detail <url> [--browser]");
      const page = await loadHtml(url, browser, fetcher, renderer);
      const d = extractDetail(page.html, page.url);
      console.log(`organization: ${d.organization}\nlocation: ${d.location}\nposted: ${d.datePosted}\nvalid through: ${d.validThrough}\n---\n${d.text}`);
    } else if (cmd === "scan") {
      const dbPath = flag(rest, "--db");
      if (!dbPath) throw new Error("usage: scan --db <path> [--source id]");
      const store = new Store(dbPath);
      if (seedSources(store) > 0) console.log("seeded default sources");
      const llm = makeLlm(store);
      const notifier: Notifier = { notify: (n) => console.log(`NOTIFY: ${n.title} - ${n.body}`) };
      const scanner = new ScanService({
        store,
        fetcher,
        renderer: renderer ?? null,
        llm,
        notifier,
        now: () => new Date(),
        emit: () => {},
        llmConfigured: () => llm !== null,
      });
      const only = flag(rest, "--source");
      const ids = only ? [Number(only)] : store.listSources().filter((s) => s.enabled).map((s) => s.id);
      console.log(`LLM: ${llm ? "enabled" : "off (set ANTHROPIC_API_KEY)"}  sources: ${ids.join(", ")}`);
      await scanner.scanMany(ids);
      for (const s of store.listSources().filter((x) => ids.includes(x.id))) {
        console.log(`#${s.id} ${s.name}: ${s.lastStatus}${s.lastError ? ` (${s.lastError})` : ""} found=${s.lastFound} strategy=${s.strategy ?? "-"} mode=${s.detectedMode ?? s.renderMode}`);
      }
      console.log("counts:", JSON.stringify(store.countVacancies(70)));
      for (const l of store.listLog(20).reverse()) console.log(`  [${l.level}] ${l.message}`);
      store.close();
    } else if (cmd === "geo") {
      const text = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!text) throw new Error("usage: geo <text>");
      const hit = await makeOrs().geocode(text);
      const q = locationQuery({ location: text, organization: "" });
      console.log(hit ? JSON.stringify(hit) : "not found");
      if (hit) console.log(`classified: ${classifyHit(hit, false)}  (query used by the app: ${q?.query ?? "-"})`);
    } else if (cmd === "travel") {
      const [from, to] = rest.filter((a) => !a.startsWith("--"));
      if (!from || !to) throw new Error('usage: travel "<from>" "<to>"');
      const ors = makeOrs();
      const a = await ors.geocode(from);
      const b = await ors.geocode(to);
      if (!a || !b) throw new Error(`could not place ${!a ? from : to}`);
      console.log(`from: ${a.label}\nto:   ${b.label}`);
      const [r] = await ors.matrix(a, [b]);
      console.log(r ? `${r.minutes} min by car, ${r.km} km` : "no route");
    } else {
      console.log("usage:\n  test <url> [--browser] [--recipe '<json>']\n  detail <url> [--browser]\n  scan --db <path> [--source <id>]\n  geo <text>        (env ORS_API_KEY)\n  travel <from> <to> (env ORS_API_KEY)");
      process.exitCode = 2;
    }
  } finally {
    await renderer?.close();
  }
}

/** Playwright is only loaded when a browser is really needed. */
function lazyRenderer(): PageRenderer & { close(): Promise<void> } {
  let inner: (PageRenderer & { close(): Promise<void> }) | null = null;
  return {
    render: (url) => (inner ??= playwrightRenderer()).render(url),
    close: async () => {
      await inner?.close();
    },
  };
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
