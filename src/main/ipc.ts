import { ipcMain } from "electron";
import { RADAR_METHODS, type RadarApi } from "../shared/ipc";

type Handler = (...args: unknown[]) => unknown;

/** Registers `radar:<method>` handlers. Errors reach the renderer as plain `Error.message`. */
export function registerIpc(service: RadarApi, onError: (method: string, e: unknown) => void): void {
  for (const method of RADAR_METHODS) {
    ipcMain.handle("radar:" + method, async (_event, ...args: unknown[]) => {
      try {
        const fn = service[method] as unknown as Handler;
        return await fn.apply(service, args);
      } catch (e) {
        onError(method, e);
        throw new Error(e instanceof Error ? e.message : String(e));
      }
    });
  }
}
