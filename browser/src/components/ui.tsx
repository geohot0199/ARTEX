// Tiny presentational primitives. No dependency on a design system: the whole point of
// this edition is a small, auditable bundle.

import * as React from "react";
import { X } from "lucide-react";

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className ?? ""}`}>{children}</div>;
}

export function CardHead({ title, hint, right }: { title: string; hint?: string; right?: React.ReactNode }) {
  return (
    <div className="card-head">
      <h3>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      {right && <div className="spacer" />}
      {right}
    </div>
  );
}

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export function Chip({ children, tone = "" }: { children: React.ReactNode; tone?: "" | "brand" | "ok" | "warn" | "bad" | "info" }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Banner({
  tone = "",
  children,
  onClose,
}: {
  tone?: "" | "warn" | "bad" | "ok";
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <div style={{ flex: 1 }}>{children}</div>
      {onClose && (
        <button className="btn ghost sm" onClick={onClose} aria-label="Dismiss">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Severity({ value }: { value: string }) {
  return <span className={`sev sev-${value}`}>{value}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3 style={{ fontSize: 15 }}>{title}</h3>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div style={{ color: "var(--text)", fontWeight: 550 }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function StatusDot({ state }: { state: "idle" | "running" | "paused" | "done" | "failed" | "stopped" }) {
  const cls = state === "running" ? "live" : state === "paused" ? "paused" : "";
  return <span className={`dot ${cls}`} title={state} />;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} className={`tab ${active === t.id ? "active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {typeof t.count === "number" && <span className="faint"> · {t.count}</span>}
        </button>
      ))}
    </div>
  );
}
