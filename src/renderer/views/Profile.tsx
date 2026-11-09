import { useCallback, useEffect, useRef, useState } from "react";
import type { Preferences, Profile } from "../../shared/types";
import { DEFAULT_PREFERENCES } from "../../shared/types";
import { call, errMsg, onRadar } from "../api";
import { Icon, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { useT } from "../i18n";

const CONTRACTS = ["permanent", "temporary", "replacement", "freelance"] as const;

const csv = (a: string[]) => a.join(", ");
const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function ProfileView({ shared }: { shared: Shared }) {
  const { t, fmt } = useT();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [inc, setInc] = useState("");
  const [exc, setExc] = useState("");
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const apply = (p: Profile) => {
    setProfile(p);
    setMarkdown(p.markdown);
    setPrefs({ ...DEFAULT_PREFERENCES, ...p.preferences });
    setInc(csv(p.preferences.includeKeywords ?? []));
    setExc(csv(p.preferences.excludeKeywords ?? []));
    setDirty(false);
  };

  useEffect(() => {
    call("profile.get").then(apply);
  }, []);

  // The home location is resolved in the background after a save; refresh only the resolved state, never the form.
  useEffect(() => {
    const refresh = () => {
      call("profile.get")
        .then((q) => setProfile((cur) => (cur ? { ...cur, homeGeo: q.homeGeo, homeGeoError: q.homeGeoError, version: q.version, updatedAt: q.updatedAt } : cur)))
        .catch(() => {});
    };
    const offs = [onRadar("app.status", refresh), onRadar("vacancies.changed", refresh)];
    return () => offs.forEach((o) => o());
  }, []);

  const edit = <K extends keyof Preferences>(k: K, v: Preferences[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }));
    setDirty(true);
  };

  const save = useCallback(async () => {
    try {
      const p = await call("profile.save", { markdown, preferences: { ...prefs, includeKeywords: parseCsv(inc), excludeKeywords: parseCsv(exc) } });
      apply(p);
      setMsg({ tone: "ok", text: t("profile.saved") });
      setTimeout(() => setMsg((m) => (m?.tone === "ok" ? null : m)), 2500);
    } catch (e) {
      setMsg({ tone: "err", text: errMsg(e) });
    }
  }, [markdown, prefs, inc, exc, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const doImport = async () => {
    if (dirty && !window.confirm(t("profile.confirmImport"))) return;
    setImporting(true);
    setMsg(null);
    try {
      const p = await call("profile.import");
      if (p) {
        apply(p);
        setMsg({ tone: "ok", text: t("profile.imported") });
      }
    } catch (e) {
      setMsg({ tone: "err", text: errMsg(e) });
    } finally {
      setImporting(false);
    }
  };

  const hint = t("profile.addressHint");
  const homeNote = (() => {
    const typed = prefs.homeLocation.trim();
    if (!profile || typed === "" || typed !== profile.preferences.homeLocation.trim()) return <small className="subtle">{hint}</small>;
    return (
      <small className="geo-note">
        {profile.homeGeo ? (
          <span>{t("profile.resolved", { label: profile.homeGeo.label })}</span>
        ) : (
          <span className={profile.homeGeoError ? "err-text" : "subtle"}>{profile.homeGeoError ?? t("profile.notResolved")}</span>
        )}
        <span className="subtle">{hint}</span>
      </small>
    );
  })();

  return (
    <>
      <ViewHeader title={t("nav.profile")} subtitle={profile ? (profile.version > 0 ? t("profile.version", { version: profile.version, when: fmt.relative(profile.updatedAt) }) : t("profile.notSaved")) : undefined}>
        {msg && <span className={`msg ${msg.tone}`} role="status">{msg.text}</span>}
        <button className="btn primary" disabled={!dirty} onClick={save}>{t("common.save")}</button>
      </ViewHeader>
      <div className="scroll">
        <div className="page profile-page">
          {!shared.status.profileReady && !markdown.trim() && (
            <div className="callout amber"><Icon name="profile" /><div><b>{t("profile.none.title")}</b><span>{t("profile.none.body")}</span></div></div>
          )}
          <section className="card">
            <div className="card-row">
              <div>
                <h3>{t("profile.import.title")}</h3>
                <p className="subtle">{t("profile.import.body")}</p>
              </div>
              <button className="btn" disabled={importing} onClick={doImport}>
                {importing ? <><span className="spinner" /> {t("profile.import.importing")}</> : <><Icon name="upload" size={14} /> {t("profile.import.button")}</>}
              </button>
            </div>
            <details className="howto">
              <summary>{t("profile.howto")}</summary>
              <ol>
                <li><b>{t("profile.howto.zip.title")}</b> {t("profile.howto.zip.body")}</li>
                <li><b>{t("profile.howto.pdf.title")}</b> {t("profile.howto.pdf.body")}</li>
              </ol>
            </details>
          </section>

          <section className="card">
            <h3>{t("profile.text.title")}</h3>
            <p className="subtle">{t("profile.text.body")}</p>
            <textarea
              className="mono profile-text"
              value={markdown}
              spellCheck={false}
              placeholder={t("profile.text.placeholder")}
              onChange={(e) => {
                setMarkdown(e.target.value);
                setDirty(true);
              }}
              aria-label={t("profile.text.aria")}
            />
          </section>

          <section className="card">
            <h3>{t("profile.prefs.title")}</h3>
            <p className="subtle">{t("profile.prefs.body")}</p>
            <div className="form-grid">
              <label className="field">
                <span>{t("profile.home")}</span>
                <input type="text" value={prefs.homeLocation} onChange={(e) => edit("homeLocation", e.target.value)} placeholder="Gent" />
                {homeNote}
              </label>
              <label className="field">
                <span>{t("profile.maxCommute")}</span>
                <input type="text" value={prefs.maxCommute} onChange={(e) => edit("maxCommute", e.target.value)} placeholder={t("profile.maxCommutePlaceholder")} />
              </label>
              <label className="field span2">
                <span>{t("profile.regions")}</span>
                <input type="text" value={prefs.regions} onChange={(e) => edit("regions", e.target.value)} placeholder="Oost-Vlaanderen, Brussel" />
              </label>
              <label className="field">
                <span>{t("profile.hours")}</span>
                <select value={prefs.hours} onChange={(e) => edit("hours", e.target.value as Preferences["hours"])}>
                  <option value="any">{t("profile.hours.any")}</option>
                  <option value="fulltime">{t("profile.hours.fulltime")}</option>
                  <option value="parttime">{t("profile.hours.parttime")}</option>
                </select>
              </label>
              <fieldset className="field">
                <legend>{t("profile.contractTypes")}</legend>
                <div className="checks">
                  {CONTRACTS.map((c) => (
                    <label className="check" key={c}>
                      <input
                        type="checkbox"
                        checked={prefs.contractTypes.includes(c)}
                        onChange={(e) => edit("contractTypes", e.target.checked ? [...prefs.contractTypes, c] : prefs.contractTypes.filter((x) => x !== c))}
                      />
                      {t(`profile.contract.${c}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field span2">
                <span>{t("profile.desiredRoles")}</span>
                <textarea rows={2} value={prefs.desiredRoles} onChange={(e) => edit("desiredRoles", e.target.value)} />
              </label>
              <label className="field span2">
                <span>{t("profile.ambitions")}</span>
                <textarea rows={2} value={prefs.ambitions} onChange={(e) => edit("ambitions", e.target.value)} />
              </label>
              <label className="field span2">
                <span>{t("profile.dealBreakers")}</span>
                <textarea rows={2} value={prefs.dealBreakers} onChange={(e) => edit("dealBreakers", e.target.value)} />
              </label>
              <label className="field span2">
                <span>{t("profile.salary")}</span>
                <input type="text" value={prefs.salaryNotes} onChange={(e) => edit("salaryNotes", e.target.value)} />
              </label>
              <label className="field span2">
                <span>{t("profile.include")}</span>
                <input type="text" value={inc} onChange={(e) => { setInc(e.target.value); setDirty(true); }} placeholder={t("profile.includePlaceholder")} />
                <small className="subtle">{t("profile.includeHelp")}</small>
              </label>
              <label className="field span2">
                <span>{t("profile.exclude")}</span>
                <input type="text" value={exc} onChange={(e) => { setExc(e.target.value); setDirty(true); }} placeholder={t("profile.excludePlaceholder")} />
                <small className="subtle">{t("profile.excludeHelp")}</small>
              </label>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
