import type { RadarBridge } from "../shared/ipc";

declare global {
  interface Window {
    radar: RadarBridge;
  }
}

export {};
