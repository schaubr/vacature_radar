import type { RadarApi, RadarBridge, RadarEvents } from "../shared/ipc";

/**
 * Typed wrapper around `window.radar`. Resolved lazily on every call so the
 * mock build can install `window.radar` before first use.
 */
export const api: RadarBridge = {
  invoke(method, ...args) {
    return window.radar.invoke(method, ...args);
  },
  on(event, cb) {
    return window.radar.on(event, cb);
  },
};

export function call<K extends keyof RadarApi>(
  method: K,
  ...args: Parameters<RadarApi[K]>
): Promise<Awaited<ReturnType<RadarApi[K]>>> {
  return api.invoke(method, ...args);
}

export function onRadar<E extends keyof RadarEvents>(event: E, cb: (payload: RadarEvents[E]) => void): () => void {
  return api.on(event, cb);
}

/** Strip Electron's "Error invoking remote method ..." prefix. */
export function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
