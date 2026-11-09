import { call } from "../api";
import { Empty, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { useLoad } from "../util";
import { useT } from "../i18n";

export function ActivityView({ shared }: { shared: Shared }) {
  const { t, fmt } = useT();
  const { data: log, reload } = useLoad(() => call("log.list", 300), [shared.tick]);
  const names = new Map(shared.sources.map((s) => [s.id, s.name]));
  return (
    <>
      <ViewHeader title={t("nav.activity")} subtitle={log ? t("activity.subtitle", { count: log.length }) : undefined}>
        <button className="btn" onClick={reload}>
          {t("common.refresh")}
        </button>
      </ViewHeader>
      <div className="scroll">
        {log && log.length === 0 && <Empty icon="activity" title={t("activity.empty.title")}>{t("activity.empty.body")}</Empty>}
        {log && log.length > 0 && (
          <table className="table log">
            <thead>
              <tr>
                <th style={{ width: 128 }}>{t("activity.col.time")}</th>
                <th style={{ width: 112 }}>{t("activity.col.level")}</th>
                <th style={{ width: 200 }}>{t("activity.col.source")}</th>
                <th>{t("activity.col.message")}</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap subtle">{fmt.dateTime(l.at)}</td>
                  <td>
                    <span className={`level l-${l.level}`}>{t(`level.${l.level}`)}</span>
                  </td>
                  <td className="ellipsis subtle">{l.sourceId != null ? (names.get(l.sourceId) ?? `#${l.sourceId}`) : t("common.system")}</td>
                  <td>{l.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
