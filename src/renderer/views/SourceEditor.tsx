import { useRef, useState } from "react";
import type { RenderMode, Source, SourceInput, SourceTestResult } from "../../shared/types";
import { call, errMsg } from "../api";
import { Icon, Modal, Switch } from "../components/ui";
import { hostOf, usd } from "../util";

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
      title={source ? "Edit source" : "Add source"}
      onClose={onClose}
      footer={
        <>
          <span className="foot-hint">{!result && !testErr ? "Tip: run Test before saving to check that vacancies are found." : saveErr ? <span className="err">{saveErr}</span> : ""}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canSave} onClick={save}>{source ? "Save" : "Add source"}</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span2">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VDAB: maatschappelijk werker" />
        </label>
        <label className="field span2">
          <span>Listing URL</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} />
        </label>
        <label className="field">
          <span>Render mode</span>
          <select value={renderMode} onChange={(e) => setRenderMode(e.target.value as RenderMode)}>
            <option value="auto">Auto (detect)</option>
            <option value="static">Plain HTML</option>
            <option value="browser">Browser (JavaScript sites)</option>
          </select>
        </label>
        <label className="field">
          <span>Pages to scan</span>
          <input type="number" min={1} max={5} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} />
        </label>
        <label className="field">
          <span>Scan interval (hours)</span>
          <input type="number" min={0.25} step={0.25} value={interval} onChange={(e) => setIntervalH(e.target.value)} placeholder="Use global setting" />
        </label>
        <div className="field">
          <span>Enabled</span>
          <div className="field-switch">
            <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
            <span className="subtle">{enabled ? "Scanned on schedule" : "Paused"}</span>
          </div>
        </div>
        <label className="field span2">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      <div className="test-box">
        <div className="test-head">
          <div>
            <b>Test this source</b>
            <div className="subtle">Fetches the page and shows what would be collected. Nothing is saved.</div>
          </div>
          <button className="btn" disabled={!validUrl || testing} onClick={test}>
            {testing ? <><span className="spinner" /> Testing…</> : <><Icon name="play" size={13} /> Test</>}
          </button>
        </div>
        {testErr && <div className="callout red"><Icon name="warn" /><div><b>Test failed</b><span>{testErr}</span></div></div>}
        {result && (
          <div className="test-result" ref={resultRef}>
            <div className="facts">
              <Fact label="robots.txt" value={result.robotsAllowed ? "Allowed" : "Disallowed"} tone={result.robotsAllowed ? "green" : "red"} />
              <Fact label="Mode used" value={result.modeUsed === "browser" ? "Browser" : "Plain HTML"} />
              <Fact label="Strategy" value={result.strategy ?? "none"} />
              <Fact label="Items" value={String(result.items.length)} tone={result.items.length ? "green" : "red"} />
              <Fact label="AI cost" value={usd(result.llmCostUsd)} />
            </div>
            <div className="subtle diag-line">{diagLine(result)}</div>
            {addable.length > 0 && result.diagnostics.hint && (
              <div className="callout info">
                <Icon name="info" />
                <div>
                  <b>Hosted job portal</b>
                  <span>{result.diagnostics.hint}</span>
                  {onAddPortal && addable.map((p) => (
                    <button
                      key={p.host}
                      className="btn small"
                      style={{ marginTop: 6, alignSelf: "flex-start" }}
                      onClick={() => onAddPortal({ name: `${name.trim() || hostOf(url) || p.host} (${p.name})`, url: p.rootUrl, renderMode: "auto", enabled: true })}
                    >
                      <Icon name="plus" size={13} /> Add {p.host} as a source
                    </button>
                  ))}
                </div>
              </div>
            )}
            {result.items.length === 0 && result.diagnostics.hint && addable.length === 0 && (
              <div className="callout info"><Icon name="info" /><div><b>Why nothing was found</b><span>{result.diagnostics.hint}</span></div></div>
            )}
            {result.error && result.error !== result.diagnostics.hint && <div className="callout red"><Icon name="warn" /><div><b>Problem</b><span>{result.error}</span></div></div>}
            {result.items.length > 0 && (
              <div className="preview">
                <table className="table compact">
                  <thead>
                    <tr><th>Title</th><th style={{ width: 150 }}>Employer</th><th style={{ width: 100 }}>Location</th><th style={{ width: 90 }}>Link</th></tr>
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

function diagLine(r: SourceTestResult): string {
  const d = r.diagnostics;
  const parts = [`Text ${d.visibleTextChars.toLocaleString("en-US")} chars`, `${d.linkCount.toLocaleString("en-US")} links`];
  if (d.frames.length > 0) parts.push("Frames: " + d.frames.map((f) => `${hostOf(f.url) || f.url} (${f.included ? "included" : "skipped"})`).join(", "));
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
