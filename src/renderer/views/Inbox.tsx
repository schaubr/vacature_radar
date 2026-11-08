import { useCallback, useEffect, useRef, useState } from "react";
import type { VacancyFilter, VacancyListItem, VacancyStatus } from "../../shared/types";
import { call } from "../api";
import { Empty, Icon, ScorePill, Segmented, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { formatTravel } from "../../shared/travel";
import { isTypingTarget, relativeTime, useDebounced } from "../util";
import { VacancyDetailPane } from "./VacancyDetail";

const CHIPS: { id: VacancyStatus; label: string }[] = [
  { id: "new", label: "New" },
  { id: "seen", label: "Seen" },
  { id: "interested", label: "Interested" },
  { id: "applied", label: "Applied" },
  { id: "dismissed", label: "Dismissed" },
  { id: "closed", label: "Closed" },
];

export function Inbox({ shared, focus }: { shared: Shared; focus: { id: number; n: number } | null }) {
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
            <b>Add your Anthropic API key</b>
            <span>Vacancies are collected, but scoring needs a key.</span>
          </div>
          <button className="btn small" onClick={() => shared.go("settings")}>
            Open Settings
          </button>
        </div>
      )}
      {!status.profileReady && (
        <div className="callout amber">
          <Icon name="profile" />
          <div>
            <b>Set up your profile</b>
            <span>Import your LinkedIn export so vacancies can be scored against it.</span>
          </div>
          <button className="btn small" onClick={() => shared.go("profile")}>
            Open Profile
          </button>
        </div>
      )}
    </>
  );

  return (
    <>
      <ViewHeader title="Inbox" subtitle={items ? `${items.length} vacanc${items.length === 1 ? "y" : "ies"}` : undefined}>
        <label className="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search vacancies" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search vacancies" />
        </label>
        <select className="drive-select" value={maxDrive ?? ""} onChange={(e) => setMaxDrive(e.target.value ? Number(e.target.value) : null)} aria-label="Max drive" title="Max drive (by car). Hides vacancies with a known drive time above this; unknown stays visible.">
          <option value="">Max drive: any</option>
          {[15, 30, 45, 60, 90].map((m) => (
            <option key={m} value={m}>Max drive: {m} min</option>
          ))}
        </select>
        <Segmented
          label="Sort by"
          value={sort}
          onChange={setSort}
          options={[
            { id: "score", label: "Score" },
            { id: "date", label: "Date" },
            { id: "distance", label: "Distance" },
          ]}
        />
      </ViewHeader>
      <div className="filters">
        <div className="chips" role="group" aria-label="Status filter">
          {CHIPS.map((c) => (
            <button key={c.id} className={`chip${statuses.includes(c.id) ? " on" : ""}`} aria-pressed={statuses.includes(c.id)} onClick={() => toggleStatus(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <label className="inline-field">
          <span>Min score</span>
          <input type="range" min={0} max={100} step={5} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} aria-label="Minimum score" />
          <output>{minScore}</output>
        </label>
        <select value={sourceId ?? ""} onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : null)} aria-label="Source">
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={includeUnscored} onChange={(e) => setIncludeUnscored(e.target.checked)} />
          Include unscored
        </label>
      </div>
      <div className="split">
        <section className="list-pane" aria-label="Vacancies">
          <div className="list-scroll">
            {setupCards}
            {items && items.length === 0 && (
              counts && counts.total === 0 ? (
                <Empty
                  icon="inbox"
                  title="No vacancies yet"
                  action={
                    <button className="btn primary" disabled={status.scanning} onClick={() => call("scan.now", null)}>
                      Scan now
                    </button>
                  }
                >
                  Run a first scan to collect vacancies from your sources.
                </Empty>
              ) : (
                <Empty
                  icon="search"
                  title="Nothing matches"
                  action={
                    filtersActive ? (
                      <button className="btn" onClick={reset}>
                        Clear filters
                      </button>
                    ) : undefined
                  }
                >
                  {filtersActive ? "No vacancies fit the current filters." : "Everything has been dismissed or closed."}
                </Empty>
              )
            )}
            <div role="listbox" aria-label="Vacancy list">
              {items?.map((v) => (
                <Row key={v.id} v={v} selected={v.id === selected} onSelect={() => setSelected(v.id)} />
              ))}
            </div>
          </div>
          <div className="hint-bar">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>o</kbd> open <kbd>i</kbd> interested <kbd>a</kbd> applied <kbd>d</kbd> dismiss
          </div>
        </section>
        <section className="detail-pane" aria-label="Vacancy detail">
          {selected != null ? (
            <VacancyDetailPane go={shared.go} id={selected} tick={tick + local} onChanged={() => setLocal((n) => n + 1)} onAct={act} />
          ) : (
            <Empty icon="inbox" title="No vacancy selected">Pick one from the list to read the details.</Empty>
          )}
        </section>
      </div>
    </>
  );
}

function Row({ v, selected, onSelect }: { v: VacancyListItem; selected: boolean; onSelect: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const isNew = v.status === "new";
  const dim = v.status === "dismissed" || v.status === "closed";
  return (
    <div ref={ref} role="option" aria-selected={selected} tabIndex={0} className={`row${selected ? " selected" : ""}${dim ? " dim" : ""}`} onClick={onSelect} onKeyDown={(e) => e.key === "Enter" && onSelect()}>
      <span className={`unread${isNew ? " on" : ""}`} title={isNew ? "New" : undefined} />
      <div className="row-score">
        <ScorePill item={v} />
      </div>
      <div className="row-main">
        <div className={`row-title${isNew ? " bold" : ""}`}>{v.title}</div>
        <div className="row-sub">
          <span className="row-sub-text">{[v.organization, v.location].filter(Boolean).join(" · ") || "Unknown employer"}</span>
          {v.travelMinutes != null && (
            <span className="travel" title={formatTravel(v)}>
              <Icon name="car" size={13} />
              {v.geoState === "approximate" ? "≈ " : ""}
              {Math.round(v.travelMinutes)} min
            </span>
          )}
        </div>
        <div className="row-meta">
          <span>{v.sourceName}</span>
          <span>first seen {relativeTime(v.firstSeenAt)}</span>
          {v.deadline && <span>deadline {v.deadline}</span>}
          {v.duplicateCount > 0 && <span className="tag">+{v.duplicateCount} duplicate{v.duplicateCount > 1 ? "s" : ""}</span>}
          {(v.status === "interested" || v.status === "applied" || v.status === "dismissed" || v.status === "closed") && <span className={`tag st-${v.status}`}>{v.status}</span>}
        </div>
      </div>
    </div>
  );
}
