import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { RadarBridge, RadarEvents } from "../shared/ipc";

const bridge: RadarBridge = {
  invoke(method, ...args) {
    return ipcRenderer.invoke("radar:" + method, ...args);
  },
  on<E extends keyof RadarEvents>(event: E, cb: (payload: RadarEvents[E]) => void) {
    const channel = "radar-event:" + event;
    const listener = (_e: IpcRendererEvent, payload: RadarEvents[E]) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld("radar", bridge);
