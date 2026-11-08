import { call } from "../api";
import { Empty, ViewHeader } from "../components/ui";
import type { Shared } from "../App";
import { dateTime, useLoad } from "../util";

export function ActivityView({ shared }: { shared: Shared }) {
  const { data: log, reload } = useLoad(() => call("log.list", 300), [shared.tick]);
  const names = new Map(shared.sources.map((s) => [s.id, s.name]));
  return (
    <>
      <ViewHeader title="Activity" subtitle={log ? `${log.length} recent entries` : undefined}>
        <button className="btn" onClick={reload}>
          Refresh
        </button>
      </ViewHeader>
      <div className="scroll">
        {log && log.length === 0 && <Empty icon="activity" title="Nothing logged yet">Scans, errors and scoring runs show up here.</Empty>}
        {log && log.length > 0 && (
          <table className="table log">
            <thead>
              <tr>
                <th style={{ width: 128 }}>Time</th>
                <th style={{ width: 72 }}>Level</th>
                <th style={{ width: 200 }}>Source</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap subtle">{dateTime(l.at)}</td>
                  <td>
                    <span className={`level l-${l.level}`}>{l.level}</span>
                  </td>
                  <td className="ellipsis subtle">{l.sourceId != null ? (names.get(l.sourceId) ?? `#${l.sourceId}`) : "System"}</td>
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
