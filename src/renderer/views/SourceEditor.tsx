import { useRef, useState } from "react";
import type { RenderMode, Source, SourceInput, SourceTestResult } from "../../shared/types";
import { call, errMsg } from "../api";
import { Icon, Modal, Switch } from "../components/ui";
import { hostOf } from "../util";
import { useT } from "../i18n";
import type { Translator } from "../../shared/i18n";

export function SourceEditor({
  source,
  prefill,
  onAddPortal,
  onClose,
}: {
  source: Source | null;
  /** Initial values for a new source (ignored when editing an existing one). */
  prefill?: Partial<SourceInput>;
  /** Asks the parent to open a new editor pre-filled with a suggested portal source. */
  onAddPortal?: (p: Partial<SourceInput>) => void;
  onClose: () => void;
}) {
  const { t, fmt } = useT();
  const [name, setName] = useState(source?.name ?? prefill?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? prefill?.url ?? "");
  const [renderMode, setRenderMode] = useState<RenderMode>(source?.renderMode ?? prefill?.renderMode ?? "auto");
  const [maxPages, setMaxPages] = useState(String(source?.maxPages ?? prefill?.maxPages ?? 1));
  const [interval, setIntervalH] = useState(source?.scanIntervalHours != null ? String(source.scanIntervalHours) : "");
  const [notes, setNotes] = useState(source?.notes ?? prefill?.notes ?? "");
  const [enabled, setEnabled] = useState(source?.enabled ?? prefill?.enabled ?? true);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SourceTestResult | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const addable = result?.diagnostics.portals.filter((p) => p.companySpecific && p.kind !== "script") ?? [];
  const pages = Math.min(5, Math.max(1, Math.round(Number(maxPages) || 1)));
  const validUrl = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const canSave = name.trim() !== "" && validUrl && !saving;

  const test = async () => {
    setTesting(true);
    setResult(null);
    setTestErr(null);
    try {
      setResult(await call("sources.test", { url: url.trim(), renderMode, maxPages: pages, sourceId: source?.id }));
    } catch (e) {
      setTestErr(errMsg(e));
    } finally {
      setTesting(false);
      setTimeout(() => resultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    const iv = interval.trim() === "" ? null : Math.max(0.25, Number(interval) || 0);
    const input: SourceInput = { name: name.trim(), url: url.trim(), enabled, renderMode, scanIntervalHours: iv, maxPages: pages, notes };
    try {
      if (source) await call("sources.update", source.id, input);
      else await call("sources.create", input);
      onClose();
    } catch (e) {
      setSaveErr(errMsg(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={source ? t("editor.titleEdit") : t("editor.titleAdd")}
      onClose={onClose}
      footer={
        <>
          <span className="foot-hint">{!result && !testErr ? t("editor.tip") : saveErr ? <span className="err">{saveErr}</span> : ""}</span>
          <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={!canSave} onClick={save}>{source ? t("common.save") : t("sources.add")}</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span2">
          <span>{t("editor.name")}</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("editor.namePlaceholder")} />
        </label>
        <label className="field span2">
          <span>{t("editor.url")}</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
        </label>
        <label className="field">
          <span>{t("editor.renderMode")}</span>
          <select value={renderMode} onChange={(e) => setRenderMode(e.target.value as RenderMode)}>
            <option value="auto">{t("mode.autoDetect")}</option>
            <option value="static">{t("mode.static")}</option>
            <option value="browser">{t("mode.browserJs")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("editor.pages")}</span>
          <input type="number" min={1} max={5} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("editor.interval")}</span>
          <input type="number" min={0.25} step={0.25} value={interval} onChange={(e) => setIntervalH(e.target.value)} placeholder={t("editor.intervalPlaceholder")} />
        </label>
        <div className="field">
          <span>{t("editor.enabled")}</span>
          <div className="field-switch">
            <Switch checked={enabled} onChange={setEnabled} label={t("editor.enabled")} />
            <span className="subtle">{enabled ? t("editor.onSchedule") : t("editor.paused")}</span>
          </div>
        </div>
        <label className="field span2">
          <span>{t("editor.notes")}</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      <div className="test-box">
        <div className="test-head">
          <div>
            <b>{t("editor.testTitle")}</b>
            <div className="subtle">{t("editor.testBody")}</div>
          </div>
          <button className="btn" disabled={!validUrl || testing} onClick={test}>
            {testing ? <><span className="spinner" /> {t("editor.testing")}</> : <><Icon name="play" size={13} /> {t("common.test")}</>}
          </button>
        </div>
        {testErr && <div className="callout red"><Icon name="warn" /><div><b>{t("editor.testFailed")}</b><span>{testErr}</span></div></div>}
        {result && (
          <div className="test-result" ref={resultRef}>
            <div className="facts">
              <Fact label={t("editor.fact.robots")} value={result.robotsAllowed ? t("editor.fact.allowed") : t("editor.fact.disallowed")} tone={result.robotsAllowed ? "green" : "red"} />
              <Fact label={t("editor.fact.modeUsed")} value={result.modeUsed === "browser" ? t("mode.browser") : t("mode.static")} />
              <Fact label={t("editor.fact.strategy")} value={t(`strategy.${result.strategy ?? "none"}`)} />
              <Fact label={t("editor.fact.items")} value={String(result.items.length)} tone={result.items.length ? "green" : "red"} />
              <Fact label={t("editor.fact.aiCost")} value={fmt.usd(result.llmCostUsd)} />
            </div>
            <div className="subtle diag-line">{diagLine(result, t, fmt.number)}</div>
            {addable.length > 0 && result.diagnostics.hint && (
              <div className="callout info">
                <Icon name="info" />
                <div>
                  <b>{t("editor.portal.title")}</b>
                  <span>{result.diagnostics.hint}</span>
                  {onAddPortal && addable.map((p) => (
                    <button
                      key={p.host}
                      className="btn small"
                      style={{ marginTop: 6, alignSelf: "flex-start" }}
                      onClick={() => onAddPortal({ name: `${name.trim() || hostOf(url) || p.host} (${p.name})`, url: p.rootUrl, renderMode: "auto", enabled: true })}
                    >
                      <Icon name="plus" size={13} /> {t("editor.portal.add", { host: p.host })}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {result.items.length === 0 && result.diagnostics.hint && addable.length === 0 && (
              <div className="callout info"><Icon name="info" /><div><b>{t("editor.whyNothing")}</b><span>{result.diagnostics.hint}</span></div></div>
            )}
            {result.error && result.error !== result.diagnostics.hint && <div className="callout red"><Icon name="warn" /><div><b>{t("editor.problem")}</b><span>{result.error}</span></div></div>}
            {result.items.length > 0 && (
              <div className="preview">
                <table className="table compact">
                  <thead>
                    <tr><th>{t("editor.col.title")}</th><th style={{ width: 150 }}>{t("editor.col.employer")}</th><th style={{ width: 110 }}>{t("editor.col.location")}</th><th style={{ width: 90 }}>{t("editor.col.link")}</th></tr>
                  </thead>
                  <tbody>
                    {result.items.map((it, i) => (
                      <tr key={i}>
                        <td>{it.title}</td>
                        <td className="subtle">{it.organization || "–"}</td>
                        <td className="subtle">{it.location || "–"}</td>
                        <td className="subtle ellipsis" title={it.url}>{hostOf(it.url)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function diagLine(r: SourceTestResult, t: Translator, num: (n: number) => string): string {
  const d = r.diagnostics;
  const parts = [t("editor.diag.text", { n: num(d.visibleTextChars) }), t("editor.diag.links", { n: num(d.linkCount) })];
  if (d.frames.length > 0) parts.push(t("editor.diag.frames", { list: d.frames.map((f) => `${hostOf(f.url) || f.url} (${f.included ? t("editor.diag.included") : t("editor.diag.skipped")})`).join(", ") }));
  return parts.join(" · ");
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div className="fact">
      <span className="subtle">{label}</span>
      <b className={tone ? `tone-${tone}` : ""}>{value}</b>
    </div>
  );
}
