import { useEffect } from "react";
import type { ReactNode } from "react";
import type { OnTimeStatus } from "../lib/types";
import { fmtVariance } from "../lib/format";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 text-sm text-ink3" role="status">
      <span className="inline-block h-4 w-4 rounded-full border-2 border-ruleStrong border-t-brand animate-spin" aria-hidden="true" />
      <span>{label ?? "Loading…"}</span>
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="bg-lateSoft border border-late/40 rounded-lg px-3 py-2 my-2 text-sm text-late" role="alert">
      {message}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="bg-surface border border-rule rounded-lg px-4 py-10 text-center">
      <p className="font-display font-semibold text-ink2">{title}</p>
      {hint && <p className="text-sm text-ink3 mt-1">{hint}</p>}
    </div>
  );
}

export function Chip({ active, onClick, children, title }: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-mono border whitespace-nowrap ${
        active ? "bg-brand text-brandInk border-brand" : "border-ruleStrong text-ink2 hover:bg-surface2"
      }`}
    >
      {children}
    </button>
  );
}

const STATUS_CLASS: Record<OnTimeStatus, string> = {
  ON_TIME: "bg-ontimeSoft text-ontime",
  LATE: "bg-lateSoft text-late",
  EARLY: "bg-surface2 text-ink2",
  PENDING: "bg-pendingSoft text-pending",
};
const STATUS_LABEL: Record<OnTimeStatus, string> = {
  ON_TIME: "ON TIME",
  LATE: "LATE",
  EARLY: "EARLY",
  PENDING: "PENDING",
};

export function StatusChip({ status, varianceMin }: { status: OnTimeStatus; varianceMin?: number | null }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-mono whitespace-nowrap ${STATUS_CLASS[status]}`}>
      {STATUS_LABEL[status]}
      {varianceMin !== null && varianceMin !== undefined && (
        <span className="tnum">{fmtVariance(varianceMin)}</span>
      )}
    </span>
  );
}

export function GhostChip() {
  return (
    <span
      title="USPS protocol: hourly customer updates until delivered"
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono border border-brand text-brand whitespace-nowrap"
    >
      GHOST SHUTDOWN
    </span>
  );
}

export function Drawer({ open, onClose, title, width = "min(560px,100vw)", children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  width?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={`absolute inset-y-0 right-0 flex flex-col bg-surface border-l border-rule shadow-2xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ width }}
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-rule shrink-0">
          <h2 className="font-display font-semibold text-lg">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="px-2 py-0.5 rounded text-ink2 hover:bg-surface2"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-surface border border-rule rounded-lg shadow-2xl p-4"
      >
        <h2 className="font-display font-semibold text-lg mb-2">{title}</h2>
        <div className="text-sm text-ink2 mb-4">{body}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              danger
                ? "px-3 py-1.5 rounded text-sm font-semibold text-late border border-late/40 hover:bg-lateSoft"
                : "px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="block">
      <span className="block text-xs font-mono uppercase tracking-wide text-ink3 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink3 mt-1">{hint}</span>}
    </div>
  );
}

export function Section({ title, right, children }: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="bg-surface border border-rule rounded-lg">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-rule">
        <h3 className="font-display font-semibold">{title}</h3>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
