import { useEffect, useRef, useState } from "react";
import type { Feedback, VacancyDetail } from "../../shared/types";
import { call, errMsg } from "../api";
import { Bar, Icon } from "../components/ui";
import { formatTravel } from "../../shared/travel";
import type { ViewId } from "../App";
import { useT } from "../i18n";

const SUB = ["diploma", "experience", "skills", "preferences"] as const;

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
  const { t, fmt } = useT();
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
  if (v === null) return <div className="detail-loading subtle">{t("detail.gone")}</div>;

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
      ? v.prefilterReason ? t("detail.whyNot.filteredReason", { reason: v.prefilterReason }) : t("detail.whyNot.filtered")
      : v.scoreState === "skipped"
        ? t("detail.whyNot.skipped")
        : v.scoreState === "error"
          ? v.scoreError ? t("detail.whyNot.errorReason", { error: v.scoreError }) : t("detail.whyNot.error")
          : t("detail.whyNot.pending");

  return (
    <div className="detail" ref={scroller}>
      <article className="detail-inner">
        <header className="d-head">
          <div className="d-titlebar">
            <h2>{v.title}</h2>
          </div>
          <div className="d-org">{[v.organization, v.location].filter(Boolean).join(" · ") || t("common.unknownEmployer")}</div>
          <TravelLine v={v} go={go} />
          <div className="d-links">
            <span className="subtle">{v.sourceName}</span>
            <span className="subtle">{t("detail.firstSeen", { when: fmt.relative(v.firstSeenAt) })}</span>
            <button className="link" onClick={() => call("vacancies.openExternal", v.id)}>
              {t("detail.open")} <Icon name="external" size={13} />
            </button>
          </div>
          {v.duplicates.length > 0 && (
            <div className="d-dups">
              {t("detail.alsoPosted")}{" "}
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

        <div className="d-actions" role="group" aria-label={t("detail.statusAria")}>
          <button className={`btn${v.status === "interested" ? " on" : ""}`} aria-pressed={v.status === "interested"} onClick={() => onAct(v.id, "interested")}>
            {t("detail.interested")}
          </button>
          <button className={`btn${v.status === "applied" ? " on" : ""}`} aria-pressed={v.status === "applied"} onClick={() => onAct(v.id, "applied")}>
            {t("detail.applied")}
          </button>
          <button className={`btn${v.status === "dismissed" ? " on" : ""}`} aria-pressed={v.status === "dismissed"} onClick={() => onAct(v.id, "dismissed")}>
            {t("detail.dismiss")}
          </button>
          {(v.status === "interested" || v.status === "applied" || v.status === "dismissed" || v.status === "closed") && (
            <button className="btn ghost" onClick={async () => { await call("vacancies.setStatus", v.id, "seen"); onChanged(); }}>
              {t("detail.backToSeen")}
            </button>
          )}
          {v.status === "closed" && <span className="tag">{t("detail.closedNote")}</span>}
        </div>

        {r && !unscored ? (
          <section className="score-block">
            <div className="score-top">
              <div className="score-big">
                <b className={`t-${r.bucket}`}>{v.score}</b>
                <span>{t("detail.outOf")}</span>
              </div>
              <div className="score-meta">
                <span className={`pill b-${r.bucket}`}>
                  <span>{t(`bucket.${r.bucket}`)}</span>
                </span>
                <span className="subtle">
                  {t("detail.confidence", { level: t(`conf.${r.confidence}`) })} · {v.scoreModel ?? t("detail.modelUnknown")} · {fmt.relative(v.scoredAt)}
                </span>
              </div>
            </div>
            {r.knockoutReason && (
              <div className="callout red">
                <Icon name="warn" />
                <div>
                  <b>{t("detail.knockout")}</b>
                  <span>{r.knockoutReason}</span>
                </div>
              </div>
            )}
            <div className="subscores">
              {SUB.map((k) => (
                <div className="sub" key={k}>
                  <span className="sub-label">{t(`detail.sub.${k}`)}</span>
                  <Bar value={r.subscores[k]} />
                  <span className="sub-num">{r.subscores[k]}</span>
                </div>
              ))}
            </div>
            <div className="rg">
              {r.reasons.length > 0 && (
                <div>
                  <h4>{t("detail.whyFits")}</h4>
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
                  <h4>{t("detail.gaps")}</h4>
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
              <b>{t("detail.notScored")}</b>
              <span>{whyNot}</span>
            </div>
            <button className="btn small primary" disabled={busy} onClick={rescore}>
              {busy ? t("detail.scoring") : t("detail.scoreAnyway")}
            </button>
          </section>
        )}
        {err && <div className="callout red"><Icon name="warn" /><div><b>{t("detail.rescoreFailed")}</b><span>{err}</span></div></div>}

        {v.fields?.summary && <p className="summary">{v.fields.summary}</p>}

        {v.fields && (
          <dl className="fields">
            {(
              [
                [t("detail.field.sector"), v.fields.sector ? v.fields.sector + (v.fields.isSocialSector ? "" : t("detail.notSocial")) : ""],
                [t("detail.field.hours"), v.fields.hours],
                [t("detail.field.contract"), v.fields.contract],
                [t("detail.field.diploma"), v.fields.diplomaRequired],
                [t("detail.field.experience"), v.fields.experienceRequired],
                [t("detail.field.payScale"), v.fields.payScale],
                [t("detail.field.deadline"), v.fields.deadline],
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
            <span className="subtle">{t("detail.feedback.question")}</span>
            <button className={`btn icon-only${v.feedback === "up" ? " on" : ""}`} aria-pressed={v.feedback === "up"} aria-label={t("detail.feedback.good")} title={t("detail.feedback.good")} onClick={() => setFeedback("up")}>
              <Icon name="up" />
            </button>
            <button className={`btn icon-only${v.feedback === "down" ? " on" : ""}`} aria-pressed={v.feedback === "down"} aria-label={t("detail.feedback.poor")} title={t("detail.feedback.poor")} onClick={() => setFeedback("down")}>
              <Icon name="down" />
            </button>
            {v.feedback && (
              <input
                type="text"
                className="note"
                placeholder={t("detail.feedback.note")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onBlur={saveNote}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                aria-label={t("detail.feedback.noteAria")}
              />
            )}
          </div>
          <button className="btn" disabled={busy} onClick={rescore}>
            <Icon name="refresh" size={14} />
            {busy ? t("detail.scoring") : t("detail.rescore")}
          </button>
        </div>}

        <details className="fulltext">
          <summary>{t("detail.fullText")}</summary>
          {v.description ? <div className="prose">{v.description}</div> : <p className="subtle">{v.snippet || t("detail.noText")}</p>}
        </details>
      </article>
    </div>
  );
}

function TravelLine({ v, go }: { v: VacancyDetail; go: (v: ViewId) => void }) {
  const { t, lang } = useT();
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call("profile.get").then((p) => live && setHome(p.homeGeo ? p.homeGeo.label.split(",")[0].trim() : null)).catch(() => {});
    return () => {
      live = false;
    };
  }, [v.id, v.geoState]);

  const matched = v.geoLabel && (
    <span className="d-matched">{t("travel.matched", { label: v.geoLabel })}</span>
  );
  if (v.travelMinutes != null) {
    return (
      <div className="d-travel">
        <Icon name="car" size={14} />
        <span className="d-travel-text">
          {home ? t("travel.line", { travel: formatTravel(v, lang), home }) : t("travel.lineNoHome", { travel: formatTravel(v, lang) })}
          {v.geoState === "approximate" ? ` ${t("travel.regionOnly")}` : ""}
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
          {t("travel.unavailable.pre")}<button className="link" onClick={() => go("settings")}>{t("nav.settings")}</button>{t("travel.unavailable.mid")}
          <button className="link" onClick={() => go("profile")}>{t("nav.profile")}</button>{t("travel.unavailable.post")}
        </span>
      </div>
    );
  }
  let text: string;
  if (v.geoState === "not_found") text = t("travel.notFound", { query: v.geoQuery });
  else if (v.geoState === "error") text = v.geoError ? t("travel.errorWith", { error: v.geoError }) : t("travel.error");
  else if (v.geoState === "pending") text = t("travel.pending");
  else text = t("travel.unknown");
  return (
    <div className="d-travel subtle">
      <Icon name="car" size={14} />
      <span className="d-travel-text">{text}</span>
    </div>
  );
}
