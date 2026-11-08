import { Menu, nativeImage, Tray } from "electron";
import type { AppStatus } from "../shared/types";

export interface TrayOptions {
  getStatus: () => AppStatus;
  getStrongNew: () => number;
  sourceName: (id: number) => string | null;
  onOpen: () => void;
  onScanNow: () => void;
  onQuit: () => void;
}

export interface TrayHandle {
  refresh(): void;
  destroy(): void;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function statusLine(s: AppStatus, sourceName: (id: number) => string | null): string {
  if (s.scanning) {
    const n = s.currentSourceId !== null ? sourceName(s.currentSourceId) : null;
    return n ? `Scanning ${n}...` : "Scanning...";
  }
  if (s.budgetExceeded) return "Budget reached";
  if (s.nextScanAt) return `Next scan ${hhmm(s.nextScanAt)}`;
  return "No sources enabled";
}

export function createTray(o: TrayOptions): TrayHandle {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Vacature Radar");
  const refresh = (): void => {
    try {
      const status = o.getStatus();
      const strong = o.getStrongNew();
      if (process.platform === "darwin") tray.setTitle(strong > 0 ? `◎ ${strong}` : "◎");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Vacature Radar", click: o.onOpen },
          { label: "Scan now", click: o.onScanNow },
          { type: "separator" },
          { label: statusLine(status, o.sourceName), enabled: false },
          { type: "separator" },
          { label: "Quit", click: o.onQuit },
        ]),
      );
    } catch {
      /* tray refresh is cosmetic */
    }
  };
  tray.on("click", o.onOpen);
  refresh();
  return { refresh, destroy: () => tray.destroy() };
}
