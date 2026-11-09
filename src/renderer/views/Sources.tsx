import { useState } from "react";
import type { Source, SourceInput } from "../../shared/types";
import { call } from "../api";
import { Empty, Icon, Switch, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { hostOf } from "../util";
import { useT } from "../i18n";
import { SourceEditor } from "./SourceEditor";

export function SourcesView({ shared }: { shared: Shared }) {
  const { t, fmt } = useT();
  const { sources, status } = shared;
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [prefill, setPrefill] = useState<Partial<SourceInput> | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  return (
    <>
      <ViewHeader title={t("nav.sources")} subtitle={t("sources.subtitle", { enabled: sources.filter((s) => s.enabled).length, total: sources.length })}>
        <button className="btn primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={14} /> {t("sources.add")}
        </button>
      </ViewHeader>
      <div className="scroll">
        {sources.length === 0 ? (
          <Empty icon="sources" title={t("sources.empty.title")} action={<button className="btn primary" onClick={() => setEditing("new")}>{t("sources.empty.action")}</button>}>
            {t("sources.empty.body")}
          </Empty>
        ) : (
          <table className="table sources">
            <thead>
              <tr>
                <th style={{ width: 52 }}>{t("sources.col.on")}</th>
                <th>{t("sources.col.source")}</th>
                <th style={{ width: 118 }}>{t("sources.col.mode")}</th>
                <th style={{ width: 120 }}>{t("sources.col.strategy")}</th>
                <th style={{ width: 112 }}>{t("sources.col.lastScan")}</th>
                <th style={{ width: 104 }}>{t("sources.col.status")}</th>
                <th style={{ width: 76, textAlign: "right" }}>{t("sources.col.found")}</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className={s.enabled ? "" : "off"}>
                  <td>
                    <Switch checked={s.enabled} label={t("sources.enable", { name: s.name })} onChange={(v) => call("sources.update", s.id, { enabled: v })} />
                  </td>
                  <td>
                    <div className="src-name">{s.name}</div>
                    <div className="src-url subtle ellipsis" title={s.url}>{hostOf(s.url)}</div>
                    {s.lastStatus === "error" && s.lastError && <div className="src-err">{s.lastError}</div>}
                  </td>
                  <td>
                    {t(`mode.${s.renderMode}`)}
                    {s.renderMode === "auto" && s.detectedMode && <span className="subtle"> → {s.detectedMode === "browser" ? t("mode.detectedBrowser") : t("mode.detectedHtml")}</span>}
                  </td>
                  <td className="subtle">{t(`strategy.${s.strategy ?? "none"}`)}</td>
                  <td className="subtle nowrap" title={s.lastScanAt ?? ""}>{fmt.relative(s.lastScanAt)}</td>
                  <td>
                    <span className={`st st-${s.lastStatus}`} title={s.lastError ?? undefined}>
                      <span className="dot" />
                      {t(`sstatus.${s.lastStatus}`)}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }} className="num">{s.lastStatus === "never" ? "–" : s.lastFound}</td>
                  <td>
                    {confirmId === s.id ? (
                      <div className="row-actions confirm">
                        <span>{t("sources.confirmDelete")}</span>
                        <button className="btn small danger" onClick={() => { setConfirmId(null); call("sources.delete", s.id); }}>{t("common.delete")}</button>
                        <button className="btn small ghost" onClick={() => setConfirmId(null)}>{t("common.cancel")}</button>
                      </div>
                    ) : (
                      <div className="row-actions">
                        <button className="btn icon-only ghost" title={t("sources.edit")} aria-label={t("sources.editAria", { name: s.name })} onClick={() => setEditing(s)}><Icon name="edit" /></button>
                        <button className="btn icon-only ghost" title={t("action.scanNow")} aria-label={t("sources.scanNowAria", { name: s.name })} disabled={status.scanning} onClick={() => call("scan.now", s.id)}><Icon name="play" /></button>
                        <button className="btn icon-only ghost" title={t("sources.resetRecipe")} aria-label={t("sources.resetRecipeAria", { name: s.name })} onClick={() => call("sources.resetRecipe", s.id)}><Icon name="reset" /></button>
                        <button className="btn icon-only ghost" title={t("common.delete")} aria-label={t("sources.deleteAria", { name: s.name })} onClick={() => setConfirmId(s.id)}><Icon name="trash" /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <SourceEditor
          // a new key remounts the editor so a pre-filled "add portal" editor replaces the one that suggested it
          key={prefill ? `prefill:${prefill.url}` : editing === "new" ? "new" : editing.id}
          source={editing === "new" ? null : editing}
          prefill={prefill ?? undefined}
          onAddPortal={(p) => { setPrefill(p); setEditing("new"); }}
          onClose={() => { setEditing(null); setPrefill(null); }}
        />
      )}
    </>
  );
}
