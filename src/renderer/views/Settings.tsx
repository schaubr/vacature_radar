import { useEffect, useState, type ReactNode } from "react";
import type { Effort, ModelId, OutputLanguage, Settings, UsageSummary } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { MODELS } from "../../shared/models";
import { call, errMsg } from "../api";
import { Bar, Segmented, Switch, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { MODEL_PRICE, useLoad, usd } from "../util";

const PURPOSE_LABEL: Record<string, string> = {
  score: "Scoring vacancies",
  learn_recipe: "Learning page layouts",
  extract_listing: "Reading listings (fallback)",
  profile_import: "Profile import",
};

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-text">
        <div className="srow-label">{label}</div>
        {hint && <div className="srow-hint">{hint}</div>}
      </div>
      <div className="srow-control">{children}</div>
    </div>
  );
}

/** Number input that commits on blur / Enter. */
function NumberField({ value, onCommit, min, max, step = 1, suffix, label }: { value: number; onCommit: (n: number) => void; min: number; max?: number; step?: number; suffix?: string; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    let n = Number(text);
    if (!Number.isFinite(n) || text.trim() === "") n = value;
    n = Math.max(min, max != null ? Math.min(max, n) : n);
    setText(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <span className="numfield">
      <input type="number" aria-label={label} min={min} max={max} step={step} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      {suffix && <span className="subtle">{suffix}</span>}
    </span>
  );
}

export function SettingsView({ shared }: { shared: Shared }) {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const key = useLoad(() => call("apiKey.status"), [shared.status.apiKeyConfigured, shared.tick]);
  const usage = useLoad<UsageSummary>(() => call("usage.summary"), [shared.tick]);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [replace, setReplace] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ors = useLoad(() => call("orsKey.status"), [shared.status.travelConfigured, shared.tick]);
  const [orsInput, setOrsInput] = useState("");
  const [orsBusy, setOrsBusy] = useState(false);
  const [orsMsg, setOrsMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [orsReplace, setOrsReplace] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [recompute, setRecompute] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    call("settings.get").then((v) => {
      setS(v);
      setLoaded(true);
    });
  }, []);

  const patch = async (p: Partial<Settings>) => {
    setS((cur) => ({ ...cur, ...p }));
    try {
      setS(await call("settings.save", p));
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    }
  };

  const saveKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      const r = await call("apiKey.set", keyInput.trim());
      if (r.ok) {
        setKeyInput("");
        setReplace(false);
        setKeyMsg({ tone: "ok", text: "Key verified and stored in the macOS keychain." });
        key.reload();
      } else setKeyMsg({ tone: "err", text: r.error ?? "The key was rejected." });
    } catch (e) {
      setKeyMsg({ tone: "err", text: errMsg(e) });
    } finally {
      setKeyBusy(false);
    }
  };

  const saveOrsKey = async () => {
    setOrsBusy(true);
    setOrsMsg(null);
    try {
      const r = await call("orsKey.set", orsInput.trim());
      if (r.ok) {
        setOrsInput("");
        setOrsReplace(false);
        setOrsMsg({ tone: "ok", text: "Key verified and stored in the macOS keychain. Travel times are being calculated." });
        ors.reload();
      } else setOrsMsg({ tone: "err", text: r.error ?? "The key was rejected." });
    } catch (e) {
      setOrsMsg({ tone: "err", text: errMsg(e) });
    } finally {
      setOrsBusy(false);
    }
  };
  const runRecompute = async () => {
    setRecomputing(true);
    setRecompute(null);
    try {
      const r = await call("travel.recompute");
      setRecompute({ tone: r.updated === 0 && r.failed > 0 ? "err" : "ok", text: `${r.updated} updated, ${r.failed} failed` });
    } catch (e) {
      setRecompute({ tone: "err", text: errMsg(e) });
    } finally {
      setRecomputing(false);
    }
  };

  const u = usage.data;
  const maxDay = u ? Math.max(0.0001, ...u.last30Days.map((d) => d.usd)) : 1;
  const pct = u && u.budgetUsd > 0 ? Math.min(100, (u.monthUsd / u.budgetUsd) * 100) : 0;
  const configured = key.data?.configured ?? shared.status.apiKeyConfigured;
  const orsConfigured = ors.data?.configured ?? false;

  return (
    <>
      <ViewHeader title="Settings">{err && <span className="msg err">{err}</span>}</ViewHeader>
      <div className="scroll">
        <div className="page settings-page" aria-busy={!loaded}>
          <section className="card">
            <h3>Anthropic API key</h3>
            <p className="subtle">Used only from the app’s background process. It never reaches this window.</p>
            {configured && !replace ? (
              <div className="key-row">
                <code className="masked">{key.data?.masked ?? "••••••••"}</code>
                <button className="btn" onClick={() => setReplace(true)}>Replace</button>
                <button className="btn danger-text" onClick={async () => { await call("apiKey.clear"); setKeyMsg(null); key.reload(); }}>Clear</button>
              </div>
            ) : (
              <form className="key-row" onSubmit={(e) => { e.preventDefault(); if (keyInput.trim()) void saveKey(); }}>
                <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label="API key" />
                <button className="btn primary" type="submit" disabled={keyBusy || !keyInput.trim()}>{keyBusy ? "Checking…" : "Save"}</button>
                {replace && <button className="btn ghost" type="button" onClick={() => { setReplace(false); setKeyInput(""); }}>Cancel</button>}
              </form>
            )}
            {keyMsg && <div className={`msg ${keyMsg.tone} block`} role="status">{keyMsg.text}</div>}
          </section>

          <section className="card">
            <h3>Travel time (OpenRouteService)</h3>
            <p className="subtle">
              Free account at openrouteservice.org, then copy the API key from the dashboard. Car travel time without traffic. Free plan quotas are enough for normal use.
            </p>
            {orsConfigured && !orsReplace ? (
              <div className="key-row">
                <code className="masked">{ors.data?.masked ?? "••••••••"}</code>
                <button className="btn" onClick={() => setOrsReplace(true)}>Replace</button>
                <button className="btn danger-text" onClick={async () => { await call("orsKey.clear"); setOrsMsg(null); setRecompute(null); ors.reload(); }}>Clear</button>
              </div>
            ) : (
              <form className="key-row" onSubmit={(e) => { e.preventDefault(); if (orsInput.trim()) void saveOrsKey(); }}>
                <input type="password" autoComplete="off" spellCheck={false} placeholder="OpenRouteService API key" value={orsInput} onChange={(e) => setOrsInput(e.target.value)} aria-label="OpenRouteService API key" />
                <button className="btn primary" type="submit" disabled={orsBusy || !orsInput.trim()}>{orsBusy ? "Checking…" : "Save"}</button>
                {orsReplace && <button className="btn ghost" type="button" onClick={() => { setOrsReplace(false); setOrsInput(""); }}>Cancel</button>}
              </form>
            )}
            {orsMsg && <div className={`msg ${orsMsg.tone} block`} role="status">{orsMsg.text}</div>}
            <Row label="Recompute all travel times" hint="Looks up your home and every open vacancy again. Uses a few routing requests.">
              <span className="recompute">
                {recompute && <span className={`msg ${recompute.tone}`} role="status">{recompute.text}</span>}
                <button className="btn" disabled={recomputing || !orsConfigured} onClick={runRecompute}>{recomputing ? "Recomputing…" : "Recompute"}</button>
              </span>
            </Row>
          </section>

          <section className="card">
            <h3>Models</h3>
            <Row label="Scoring model" hint={MODEL_PRICE[s.scoringModel]}>
              <select value={s.scoringModel} aria-label="Scoring model" onChange={(e) => patch({ scoringModel: e.target.value as ModelId })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.note}</option>)}
              </select>
            </Row>
            <Row label="Utility model" hint={<>{MODEL_PRICE[s.utilityModel]}. Page layouts, listing fallback, PDF import.</>}>
              <select value={s.utilityModel} aria-label="Utility model" onChange={(e) => patch({ utilityModel: e.target.value as ModelId })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {m.note}</option>)}
              </select>
            </Row>
            <Row label="Thinking effort" hint="Higher effort reasons longer and costs more.">
              <Segmented<Effort> label="Effort" value={s.effort} onChange={(v) => patch({ effort: v })} options={[{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }]} />
            </Row>
            <Row label="Output language" hint="Summaries, reasons and gaps.">
              <Segmented<OutputLanguage> label="Language" value={s.outputLanguage} onChange={(v) => patch({ outputLanguage: v })} options={[{ id: "en", label: "English" }, { id: "nl", label: "Nederlands" }]} />
            </Row>
          </section>

          <section className="card">
            <h3>Scanning</h3>
            <Row label="Scan interval" hint="Sources can override this individually.">
              <NumberField label="Scan interval in hours" value={s.scanIntervalHours} min={0.25} step={0.25} suffix="hours" onCommit={(n) => patch({ scanIntervalHours: n })} />
            </Row>
            <Row label="New vacancies scored per scan" hint="Per source. The rest are marked skipped and can be scored by hand.">
              <NumberField label="Max new scored per scan" value={s.maxNewScoredPerScan} min={1} max={200} onCommit={(n) => patch({ maxNewScoredPerScan: n })} />
            </Row>
            <Row label="Close after missed scans" hint="A vacancy that is no longer listed is marked closed after this many scans.">
              <NumberField label="Close after missed scans" value={s.closeAfterMissedScans} min={1} max={20} onCommit={(n) => patch({ closeAfterMissedScans: n })} />
            </Row>
            <Row label="Launch at login">
              <Switch label="Launch at login" checked={s.launchAtLogin} onChange={(v) => patch({ launchAtLogin: v })} />
            </Row>
          </section>

          <section className="card">
            <h3>Notifications</h3>
            <Row label="Notify me about strong matches">
              <Switch label="Notifications" checked={s.notificationsEnabled} onChange={(v) => patch({ notificationsEnabled: v })} />
            </Row>
            <Row label="Minimum score to notify" hint="Knockouts never notify.">
              <NumberField label="Notify threshold" value={s.notifyThreshold} min={0} max={100} step={5} onCommit={(n) => patch({ notifyThreshold: n })} />
            </Row>
          </section>

          <section className="card">
            <h3>Usage and budget</h3>
            <Row label="Monthly budget" hint="Scoring pauses when the month’s spend reaches this.">
              <NumberField label="Monthly budget in USD" value={s.monthlyBudgetUsd} min={0} step={1} suffix="USD" onCommit={(n) => patch({ monthlyBudgetUsd: n })} />
            </Row>
            {u && (
              <div className="usage">
                <div className="usage-head">
                  <div><b className="usage-big">{usd(u.monthUsd)}</b> <span className="subtle">of {usd(u.budgetUsd)} this month</span></div>
                  {u.budgetExceeded && <span className="level l-error">Budget reached</span>}
                </div>
                <Bar value={pct} tone={u.budgetExceeded ? "knockout" : pct > 80 ? "possible" : "strong"} />
                {u.byPurpose.length > 0 && (
                  <table className="table compact purposes">
                    <tbody>
                      {u.byPurpose.map((p) => (
                        <tr key={p.purpose}>
                          <td>{PURPOSE_LABEL[p.purpose] ?? p.purpose}</td>
                          <td className="subtle num">{p.calls} {p.calls === 1 ? "call" : "calls"}</td>
                          <td className="num" style={{ width: 80 }}>{usd(p.usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {u.last30Days.length > 0 && (
                  <div className="days" aria-label="Spend per day, last 30 days">
                    <div className="days-bars">
                      {u.last30Days.map((d) => (
                        <div key={d.day} className="day" title={`${d.day}: ${usd(d.usd)}`}>
                          <div style={{ height: `${Math.max(4, (d.usd / maxDay) * 100)}%` }} />
                        </div>
                      ))}
                    </div>
                    <div className="days-axis subtle"><span>{u.last30Days[0].day}</span><span>{u.last30Days[u.last30Days.length - 1].day}</span></div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
