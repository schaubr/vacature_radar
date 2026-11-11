import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_LANG, formatDate, formatDateTime, formatNumber, formatPercent, formatRelative, formatTime, formatUsd, isLang, translate,
  type Lang, type MessageKey, type Params,
} from "../shared/i18n";
import { call, onRadar } from "./api";

export interface Fmt {
  date(d: string | number | Date): string;
  dateTime(d: string | number | Date): string;
  time(d: string | number | Date | null | undefined): string;
  relative(iso: string | null | undefined): string;
  number(n: number, opts?: Intl.NumberFormatOptions): string;
  usd(n: number, digits?: number): string;
  percent(share: number): string;
}

export interface I18n {
  t: (key: MessageKey, params?: Params) => string;
  lang: Lang;
  setLang: (l: Lang) => void;
  fmt: Fmt;
}

const Ctx = createContext<I18n | null>(null);

/** The app language is `Settings.outputLanguage`: loaded at start, refreshed on `app.status`, saved on change. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);

  useEffect(() => {
    let live = true;
    const load = () =>
      call("settings.get")
        .then((s) => live && isLang(s.outputLanguage) && setLangState(s.outputLanguage))
        .catch(() => {});
    load();
    const off = onRadar("app.status", load);
    return () => {
      live = false;
      off();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    call("settings.save", { outputLanguage: l }).catch(() => {});
  }, []);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params),
      fmt: {
        date: (d) => formatDate(lang, d),
        dateTime: (d) => formatDateTime(lang, d),
        time: (d) => (d ? formatTime(lang, d) : ""),
        relative: (iso) => formatRelative(lang, iso),
        number: (n, opts) => formatNumber(lang, n, opts),
        usd: (n, digits) => formatUsd(lang, n, digits),
        percent: (share) => formatPercent(lang, share),
      },
    }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useT outside I18nProvider");
  return v;
}
