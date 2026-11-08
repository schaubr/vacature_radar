import { useEffect, useRef, useState } from "react";
import type { Feedback, VacancyDetail } from "../../shared/types";
import { call, errMsg } from "../api";
import { Bar, Icon } from "../components/ui";
import { formatTravel } from "../../shared/travel";
import type { ViewId } from "../App";
import { BUCKET_LABEL, relativeTime } from "../util";

const SUB: { key: "diploma" | "experience" | "skills" | "preferences"; label: string }[] = [
  { key: "diploma", label: "Diploma" },
  { key: "experience", label: "Experience" },
  { key: "skills", label: "Skills" },
  { key: "preferences", label: "Preferences" },
];

export function VacancyDetailPane({
  id,
  go,
  tick,
  onChanged,
  onAct,
}: {
  id: number;
  go: (v: ViewId) => void;
  tick: number;
  onChanged: () => void;
  onAct: (id: number, st: "interested" | "applied" | "dismissed") => void;
}) {
  const [v, setV] = useState<VacancyDetail | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loadedId = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    call("vacancies.get", id).then((d) => {
      if (!live) return;
      const first = loadedId.current !== id;
      setV(d);
      if (first) {
        setNote(d?.feedbackNote ?? "");
        setErr(null);
        scroller.current?.scrollTo({ top: 0 });
        loadedId.current = id;
      }
    });
    return () => {
      live = false;
    };
  }, [id, tick]);

  // Opening a "new" vacancy marks it seen: refresh the list once.
  const seenNotified = useRef<number | null>(null);
  useEffect(() => {
    if (v && v.id === id && seenNotified.current !== id) {
      seenNotified.current = id;
      onChanged();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.id]);

  if (v === undefined) return <div className="detail-loading" />;
  if (v === null) return <div className="detail-loading subtle">This vacancy no longer exists.</div>;

  const r = v.scoreResult;
  const setFeedback = async (f: Feedback) => {
    const next = v.feedback === f ? null : f;
    await call("vacancies.setFeedback", v.id, next, note);
    onChanged();
  };
  const saveNote = async () => {
    if (v.feedback && note !== v.feedbackNote) {
      await call("vacancies.setFeedback", v.id, v.feedback, note);
      onChanged();
    }
  };
  const rescore = async () => {
    setBusy(true);
    setErr(null);
    try {
      await call("vacancies.rescore", v.id);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const unscored = v.scoreState !== "scored" || !r;
  const whyNot =
    v.scoreState === "filtered"
      ? `Filtered out before scoring${v.prefilterReason ? `: ${v.prefilterReason}` : "."}`
      : v.scoreState === "skipped"
        ? "Skipped: this scan already scored the maximum number of new vacancies."
        : v.scoreState === "error"
          ? `Scoring failed${v.scoreError ? `: ${v.scoreError}` : "."}`
          : "Waiting in the scoring queue.";

  return (
    <div className="detail" ref={scroller}>
      <article className="detail-inner">
        <header className="d-head">
          <div className="d-titlebar">
            <h2>{v.title}</h2>
          </div>
          <div className="d-org">{[v.organization, v.location].filter(Boolean).join(" · ") || "Unknown employer"}</div>
          <TravelLine v={v} go={go} />
          <div className="d-links">
            <span className="subtle">{v.sourceName}</span>
            <span className="subtle">first seen {relativeTime(v.firstSeenAt)}</span>
            <button className="link" onClick={() => call("vacancies.openExternal", v.id)}>
              Open vacancy <Icon name="external" size={13} />
            </button>
          </div>
          {v.duplicates.length > 0 && (
            <div className="d-dups">
              Also posted on:{" "}
              {v.duplicates.map((d, i) => (
                <span key={d.id}>
                  {i > 0 && ", "}
                  <button className="link" title={d.url} onClick={() => call("vacancies.openExternal", d.id)}>
                    {d.sourceName}
                  </button>
                </span>
              ))}
            </div>
          )}
        </header>

        <div className="d-actions" role="group" aria-label="Status">
          <button className={`btn${v.status === "interested" ? " on" : ""}`} aria-pressed={v.status === "interested"} onClick={() => onAct(v.id, "interested")}>
            Interested
          </button>
          <button className={`btn${v.status === "applied" ? " on" : ""}`} aria-pressed={v.status === "applied"} onClick={() => onAct(v.id, "applied")}>
            Applied
          </button>
          <button className={`btn${v.status === "dismissed" ? " on" : ""}`} aria-pressed={v.status === "dismissed"} onClick={() => onAct(v.id, "dismissed")}>
            Dismiss
          </button>
          {(v.status === "interested" || v.status === "applied" || v.status === "dismissed" || v.status === "closed") && (
            <button className="btn ghost" onClick={async () => { await call("vacancies.setStatus", v.id, "seen"); onChanged(); }}>
              Back to Seen
            </button>
          )}
          {v.status === "closed" && <span className="tag">closed: no longer listed</span>}
        </div>

        {r && !unscored ? (
          <section className="score-block">
            <div className="score-top">
              <div className="score-big">
                <b className={`t-${r.bucket}`}>{v.score}</b>
                <span>/ 100</span>
              </div>
              <div className="score-meta">
                <span className={`pill b-${r.bucket}`}>
                  <span>{BUCKET_LABEL[r.bucket]}</span>
                </span>
                <span className="subtle">
                  {r.confidence} confidence · {v.scoreModel ?? "model unknown"} · {relativeTime(v.scoredAt)}
                </span>
              </div>
            </div>
            {r.knockoutReason && (
              <div className="callout red">
                <Icon name="warn" />
                <div>
                  <b>Knockout</b>
                  <span>{r.knockoutReason}</span>
                </div>
              </div>
            )}
            <div className="subscores">
              {SUB.map((s) => (
                <div className="sub" key={s.key}>
                  <span className="sub-label">{s.label}</span>
                  <Bar value={r.subscores[s.key]} />
                  <span className="sub-num">{r.subscores[s.key]}</span>
                </div>
              ))}
            </div>
            <div className="rg">
              {r.reasons.length > 0 && (
                <div>
                  <h4>Why it fits</h4>
                  <ul className="rlist good">
                    {r.reasons.map((x, i) => (
                      <li key={i}>
                        <Icon name="check" size={14} />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {r.gaps.length > 0 && (
                <div>
                  <h4>Gaps</h4>
                  <ul className="rlist gap">
                    {r.gaps.map((x, i) => (
                      <li key={i}>
                        <Icon name="warn" size={14} />
                        <span>{x}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="callout neutral">
            <Icon name="warn" />
            <div>
              <b>Not scored</b>
              <span>{whyNot}</span>
            </div>
            <button className="btn small primary" disabled={busy} onClick={rescore}>
              {busy ? "Scoring…" : "Score anyway"}
            </button>
          </section>
        )}
        {err && <div className="callout red"><Icon name="warn" /><div><b>Re-score failed</b><span>{err}</span></div></div>}

        {v.fields?.summary && <p className="summary">{v.fields.summary}</p>}

        {v.fields && (
          <dl className="fields">
            {(
              [
                ["Sector", v.fields.sector ? v.fields.sector + (v.fields.isSocialSector ? "" : " (not social sector)") : ""],
                ["Hours", v.fields.hours],
                ["Contract", v.fields.contract],
                ["Diploma", v.fields.diplomaRequired],
                ["Experience", v.fields.experienceRequired],
                ["Pay scale", v.fields.payScale],
                ["Deadline", v.fields.deadline],
              ] as [string, string][]
            )
              .filter(([, val]) => val)
              .map(([k, val]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{val}</dd>
                </div>
              ))}
          </dl>
        )}

        {!unscored && <div className="d-footer-actions">
          <div className="feedback">
            <span className="subtle">Was this score useful?</span>
            <button className={`btn icon-only${v.feedback === "up" ? " on" : ""}`} aria-pressed={v.feedback === "up"} aria-label="Good match" title="Good match" onClick={() => setFeedback("up")}>
              <Icon name="up" />
            </button>
            <button className={`btn icon-only${v.feedback === "down" ? " on" : ""}`} aria-pressed={v.feedback === "down"} aria-label="Poor match" title="Poor match" onClick={() => setFeedback("down")}>
              <Icon name="down" />
            </button>
            {v.feedback && (
              <input
                type="text"
                className="note"
                placeholder="Optional note, used to calibrate future scores"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={saveNote}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-label="Feedback note"
              />
            )}
          </div>
          <button className="btn" disabled={busy} onClick={rescore}>
            <Icon name="refresh" size={14} />
            {busy ? "Scoring…" : "Re-score"}
          </button>
        </div>}

        <details className="fulltext">
          <summary>Full vacancy text</summary>
          {v.description ? <div className="prose">{v.description}</div> : <p className="subtle">{v.snippet || "No detail text was fetched."}</p>}
        </details>
      </article>
    </div>
  );
}

function TravelLine({ v, go }: { v: VacancyDetail; go: (v: ViewId) => void }) {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call("profile.get").then((p) => live && setHome(p.homeGeo ? p.homeGeo.label.split(",")[0].trim() : null)).catch(() => {});
    return () => {
      live = false;
    };
  }, [v.id, v.geoState]);

  const matched = v.geoLabel && (
    <span className="d-matched">matched: {v.geoLabel}</span>
  );
  if (v.travelMinutes != null) {
    return (
      <div className="d-travel">
        <Icon name="car" size={14} />
        <span className="d-travel-text">
          {formatTravel(v)}
          {home ? ` from ${home}` : ""} (without traffic){v.geoState === "approximate" ? " (region only)" : ""}
          {matched}
        </span>
      </div>
    );
  }
  if (v.geoState === "unavailable") {
    return (
      <div className="d-travel subtle">
        <Icon name="car" size={14} />
        <span className="d-travel-text">
          Add an OpenRouteService key (<button className="link" onClick={() => go("settings")}>Settings</button>) and your home location (
          <button className="link" onClick={() => go("profile")}>Profile</button>) to see travel time.
        </span>
      </div>
    );
  }
  let text: string;
  if (v.geoState === "not_found") text = `Could not place “${v.geoQuery}”`;
  else if (v.geoState === "error") text = `Travel time unavailable${v.geoError ? `: ${v.geoError}` : "."}`;
  else if (v.geoState === "pending") text = "Travel time is being calculated…";
  else text = "No travel time known.";
  return (
    <div className="d-travel subtle">
      <Icon name="car" size={14} />
      <span className="d-travel-text">{text}</span>
    </div>
  );
}
