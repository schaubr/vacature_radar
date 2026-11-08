// Per-run isolation (E2E tests): must happen before anything touches userData.
import { app, BrowserWindow, dialog, Notification, powerMonitor, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

app.setName("Vacature Radar");
if (process.env.VACATURE_RADAR_USER_DATA) app.setPath("userData", process.env.VACATURE_RADAR_USER_DATA);

import type { RadarEvents } from "../shared/ipc";
import { Store } from "../core/db/store";
import { AnthropicLlmClient } from "../core/llm/client";
import { PoliteFetcher } from "../core/net/fetcher";
import type { Notifier } from "../core/notify";
import { ScanService } from "../core/scan/scanner";
import { Scheduler } from "../core/scan/scheduler";
import { seedSources } from "../core/seed";
import { RadarService } from "../core/service";
import { OrsClient } from "../core/geo/ors";
import { TravelService } from "../core/geo/travel";
import { electronJsonHttp, electronRawFetch } from "./electron-fetch";
import { ElectronRenderer } from "./electron-render";
import { registerIpc } from "./ipc";
import { SafeStorageSecrets } from "./secrets";
import { createTray, type TrayHandle } from "./tray";

const isMac = process.platform === "darwin";
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let tray: TrayHandle | null = null;
let store: Store | null = null;

function logError(message: string): void {
  console.error(message);
  try {
    store?.log("error", message);
  } catch {
    /* store not ready or closed */
  }
}

process.on("unhandledRejection", (e) => logError(`Unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
process.on("uncaughtException", (e) => logError(`Uncaught exception: ${e.stack ?? e.message}`));

function emit<E extends keyof RadarEvents>(event: E, payload: RadarEvents[E]): void {
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send("radar-event:" + event, payload);
  if (event === "app.status" || event === "vacancies.changed") tray?.refresh();
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const win = mainWindow!;
  if (isMac) void app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(opts: { show?: boolean } = {}): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: isMac ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });
  win.once("ready-to-show", () => {
    if (opts.show !== false) win.show();
  });
  win.on("close", (e) => {
    // macOS: closing hides, the app lives on in the menu bar.
    if (isMac && !quitting) {
      e.preventDefault();
      win.hide();
      app.dock?.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function applyLaunchAtLogin(enabled: boolean): void {
  // Registering the dev Electron binary as a login item would be a mess: packaged macOS builds only.
  if (!isMac || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled });
}

function start(): void {
  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const db = new Store(path.join(userData, "radar.db"));
  store = db;
  seedSources(db);

  const secrets = new SafeStorageSecrets(userData);
  const orsSecrets = new SafeStorageSecrets(userData, "ors-secret.bin");
  const fetcher = new PoliteFetcher(electronRawFetch, { onWarn: (m) => db.log("warn", m) });
  const renderer = new ElectronRenderer();
  const llm = new AnthropicLlmClient({
    getApiKey: () => secrets.get(),
    budget: {
      monthUsd: () => db.monthUsageUsd(new Date()),
      limitUsd: () => db.getSettings().monthlyBudgetUsd,
    },
    onUsage: (u) =>
      db.recordUsage({
        model: u.model,
        purpose: u.purpose,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: u.costUsd,
        at: new Date().toISOString(),
      }),
  });

  const notifier: Notifier = {
    notify(n) {
      try {
        if (!Notification.isSupported()) return;
        const note = new Notification({ title: n.title, body: n.body, silent: false });
        note.on("click", () => {
          showWindow();
          emit("navigate", { view: "inbox", vacancyId: n.vacancyId });
        });
        note.show();
      } catch (e) {
        logError(`Notification failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };

  const now = () => new Date();
  const ors = new OrsClient({ http: electronJsonHttp, getKey: () => orsSecrets.get() });
  const travel = new TravelService({
    store: db,
    ors,
    orsConfigured: () => orsSecrets.get() !== null,
    now,
    log: (level, message) => db.log(level, message),
  });
  const scanner = new ScanService({
    store: db,
    fetcher,
    renderer,
    llm,
    notifier,
    now,
    emit,
    llmConfigured: () => secrets.get() !== null,
    travel,
  });
  const scheduler = new Scheduler({ store: db, scanner, now });
  const service = new RadarService({
    store: db,
    scanner,
    scheduler,
    llm,
    secrets,
    orsSecrets,
    orsHttp: electronJsonHttp,
    travel,
    shell: {
      openExternal: (url) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      },
      pickImportFile: async () => {
        const opts = {
          title: "Import LinkedIn profile",
          properties: ["openFile" as const],
          filters: [{ name: "LinkedIn export (.zip) or profile PDF", extensions: ["zip", "pdf"] }],
        };
        const r = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
        if (r.canceled || r.filePaths.length === 0) return null;
        const p = r.filePaths[0];
        return { path: p, data: new Uint8Array(await fs.promises.readFile(p)) };
      },
    },
    now,
    emit,
    onSettingsChanged: (s, patch) => {
      if (patch.launchAtLogin !== undefined) applyLaunchAtLogin(s.launchAtLogin);
    },
  });

  registerIpc(service, (method, e) => {
    try {
      db.log("error", `${method} failed: ${e instanceof Error ? e.message : String(e)}`);
    } catch {
      /* ignore */
    }
  });

  try {
    tray = createTray({
      getStatus: () => service.computeStatus(),
      getStrongNew: () => service["vacancies.counts"]().strongNew,
      sourceName: (id) => db.getSource(id)?.name ?? null,
      onOpen: showWindow,
      onScanNow: () => service["scan.now"](null),
      onQuit: () => app.quit(),
    });
  } catch (e) {
    logError(`Tray unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
  setInterval(() => tray?.refresh(), 60_000).unref();

  applyLaunchAtLogin(db.getSettings().launchAtLogin);
  powerMonitor.on("resume", () => scheduler.onResume());
  scheduler.start();

  app.on("before-quit", () => {
    quitting = true;
    scheduler.stop();
    renderer.destroy();
  });
  app.on("will-quit", () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  const openedAtLogin = isMac && app.getLoginItemSettings().wasOpenedAtLogin;
  createWindow({ show: !openedAtLogin });
  if (openedAtLogin) app.dock?.hide();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  void app
    .whenReady()
    .then(start)
    .catch((e) => {
      logError(`Startup failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      dialog.showErrorBox("Vacature Radar", `Startup failed: ${e instanceof Error ? e.message : String(e)}`);
      app.quit();
    });
}
