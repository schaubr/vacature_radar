import { Menu, nativeImage, Tray } from "electron";
import type { AppStatus } from "../shared/types";
import { APP_NAME } from "../shared/app";
import { tEn, type Translator } from "../shared/i18n";

export interface TrayOptions {
  getStatus: () => AppStatus;
  getStrongNew: () => number;
  sourceName: (id: number) => string | null;
  onOpen: () => void;
  onScanNow: () => void;
  onQuit: () => void;
  /** Translator bound to the current language (resolved on every refresh). */
  t?: Translator;
}

export interface TrayHandle {
  refresh(): void;
  destroy(): void;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function statusLine(s: AppStatus, sourceName: (id: number) => string | null, t: Translator = tEn): string {
  if (s.scanning) {
    const n = s.currentSourceId !== null ? sourceName(s.currentSourceId) : null;
    return n ? t("tray.scanningSource", { name: n }) : t("tray.scanning");
  }
  if (s.budgetExceeded) return t("tray.budget");
  if (s.nextScanAt) return t("tray.nextScan", { time: hhmm(s.nextScanAt) });
  return t("tray.noSources");
}

export function createTray(o: TrayOptions): TrayHandle {
  const tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip(APP_NAME);
  const refresh = (): void => {
    try {
      const t = o.t ?? tEn;
      const status = o.getStatus();
      const strong = o.getStrongNew();
      if (process.platform === "darwin") tray.setTitle(strong > 0 ? `◎ ${strong}` : "◎");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: t("tray.open"), click: o.onOpen },
          { label: t("tray.scanNow"), click: o.onScanNow },
          { type: "separator" },
          { label: statusLine(status, o.sourceName, t), enabled: false },
          { type: "separator" },
          { label: t("tray.quit"), click: o.onQuit },
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
