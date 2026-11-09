import { useCallback, useEffect, useRef, useState } from "react";
import type { VacancyFilter, VacancyListItem, VacancyStatus } from "../../shared/types";
import { call } from "../api";
import { Empty, Icon, ScorePill, Segmented, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { formatTravel } from "../../shared/travel";
import { isTypingTarget, useDebounced } from "../util";
import { useT } from "../i18n";
import { VacancyDetailPane } from "./VacancyDetail";

const CHIPS: VacancyStatus[] = ["new", "seen", "interested", "applied", "dismissed", "closed"];

export function Inbox({ shared, focus }: { shared: Shared; focus: { id: number; n: number } | null }) {
  const { t } = useT();
  const { status, counts, sources, tick } = shared;
  const [statuses, setStatuses] = useState<VacancyStatus[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [includeUnscored, setIncludeUnscored] = useState(true);
  const [sort, setSort] = useState<"score" | "date" | "distance">("score");
  const [maxDrive, setMaxDrive] = useState<number | null>(null);
  const [items, setItems] = useState<VacancyListItem[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [local, setLocal] = useState(0);
  const dSearch = useDebounced(search, 150);
  const itemsRef = useRef<VacancyListItem[]>([]);
  const selRef = useRef<number | null>(null);
  selRef.current = selected;

  const filter: VacancyFilter = { statuses, minScore: minScore > 0 ? minScore : null, sourceId, search: dSearch.trim(), includeUnscored, sort, maxTravelMinutes: maxDrive };
  const key = JSON.stringify(filter);

  useEffect(() => {
    let live = true;
    call("vacancies.list", JSON.parse(key) as VacancyFilter).then((r) => {
      if (!live) return;
      itemsRef.current = r;
      setItems(r);
    });
    return () => {
      live = false;
    };
  }, [key, tick, local]);

  useEffect(() => {
    if (focus) setSelected(focus.id);
  }, [focus]);

  // Keep selection valid; select the first row on desktop-style first load.
  useEffect(() => {
    if (!items) return;
    if (selected == null || !items.some((i) => i.id === selected)) {
      if (focus && focus.id === selected) return;
      setSelected(items.length ? items[0].id : null);
    }
  }, [items, selected, focus]);

  const act = useCallback(async (id: number, st: VacancyStatus) => {
    const list = itemsRef.current;
    const idx = list.findIndex((i) => i.id === id);
    const cur = list[idx];
    const next = cur && cur.status === st ? "seen" : st;
    await call("vacancies.setStatus", id, next);
    const hidden = (next === "dismissed" || next === "closed") && !statusesRef.current.includes(next);
    if (hidden && selRef.current === id) {
      const neighbor = list[idx + 1] ?? list[idx - 1];
      setSelected(neighbor ? neighbor.id : null);
    }
    setLocal((n) => n + 1);
  }, []);
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = itemsRef.current;
      const idx = list.findIndex((i) => i.id === selRef.current);
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const n = list[Math.min(list.length - 1, idx + 1)];
        if (n) setSelected(n.id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const n = list[Math.max(0, idx - 1)];
        if (n) setSelected(n.id);
      } else if (selRef.current != null) {
        if (e.key === "o") call("vacancies.openExternal", selRef.current);
        else if (e.key === "i") void act(selRef.current, "interested");
        else if (e.key === "a") void act(selRef.current, "applied");
        else if (e.key === "d") void act(selRef.current, "dismissed");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act]);

  const toggleStatus = (s: VacancyStatus) => setStatuses((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const filtersActive = statuses.length > 0 || minScore > 0 || sourceId != null || search !== "" || !includeUnscored || maxDrive != null;
  const reset = () => {
    setStatuses([]);
    setMinScore(0);
    setSourceId(null);
    setSearch("");
    setIncludeUnscored(true);
    setMaxDrive(null);
  };

  const setupCards = (
    <>
      {!status.apiKeyConfigured && (
        <div className="callout amber">
          <Icon name="key" />
          <div>
            <b>{t("inbox.addKey.title")}</b>
            <span>{t("inbox.addKey.body")}</span>
          </div>
          <button className="btn small" onClick={() => shared.go("settings")}>
            {t("inbox.openSettings")}
          </button>
        </div>
      )}
      {!status.profileReady && (
        <div className="callout amber">
          <Icon name="profile" />
          <div>
            <b>{t("inbox.setupProfile.title")}</b>
            <span>{t("inbox.setupProfile.body")}</span>
          </div>
          <button className="btn small" onClick={() => shared.go("profile")}>
            {t("inbox.openProfile")}
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      <ViewHeader title={t("nav.inbox")} subtitle={items ? t("inbox.count", { count: items.length }) : undefined}>
        <label className="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder={t("inbox.search")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("inbox.search")} />
        </label>
        <select className="drive-select" value={maxDrive ?? ""} onChange={(e) => setMaxDrive(e.target.value ? Number(e.target.value) : null)} aria-label={t("inbox.maxDrive")} title={t("travel.driveTitle")}>
          <option value="">{t("inbox.maxDriveAny")}</option>
          {[15, 30, 45, 60, 90].map((m) => (
            <option key={m} value={m}>{t("inbox.maxDriveN", { min: m })}</option>
          ))}
        </select>
        <Segmented
          label={t("inbox.sortBy")}
          value={sort}
          onChange={setSort}
          options={[
            { id: "score", label: t("inbox.sort.score") },
            { id: "date", label: t("inbox.sort.date") },
            { id: "distance", label: t("inbox.sort.distance") },
          ]}
        />
      </ViewHeader>
      <div className="filters">
        <div className="chips" role="group" aria-label={t("inbox.statusFilter")}>
          {CHIPS.map((c) => (
            <button key={c} className={`chip${statuses.includes(c) ? " on" : ""}`} aria-pressed={statuses.includes(c)} onClick={() => toggleStatus(c)}>
              {t(`vstatus.${c}`)}
            </button>
          ))}
        </div>
        <label className="inline-field">
          <span>{t("inbox.minScore")}</span>
          <input type="range" min={0} max={100} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} aria-label={t("inbox.minScoreAria")} />
          <output>{minScore}</output>
        </label>
        <select value={sourceId ?? ""} onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)} aria-label={t("inbox.source")}>
          <option value="">{t("inbox.allSources")}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={includeUnscored} onChange={(e) => setIncludeUnscored(e.target.checked)} />
          {t("inbox.includeUnscored")}
        </label>
      </div>
      <div className="split">
        <section className="list-pane" aria-label={t("inbox.listAria")}>
          <div className="list-scroll">
            {setupCards}
            {items && items.length === 0 && (
              counts && counts.total === 0 ? (
                <Empty
                  icon="inbox"
                  title={t("inbox.empty.title")}
                  action={
                    <button className="btn primary" disabled={status.scanning} onClick={() => call("scan.now", null)}>
                      {t("action.scanNow")}
                    </button>
                  }
                >
                  {t("inbox.empty.body")}
                </Empty>
              ) : (
                <Empty
                  icon="search"
                  title={t("inbox.nothing.title")}
                  action={
                    filtersActive ? (
                      <button className="btn" onClick={reset}>
                        {t("inbox.clearFilters")}
                      </button>
                    ) : undefined
                  }
                >
                  {filtersActive ? t("inbox.nothing.filters") : t("inbox.nothing.dismissed")}
                </Empty>
              )
            )}
            <div role="listbox" aria-label={t("inbox.listboxAria")}>
              {items?.map((v) => (
                <Row key={v.id} v={v} selected={v.id === selected} onSelect={() => setSelected(v.id)} />
              ))}
            </div>
          </div>
          <div className="hint-bar">
            <span className="hint-item"><kbd>↑</kbd> <kbd>↓</kbd> {t("hint.move")}</span>
            <span className="hint-item"><kbd>o</kbd> {t("hint.open")}</span>
            <span className="hint-item"><kbd>i</kbd> {t("hint.interested")}</span>
            <span className="hint-item"><kbd>a</kbd> {t("hint.applied")}</span>
            <span className="hint-item"><kbd>d</kbd> {t("hint.dismiss")}</span>
          </div>
        </section>
        <section className="detail-pane" aria-label={t("inbox.detailAria")}>
          {selected != null ? (
            <VacancyDetailPane go={shared.go} id={selected} tick={tick + local} onChanged={() => setLocal((n) => n + 1)} onAct={act} />
          ) : (
            <Empty icon="inbox" title={t("inbox.noSelection.title")}>{t("inbox.noSelection.body")}</Empty>
          )}
        </section>
      </div>
    </>
  );
}

function Row({ v, selected, onSelect }: { v: VacancyListItem; selected: boolean; onSelect: () => void }) {
  const { t, lang, fmt } = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const isNew = v.status === "new";
  const dim = v.status === "dismissed" || v.status === "closed";
  return (
    <div ref={ref} role="option" aria-selected={selected} tabIndex={0} className={`row${selected ? " selected" : ""}${dim ? " dim" : ""}`} onClick={onSelect} onKeyDown={(e) => e.key === "Enter" && onSelect()}>
      <span className={`unread${isNew ? " on" : ""}`} title={isNew ? t("row.new") : undefined} />
      <div className="row-score">
        <ScorePill item={v} />
      </div>
      <div className="row-main">
        <div className={`row-title${isNew ? " bold" : ""}`}>{v.title}</div>
        <div className="row-sub">
          <span className="row-sub-text">{[v.organization, v.location].filter(Boolean).join(" · ") || t("common.unknownEmployer")}</span>
          {v.travelMinutes != null && (
            <span className="travel" title={formatTravel(v, lang)}>
              <Icon name="car" size={13} />
              {v.geoState === "approximate" ? "≈ " : ""}
              {t("travel.minShort", { min: Math.round(v.travelMinutes) })}
            </span>
          )}
        </div>
        <div className="row-meta">
          <span>{v.sourceName}</span>
          <span>{t("row.firstSeen", { when: fmt.relative(v.firstSeenAt) })}</span>
          {v.deadline && <span>{t("row.deadline", { date: /^\d{4}-\d{2}-\d{2}$/.test(v.deadline) ? fmt.date(v.deadline) : v.deadline })}</span>}
          {v.duplicateCount > 0 && <span className="tag">{t("row.duplicates", { count: v.duplicateCount })}</span>}
          {(v.status === "interested" || v.status === "applied" || v.status === "dismissed" || v.status === "closed") && <span className={`tag st-${v.status}`}>{t(`vstatus.${v.status}`)}</span>}
        </div>
      </div>
    </div>
  );
}
