import { useEffect, useRef, useState } from "react";
import type { Bucket, ModelId, VacancyListItem } from "../shared/types";

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} d`;
  }
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function usd(n: number): string {
  return "$" + n.toFixed(n < 0.1 ? 3 : 2);
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  strong: "Strong",
  possible: "Possible",
  weak: "Weak",
  knockout: "Knockout",
};

export const STATE_LABEL: Record<VacancyListItem["scoreState"], string> = {
  scored: "Scored",
  pending: "Pending",
  filtered: "Filtered",
  error: "Error",
  skipped: "Skipped",
};

export const MODEL_PRICE: Record<ModelId, string> = {
  "claude-opus-5-5": "$4 in / $20 out per M tokens",
  "claude-sonnet-5-5": "$2 in / $10 out per M tokens",
  "claude-haiku-5-5": "$0.10 in / $0.50 out per M tokens",
};

export function scoreTone(n: number): Bucket {
  return n >= 70 ? "strong" : n >= 50 ? "possible" : "weak";
}

/** Run an async loader whenever deps change; ignores stale results. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    fnRef.current().then(
      (d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      },
      (e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
