import { useState } from "react";
import type { Source } from "../../shared/types";
import { call } from "../api";
import { Empty, Icon, Switch, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { hostOf, relativeTime } from "../util";
import { SourceEditor } from "./SourceEditor";

const MODE_LABEL = { auto: "Auto", static: "Plain HTML", browser: "Browser" } as const;
const STATUS_LABEL = { ok: "OK", empty: "Empty", error: "Error", never: "Not scanned" } as const;

export function SourcesView({ shared }: { shared: Shared }) {
  const { sources, status } = shared;
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  return (
    <>
      <ViewHeader title="Sources" subtitle={`${sources.filter((s) => s.enabled).length} of ${sources.length} enabled`}>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={14} /> Add source
        </button>
      </ViewHeader>
      <div className="scroll">
        {sources.length === 0 ? (
          <Empty icon="sources" title="No sources yet" action={<button className="btn primary" onClick={() => setEditing("new")}>Add a source</button>}>
            A source is a job listing page. Vacature Radar checks it regularly and collects new vacancies.
          </Empty>
        ) : (
          <table className="table sources">
            <thead>
              <tr>
                <th style={{ width: 52 }}>On</th>
                <th>Source</th>
                <th style={{ width: 120 }}>Mode</th>
                <th style={{ width: 84 }}>Strategy</th>
                <th style={{ width: 104 }}>Last scan</th>
                <th style={{ width: 112 }}>Status</th>
                <th style={{ width: 56, textAlign: "right" }}>Found</th>
                <th style={{ width: 176 }} />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={s.enabled ? "" : "off"}>
                  <td>
                    <Switch checked={s.enabled} label={`Enable ${s.name}`} onChange={(v) => call("sources.update", s.id, { enabled: v })} />
                  </td>
                  <td>
                    <div className="src-name">{s.name}</div>
                    <div className="src-url subtle ellipsis" title={s.url}>{hostOf(s.url)}</div>
                    {s.lastStatus === "error" && s.lastError && <div className="src-err">{s.lastError}</div>}
                  </td>
                  <td>
                    {MODE_LABEL[s.renderMode]}
                    {s.renderMode === "auto" && s.detectedMode && <span className="subtle"> → {s.detectedMode === "browser" ? "browser" : "HTML"}</span>}
                  </td>
                  <td className="subtle">{s.strategy ?? "none"}</td>
                  <td className="subtle nowrap" title={s.lastScanAt ?? ""}>{relativeTime(s.lastScanAt)}</td>
                  <td>
                    <span className={`st st-${s.lastStatus}`} title={s.lastError ?? undefined}>
                      <span className="dot" />
                      {STATUS_LABEL[s.lastStatus]}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }} className="num">{s.lastStatus === "never" ? "–" : s.lastFound}</td>
                  <td>
                    {confirmId === s.id ? (
                      <div className="row-actions confirm">
                        <span>Delete with its vacancies?</span>
                        <button className="btn small danger" onClick={() => { setConfirmId(null); call("sources.delete", s.id); }}>Delete</button>
                        <button className="btn small ghost" onClick={() => setConfirmId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="row-actions">
                        <button className="btn icon-only ghost" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}><Icon name="edit" /></button>
                        <button className="btn icon-only ghost" title="Scan now" aria-label={`Scan ${s.name} now`} disabled={status.scanning} onClick={() => call("scan.now", s.id)}><Icon name="play" /></button>
                        <button className="btn icon-only ghost" title="Reset recipe: relearn selectors on next scan" aria-label={`Reset recipe for ${s.name}`} onClick={() => call("sources.resetRecipe", s.id)}><Icon name="reset" /></button>
                        <button className="btn icon-only ghost" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => setConfirmId(s.id)}><Icon name="trash" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <SourceEditor source={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
