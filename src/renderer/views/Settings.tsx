import { useEffect, useState, type ReactNode } from "react";
import type { Effort, ModelId, OutputLanguage, Settings, UsageSummary } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { MODELS } from "../../shared/models";
import { call, errMsg } from "../api";
import { Bar, Segmented, Switch, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { useLoad } from "../util";
import { useT } from "../i18n";


const PURPOSES = ["score", "learn_recipe", "extract_listing", "profile_import"] as const;
/** List prices (USD per million tokens), shown next to the model pickers. */
const MODEL_PRICE: Record<ModelId, { in: string; out: string }> = {
  "claude-opus-5-5": { in: "$4", out: "$20" },
  "claude-sonnet-5-5": { in: "$2", out: "$10" },
  "claude-haiku-5-5": { in: "$0.10", out: "$0.50" },
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
  const { t, lang, setLang, fmt } = useT();
  const price = (m: ModelId) => t("model.price", MODEL_PRICE[m]);
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
        setKeyMsg({ tone: "ok", text: t("settings.keyStored") });
        key.reload();
      } else setKeyMsg({ tone: "err", text: r.error ?? t("settings.keyRejected") });
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
        setOrsMsg({ tone: "ok", text: t("settings.ors.stored") });
        ors.reload();
      } else setOrsMsg({ tone: "err", text: r.error ?? t("settings.keyRejected") });
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
      setRecompute({ tone: r.updated === 0 && r.failed > 0 ? "err" : "ok", text: t("settings.recompute.result", { updated: r.updated, failed: r.failed }) });
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
      <ViewHeader title={t("nav.settings")}>{err && <span className="msg err">{err}</span>}</ViewHeader>
      <div className="scroll">
        <div className="page settings-page" aria-busy={!loaded}>
          <section className="card">
            <h3>{t("settings.apiKey.title")}</h3>
            <p className="subtle">{t("settings.apiKey.body")}</p>
            {key.data?.needsReentry && !configured && <div className="msg err block" role="status">{t("settings.needsReentry")}</div>}
            {configured && !replace ? (
              <div className="key-row">
                <code className="masked">{key.data?.masked ?? "••••••••"}</code>
                <button className="btn" onClick={() => setReplace(true)}>{t("common.replace")}</button>
                <button className="btn danger-text" onClick={async () => { await call("apiKey.clear"); setKeyMsg(null); key.reload(); }}>{t("common.clear")}</button>
              </div>
            ) : (
              <form className="key-row" onSubmit={(e) => { e.preventDefault(); if (keyInput.trim()) void saveKey(); }}>
                <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} aria-label={t("settings.apiKey.aria")} />
                <button className="btn primary" type="submit" disabled={keyBusy || !keyInput.trim()}>{keyBusy ? t("common.checking") : t("common.save")}</button>
                {replace && <button className="btn ghost" type="button" onClick={() => { setReplace(false); setKeyInput(""); }}>{t("common.cancel")}</button>}
              </form>
            )}
            {keyMsg && <div className={`msg ${keyMsg.tone} block`} role="status">{keyMsg.text}</div>}
          </section>

          <section className="card">
            <h3>{t("settings.ors.title")}</h3>
            <p className="subtle">{t("settings.ors.body")}</p>
            {ors.data?.needsReentry && !orsConfigured && <div className="msg err block" role="status">{t("settings.needsReentry")}</div>}
            {orsConfigured && !orsReplace ? (
              <div className="key-row">
                <code className="masked">{ors.data?.masked ?? "••••••••"}</code>
                <button className="btn" onClick={() => setOrsReplace(true)}>{t("common.replace")}</button>
                <button className="btn danger-text" onClick={async () => { await call("orsKey.clear"); setOrsMsg(null); setRecompute(null); ors.reload(); }}>{t("common.clear")}</button>
              </div>
            ) : (
              <form className="key-row" onSubmit={(e) => { e.preventDefault(); if (orsInput.trim()) void saveOrsKey(); }}>
                <input type="password" autoComplete="off" spellCheck={false} placeholder={t("settings.ors.placeholder")} value={orsInput} onChange={(e) => setOrsInput(e.target.value)} aria-label={t("settings.ors.placeholder")} />
                <button className="btn primary" type="submit" disabled={orsBusy || !orsInput.trim()}>{orsBusy ? t("common.checking") : t("common.save")}</button>
                {orsReplace && <button className="btn ghost" type="button" onClick={() => { setOrsReplace(false); setOrsInput(""); }}>{t("common.cancel")}</button>}
              </form>
            )}
            {orsMsg && <div className={`msg ${orsMsg.tone} block`} role="status">{orsMsg.text}</div>}
            <Row label={t("settings.recompute.label")} hint={t("settings.recompute.hint")}>
              <span className="recompute">
                {recompute && <span className={`msg ${recompute.tone}`} role="status">{recompute.text}</span>}
                <button className="btn" disabled={recomputing || !orsConfigured} onClick={runRecompute}>{recomputing ? t("settings.recompute.busy") : t("settings.recompute.button")}</button>
              </span>
            </Row>
          </section>

          <section className="card">
            <h3>{t("settings.models.title")}</h3>
            <Row label={t("settings.scoringModel")} hint={price(s.scoringModel)}>
              <select value={s.scoringModel} aria-label={t("settings.scoringModel")} onChange={(e) => patch({ scoringModel: e.target.value as ModelId })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {t(`model.note.${m.id}`)}</option>)}
              </select>
            </Row>
            <Row label={t("settings.utilityModel")} hint={t("settings.utilityHint", { price: price(s.utilityModel) })}>
              <select value={s.utilityModel} aria-label={t("settings.utilityModel")} onChange={(e) => patch({ utilityModel: e.target.value as ModelId })}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} · {t(`model.note.${m.id}`)}</option>)}
              </select>
            </Row>
            <Row label={t("settings.effort")} hint={t("settings.effortHint")}>
              <Segmented<Effort> label={t("settings.effortAria")} value={s.effort} onChange={(v) => patch({ effort: v })} options={[{ id: "low", label: t("effort.low") }, { id: "medium", label: t("effort.medium") }, { id: "high", label: t("effort.high") }]} />
            </Row>
            <Row label={t("lang.switch")} hint={t("settings.language.hint")}>
              <Segmented<OutputLanguage> label={t("lang.label")} value={lang} onChange={(v) => { setLang(v); setS((cur) => ({ ...cur, outputLanguage: v })); }} options={[{ id: "en", label: t("lang.en") }, { id: "nl", label: t("lang.nl") }]} />
            </Row>
          </section>

          <section className="card">
            <h3>{t("settings.scanning.title")}</h3>
            <Row label={t("settings.interval")} hint={t("settings.intervalHint")}>
              <NumberField label={t("settings.intervalAria")} value={s.scanIntervalHours} min={0.25} step={0.25} suffix={t("common.hoursUnit")} onCommit={(n) => patch({ scanIntervalHours: n })} />
            </Row>
            <Row label={t("settings.maxNew")} hint={t("settings.maxNewHint")}>
              <NumberField label={t("settings.maxNewAria")} value={s.maxNewScoredPerScan} min={1} max={200} onCommit={(n) => patch({ maxNewScoredPerScan: n })} />
            </Row>
            <Row label={t("settings.closeAfter")} hint={t("settings.closeAfterHint")}>
              <NumberField label={t("settings.closeAfter")} value={s.closeAfterMissedScans} min={1} max={20} onCommit={(n) => patch({ closeAfterMissedScans: n })} />
            </Row>
            <Row label={t("settings.launch")}>
              <Switch label={t("settings.launch")} checked={s.launchAtLogin} onChange={(v) => patch({ launchAtLogin: v })} />
            </Row>
          </section>

          <section className="card">
            <h3>{t("settings.notifications.title")}</h3>
            <Row label={t("settings.notify")}>
              <Switch label={t("settings.notifyAria")} checked={s.notificationsEnabled} onChange={(v) => patch({ notificationsEnabled: v })} />
            </Row>
            <Row label={t("settings.threshold")} hint={t("settings.thresholdHint")}>
              <NumberField label={t("settings.thresholdAria")} value={s.notifyThreshold} min={0} max={100} step={5} onCommit={(n) => patch({ notifyThreshold: n })} />
            </Row>
          </section>

          <section className="card">
            <h3>{t("settings.usage.title")}</h3>
            <Row label={t("settings.budget")} hint={t("settings.budgetHint")}>
              <NumberField label={t("settings.budgetAria")} value={s.monthlyBudgetUsd} min={0} step={1} suffix="USD" onCommit={(n) => patch({ monthlyBudgetUsd: n })} />
            </Row>
            {u && (
              <div className="usage">
                <div className="usage-head">
                  <div><b className="usage-big">{fmt.usd(u.monthUsd)}</b> <span className="subtle">{t("settings.usage.of", { budget: fmt.usd(u.budgetUsd) })}</span></div>
                  {u.budgetExceeded && <span className="level l-error">{t("status.budgetShort")}</span>}
                </div>
                <Bar value={pct} tone={u.budgetExceeded ? "knockout" : pct > 80 ? "possible" : "strong"} />
                <p className="cache-line subtle">
                  {u.byPurpose.length === 0
                    ? t("settings.usage.cacheNone")
                    : t(u.cache.savedUsd < 0 ? "settings.usage.cacheCost" : "settings.usage.cache", {
                        share: fmt.percent(u.cache.hitShare),
                        amount: fmt.usd(Math.abs(u.cache.savedUsd)),
                      })}
                </p>
                {u.byPurpose.length > 0 && (
                  <table className="table compact purposes">
                    <tbody>
                      {u.byPurpose.map((p) => (
                        <tr key={p.purpose}>
                          <td>{(PURPOSES as readonly string[]).includes(p.purpose) ? t(`purpose.${p.purpose as (typeof PURPOSES)[number]}`) : p.purpose}</td>
                          <td className="subtle num">{t("settings.usage.calls", { count: p.calls })}</td>
                          <td className="num" style={{ width: 80 }}>{fmt.usd(p.usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {u.last30Days.length > 0 && (
                  <div className="days" aria-label={t("settings.usage.daysAria")}>
                    <div className="days-bars">
                      {u.last30Days.map((d) => (
                        <div key={d.day} className="day" title={`${d.day}: ${fmt.usd(d.usd)}`}>
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
