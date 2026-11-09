import { APP_NAME } from "../app";
import { en } from "./en";
import { nl } from "./nl";

export type Lang = "en" | "nl";
export const LANGS: readonly Lang[] = ["en", "nl"];
export const DEFAULT_LANG: Lang = "en";

type Keys = keyof typeof en;
type Base<K extends string> = K extends `${infer B}_one` ? B : K extends `${infer B}_other` ? B : K;
/** Every key; plural pairs `x_one` / `x_other` are addressed as `x` (with a `count` param). */
export type MessageKey = Base<Keys>;
export type Params = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: Params) => string;

export const DICTIONARIES: Record<Lang, Record<string, string>> = { en, nl };
export const LOCALE: Record<Lang, string> = { en: "en-GB", nl: "nl-BE" };

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "nl";
}

function interpolate(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Looks up `key` (picking `_one` / `_other` when `params.count` is given and the plain key does not exist) and fills `{name}` placeholders. `{app}` defaults to the app name. */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const dict = DICTIONARIES[lang] ?? en;
  let template: string | undefined = dict[key];
  if (template === undefined && params && typeof params.count === "number") {
    const cat = new Intl.PluralRules(LOCALE[lang]).select(params.count);
    template = dict[`${key}_${cat}`] ?? dict[`${key}_other`];
  }
  if (template === undefined) template = (en as Record<string, string>)[key] ?? key;
  return interpolate(template, { app: APP_NAME, ...params });
}

/** A translator bound to a language that is looked up at call time. */
export function translatorFor(getLang: () => Lang): Translator {
  return (key, params) => translate(getLang(), key, params);
}

/** English translator: the default for core code and tests. */
export const tEn: Translator = (key, params) => translate("en", key, params);

// ---------- locale formatting ----------

type DateInput = string | number | Date;
const toDate = (d: DateInput): Date => (d instanceof Date ? d : new Date(d));

export function formatDate(lang: Lang, d: DateInput, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  return new Intl.DateTimeFormat(LOCALE[lang], opts).format(toDate(d));
}

/** "HH:mm" in the local time zone. */
export function formatTime(lang: Lang, d: DateInput): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", hour12: false }).format(toDate(d));
}

/** "09 Nov 14:05:33" */
export function formatDateTime(lang: Lang, d: DateInput): string {
  const date = new Intl.DateTimeFormat(LOCALE[lang], { day: "2-digit", month: "short" }).format(toDate(d));
  const time = new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(toDate(d));
  return `${date} ${time}`;
}

export function formatNumber(lang: Lang, n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(LOCALE[lang], opts).format(n);
}

/** "$1.85" / "$ 1,85"; three decimals below 0.10 unless `digits` is given. */
export function formatUsd(lang: Lang, n: number, digits?: number): string {
  const d = digits ?? (n < 0.1 ? 3 : 2);
  return new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
}

/** "3 min ago", "in 2 h", "just now"; dates older than two weeks are shown as a date. */
export function formatRelative(lang: Lang, iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return translate(lang, "rel.never");
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return translate(lang, "rel.inMin", { n: Math.max(1, Math.round(f / 60)) });
    if (f < 86400) return translate(lang, "rel.inH", { n: Math.round(f / 3600) });
    return translate(lang, "rel.inD", { n: Math.round(f / 86400) });
  }
  if (s < 45) return translate(lang, "rel.justNow");
  if (s < 3600) return translate(lang, "rel.minAgo", { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return translate(lang, "rel.hAgo", { n: Math.round(s / 3600) });
  if (s < 86400 * 14) return translate(lang, "rel.dAgo", { n: Math.round(s / 86400) });
  return formatDate(lang, t);
}
