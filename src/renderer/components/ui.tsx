import { useEffect, useRef, type ReactNode } from "react";
import type { Bucket, VacancyListItem } from "../../shared/types";
import { BUCKET_LABEL, STATE_LABEL } from "../util";

const PATHS: Record<string, string> = {
  inbox: "M3 13l2.5-7.5A2 2 0 017.4 4h9.2a2 2 0 011.9 1.5L21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5zm0 0h5l1 2h6l1-2h5",
  sources: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  profile: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3.5 3.6-6 8-6s8 2.5 8 6",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  check: "M5 12.5l4.5 4.5L19 7",
  warn: "M12 4l9 16H3L12 4zM12 10v4M12 17v.5",
  refresh: "M20 11a8 8 0 00-14.6-3.5M4 4v4h4M4 13a8 8 0 0014.6 3.5M20 20v-4h-4",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
  up: "M7 11v9H4v-9h3zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9H19a2 2 0 012 2.3l-1.2 7A2 2 0 0117.8 20H7",
  down: "M7 13V4H4v9h3zM7 13l4 8c1.5 0 2.5-1 2.5-2.5V15H19a2 2 0 002-2.3l-1.2-7A2 2 0 0017.8 4H7",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3",
  reset: "M4 12a8 8 0 108-8M4 4v5h5",
  play: "M7 5l12 7-12 7V5z",
  chevron: "M9 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18",
  key: "M14 10a4 4 0 11-3.5 6L4 22v-3H2v-2l7.5-7.5A4 4 0 0114 10z",
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

export function ScorePill({ item }: { item: Pick<VacancyListItem, "score" | "bucket" | "scoreState"> }) {
  if (item.score != null && item.bucket) {
    return (
      <span className={`pill b-${item.bucket}`} title={`Score ${item.score}, ${BUCKET_LABEL[item.bucket]}`}>
        <b>{item.score}</b>
        <span>{BUCKET_LABEL[item.bucket]}</span>
      </span>
    );
  }
  return (
    <span className={`pill s-${item.scoreState}`}>
      <span>{STATE_LABEL[item.scoreState]}</span>
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="btn icon-only ghost" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ViewHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="view-header">
      <div className="vh-title">
        <h1>{title}</h1>
        {subtitle && <span className="subtle">{subtitle}</span>}
      </div>
      <div className="vh-actions">{children}</div>
    </header>
  );
}

export function Bar({ value, tone }: { value: number; tone?: Bucket }) {
  const t = tone ?? (value >= 70 ? "strong" : value >= 50 ? "possible" : "weak");
  return (
    <div className="bar" role="presentation">
      <div className={`bar-fill b-${t}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
