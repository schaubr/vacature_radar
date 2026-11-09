import { useCallback, useEffect, useState } from "react";
import type { AppStatus, Source, VacancyCounts } from "../shared/types";
import { call, onRadar } from "./api";
import { Icon, Segmented } from "./components/ui";
import { useT } from "./i18n";
import { APP_NAME } from "../shared/app";
import type { Lang, MessageKey } from "../shared/i18n";
import { Inbox } from "./views/Inbox";
import { SourcesView } from "./views/Sources";
import { ProfileView } from "./views/Profile";
import { SettingsView } from "./views/Settings";
import { ActivityView } from "./views/Activity";

export type ViewId = "inbox" | "sources" | "profile" | "settings" | "activity";

const NAV: { id: ViewId; label: MessageKey; icon: string }[] = [
  { id: "inbox", label: "nav.inbox", icon: "inbox" },
  { id: "sources", label: "nav.sources", icon: "sources" },
  { id: "profile", label: "nav.profile", icon: "profile" },
  { id: "settings", label: "nav.settings", icon: "settings" },
  { id: "activity", label: "nav.activity", icon: "activity" },
];

const EMPTY_STATUS: AppStatus = {
  scanning: false,
  currentSourceId: null,
  queueLength: 0,
  nextScanAt: null,
  apiKeyConfigured: true,
  budgetExceeded: false,
  profileReady: true,
  travelConfigured: true,
};

export interface Shared {
  status: AppStatus;
  sources: Source[];
  counts: VacancyCounts | null;
  tick: number;
  go: (v: ViewId) => void;
}

export function App() {
  const { t, lang, setLang, fmt } = useT();
  const [view, setView] = useState<ViewId>("inbox");
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS);
  const [sources, setSources] = useState<Source[]>([]);
  const [counts, setCounts] = useState<VacancyCounts | null>(null);
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState<{ id: number; n: number } | null>(null);

  const refresh = useCallback(() => {
    call("app.status").then(setStatus).catch(() => {});
    call("sources.list").then(setSources).catch(() => {});
    call("vacancies.counts").then(setCounts).catch(() => {});
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    refresh();
    const offs = [
      onRadar("vacancies.changed", refresh),
      onRadar("sources.changed", refresh),
      onRadar("app.status", (s) => {
        setStatus(s);
        call("vacancies.counts").then(setCounts).catch(() => {});
      }),
      onRadar("navigate", (p) => {
        setView(p.view);
        if (p.vacancyId != null) setFocus({ id: p.vacancyId, n: Date.now() });
      }),
    ];
    const timer = setInterval(() => call("app.status").then(setStatus).catch(() => {}), 30_000);
    return () => {
      offs.forEach((o) => o());
      clearInterval(timer);
    };
  }, [refresh]);

  // Cmd/Ctrl+1..5 switches views.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        setView(NAV[Number(e.key) - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const shared: Shared = { status, sources, counts, tick, go: setView };
  const errorSources = sources.filter((s) => s.enabled && s.lastStatus === "error").length;
  const badge = (id: ViewId): { text: string; tone?: string } | null => {
    if (id === "inbox" && counts && counts.new > 0) return { text: String(counts.new), tone: "accent" };
    if (id === "sources" && sources.length) return errorSources ? { text: t("nav.badge.issues", { count: errorSources }), tone: "red" } : { text: String(sources.length) };
    if (id === "profile" && !status.profileReady) return { text: t("nav.badge.setUp"), tone: "amber" };
    if (id === "settings" && !status.apiKeyConfigured) return { text: t("nav.badge.apiKey"), tone: "amber" };
    return null;
  };

  const current = sources.find((s) => s.id === status.currentSourceId);
  let statusLine = t("status.idle");
  if (status.scanning) statusLine = (current ? t("status.scanningSource", { name: current.name }) : t("status.scanning")) + (status.queueLength > 0 ? ` ${t("status.queued", { count: status.queueLength })}` : "");
  else if (status.budgetExceeded) statusLine = t("status.budgetReached");
  else if (status.nextScanAt) statusLine = t("status.nextScan", { time: fmt.time(status.nextScanAt) });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="drag-strip" />
        <div className="wordmark">{APP_NAME}</div>
        <nav aria-label={t("nav.main")}>
          {NAV.map((n) => {
            const b = badge(n.id);
            return (
              <button key={n.id} className={`nav-item${view === n.id ? " active" : ""}`} aria-current={view === n.id ? "page" : undefined} onClick={() => setView(n.id)}>
                <Icon name={n.icon} />
                <span className="nav-label">{t(n.label)}</span>
                {b && <span className={`nav-badge ${b.tone ?? ""}`}>{b.text}</span>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <div className="status-line" aria-live="polite">
            <span className={`dot ${status.scanning ? "busy" : status.budgetExceeded ? "red" : "idle"}`} />
            <span className="status-text">{statusLine}</span>
          </div>
          <Segmented<Lang>
            label={t("lang.label")}
            value={lang}
            onChange={setLang}
            options={[
              { id: "en", label: t("lang.short.en") },
              { id: "nl", label: t("lang.short.nl") },
            ]}
          />
          <button className="btn block" disabled={status.scanning} onClick={() => call("scan.now", null)}>
            <Icon name="refresh" size={14} />
            {status.scanning ? t("status.scanning") : t("action.scanAll")}
          </button>
        </div>
      </aside>
      <main className="main">
        {view === "inbox" && <Inbox shared={shared} focus={focus} />}
        {view === "sources" && <SourcesView shared={shared} />}
        {view === "profile" && <ProfileView shared={shared} />}
        {view === "settings" && <SettingsView shared={shared} />}
        {view === "activity" && <ActivityView shared={shared} />}
      </main>
    </div>
  );
}
