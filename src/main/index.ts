import { app, BrowserWindow } from "electron";
import path from "node:path";

// Wave 1 stub: later waves replace this with the full wiring described in DESIGN section 9.
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
