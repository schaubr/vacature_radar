import { useCallback, useEffect, useRef, useState } from "react";
import type { Preferences, Profile } from "../../shared/types";
import { DEFAULT_PREFERENCES } from "../../shared/types";
import { call, errMsg } from "../api";
import { Icon, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { relativeTime } from "../util";

const CONTRACTS: { id: string; label: string }[] = [
  { id: "permanent", label: "Permanent" },
  { id: "temporary", label: "Temporary" },
  { id: "replacement", label: "Replacement" },
  { id: "freelance", label: "Freelance" },
];

const csv = (a: string[]) => a.join(", ");
const parseCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function ProfileView({ shared }: { shared: Shared }) {
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

  const edit = <K extends keyof Preferences>(k: K, v: Preferences[K]) => {
    setPrefs((p) => ({ ...p, [k]: v }));
    setDirty(true);
  };

  const save = useCallback(async () => {
    try {
      const p = await call("profile.save", { markdown, preferences: { ...prefs, includeKeywords: parseCsv(inc), excludeKeywords: parseCsv(exc) } });
      apply(p);
      setMsg({ tone: "ok", text: "Saved" });
      setTimeout(() => setMsg((m) => (m?.text === "Saved" ? null : m)), 2500);
    } catch (e) {
      setMsg({ tone: "err", text: errMsg(e) });
    }
  }, [markdown, prefs, inc, exc]);

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
    if (dirty && !window.confirm("Importing replaces the profile text you have edited but not saved. Continue?")) return;
    setImporting(true);
    setMsg(null);
    try {
      const p = await call("profile.import");
      if (p) {
        apply(p);
        setMsg({ tone: "ok", text: "Imported. Review the text below, then save any edits." });
      }
    } catch (e) {
      setMsg({ tone: "err", text: errMsg(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <ViewHeader title="Profile" subtitle={profile ? (profile.version > 0 ? `version ${profile.version} · updated ${relativeTime(profile.updatedAt)}` : "not saved yet") : undefined}>
        {msg && <span className={`msg ${msg.tone}`} role="status">{msg.text}</span>}
        <button className="btn primary" disabled={!dirty} onClick={save}>Save</button>
      </ViewHeader>
      <div className="scroll">
        <div className="page profile-page">
          {!shared.status.profileReady && !markdown.trim() && (
            <div className="callout amber"><Icon name="profile" /><div><b>No profile yet</b><span>Vacancies are scored against this text. Import your LinkedIn export, or write it yourself.</span></div></div>
          )}
          <section className="card">
            <div className="card-row">
              <div>
                <h3>Import from LinkedIn</h3>
                <p className="subtle">Accepts the data-export <code>.zip</code> or a profile <code>.pdf</code>. Importing replaces the text below.</p>
              </div>
              <button className="btn" disabled={importing} onClick={doImport}>
                {importing ? <><span className="spinner" /> Importing…</> : <><Icon name="upload" size={14} /> Import LinkedIn export</>}
              </button>
            </div>
            <details className="howto">
              <summary>How do I get the export?</summary>
              <ol>
                <li><b>Full data (.zip):</b> LinkedIn, Settings, Data privacy, <i>Get a copy of your data</i>. Choose the full archive or just Profile, Positions, Education, Skills. LinkedIn emails a link, usually within minutes to a day.</li>
                <li><b>Quick PDF:</b> open your profile, More, <i>Save to PDF</i>. Claude turns it into the markdown below (a small API cost).</li>
              </ol>
            </details>
          </section>

          <section className="card">
            <h3>Profile text</h3>
            <p className="subtle">Markdown that describes you: experience, education, skills, languages. This is what every vacancy is compared against.</p>
            <textarea
              className="mono profile-text"
              value={markdown}
              spellCheck={false}
              placeholder={"# Name\n\n## Experience\n- Role, organization, period…"}
              onChange={(e) => {
                setMarkdown(e.target.value);
                setDirty(true);
              }}
              aria-label="Profile markdown"
            />
          </section>

          <section className="card">
            <h3>Preferences</h3>
            <p className="subtle">What you want and what rules a vacancy out. Free text is passed to the scoring model as is.</p>
            <div className="form-grid">
              <label className="field">
                <span>Home location</span>
                <input type="text" value={prefs.homeLocation} onChange={(e) => edit("homeLocation", e.target.value)} placeholder="Gent" />
              </label>
              <label className="field">
                <span>Maximum commute</span>
                <input type="text" value={prefs.maxCommute} onChange={(e) => edit("maxCommute", e.target.value)} placeholder="max 45 min by train or 40 km" />
              </label>
              <label className="field span2">
                <span>Regions</span>
                <input type="text" value={prefs.regions} onChange={(e) => edit("regions", e.target.value)} placeholder="Oost-Vlaanderen, Brussel" />
              </label>
              <label className="field">
                <span>Hours</span>
                <select value={prefs.hours} onChange={(e) => edit("hours", e.target.value as Preferences["hours"])}>
                  <option value="any">Any</option>
                  <option value="fulltime">Full-time</option>
                  <option value="parttime">Part-time</option>
                </select>
              </label>
              <fieldset className="field">
                <legend>Contract types</legend>
                <div className="checks">
                  {CONTRACTS.map((c) => (
                    <label className="check" key={c.id}>
                      <input
                        type="checkbox"
                        checked={prefs.contractTypes.includes(c.id)}
                        onChange={(e) => edit("contractTypes", e.target.checked ? [...prefs.contractTypes, c.id] : prefs.contractTypes.filter((x) => x !== c.id))}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field span2">
                <span>Desired roles</span>
                <textarea rows={2} value={prefs.desiredRoles} onChange={(e) => edit("desiredRoles", e.target.value)} />
              </label>
              <label className="field span2">
                <span>Ambitions</span>
                <textarea rows={2} value={prefs.ambitions} onChange={(e) => edit("ambitions", e.target.value)} />
              </label>
              <label className="field span2">
                <span>Deal-breakers</span>
                <textarea rows={2} value={prefs.dealBreakers} onChange={(e) => edit("dealBreakers", e.target.value)} />
              </label>
              <label className="field span2">
                <span>Salary notes</span>
                <input type="text" value={prefs.salaryNotes} onChange={(e) => edit("salaryNotes", e.target.value)} />
              </label>
              <label className="field span2">
                <span>Must mention (keywords)</span>
                <input type="text" value={inc} onChange={(e) => { setInc(e.target.value); setDirty(true); }} placeholder="comma separated; empty = no restriction" />
                <small className="subtle">Pre-filter: when set, a vacancy’s title or snippet must contain one of these before it is scored.</small>
              </label>
              <label className="field span2">
                <span>Exclude from title (keywords)</span>
                <input type="text" value={exc} onChange={(e) => { setExc(e.target.value); setDirty(true); }} placeholder="comma separated, e.g. poetsvrouw, chauffeur" />
                <small className="subtle">Vacancies whose title contains any of these are never scored, which saves money.</small>
              </label>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
