import { useEffect, useMemo, useRef, useState } from "react";
import { nowIso } from "../lib/format";
import type { FailReason, ReasonEntry } from "../lib/types";
import { useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";

const CASCADE_CODE = "driver-late-pickup-cascaded-to-delivery";

/** Local draft so a keystroke never triggers a parent onChange (which may write Firestore). */
function NoteInput({ value, disabled, onCommit }: {
  value: string; disabled?: boolean; onCommit(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <input
      type="text"
      value={draft}
      disabled={disabled}
      placeholder="note"
      aria-label="Reason note"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        if (cancelled.current) { cancelled.current = false; return; }
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      className="w-28 min-w-0 rounded border border-rule bg-surface px-1.5 py-0.5 text-xs text-ink placeholder:text-ink3 focus:outline-none focus:border-brand disabled:opacity-50"
    />
  );
}

export function ReasonPicker({ metric, entries, onChange, disabled, suggestCascade }: {
  metric: "OTP" | "OTD";
  entries: ReasonEntry[];
  onChange(next: ReasonEntry[]): void;
  disabled?: boolean;
  suggestCascade?: boolean;
}) {
  const { reasons, reasonsById } = useData();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // Fixed-position anchor: the panel renders position:fixed so the loads table's
  // overflow container can't clip it.
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    // A fixed panel would drift from its trigger on scroll — close instead.
    const onScroll = (e: Event) => {
      if (boxRef.current && e.target instanceof Node && boxRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const applicable = useMemo(
    () => reasons.filter((r) => r.active && (r.appliesTo === metric || r.appliesTo === "BOTH")),
    [reasons, metric],
  );
  const needle = q.trim().toLowerCase();
  const visible = needle
    ? applicable.filter((r) =>
        r.label.toLowerCase().includes(needle) || r.category.toLowerCase().includes(needle))
    : applicable;

  const suggested = suggestCascade && metric === "OTD"
    ? visible.find((r) => r.id === CASCADE_CODE) ?? null
    : null;
  const groups: { category: string; items: FailReason[] }[] = [];
  for (const r of visible) {
    if (suggested && r.id === suggested.id) continue;
    const g = groups.find((x) => x.category === r.category);
    if (g) g.items.push(r);
    else groups.push({ category: r.category, items: [r] });
  }

  const selected = new Set(entries.map((e) => e.reasonCode));
  const toggle = (code: string) => {
    if (selected.has(code)) onChange(entries.filter((e) => e.reasonCode !== code));
    else onChange([...entries, {
      reasonCode: code,
      note: "",
      enteredBy: profile?.id ?? "",
      enteredByName: profile?.displayName ?? "",
      enteredAt: nowIso(),
    }]);
  };

  const row = (r: FailReason, tag?: string) => {
    const on = selected.has(r.id!);
    return (
      <button
        key={r.id}
        type="button"
        onClick={() => toggle(r.id!)}
        className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-surface2 ${on ? "bg-surface2" : ""}`}
      >
        <span className={`w-3 shrink-0 ${on ? "text-ontime" : "text-ink3"}`}>{on ? "✓" : ""}</span>
        <span className={`flex-1 ${r.category === "DRIVER" ? "text-catDriver" : "text-ink"}`}>{r.label}</span>
        {tag && (
          <span className="shrink-0 rounded border border-ruleStrong px-1 font-mono text-[10px] uppercase text-ink2">
            {tag}
          </span>
        )}
      </button>
    );
  };

  return (
    <div ref={boxRef} className="relative inline-block max-w-full align-top">
      <div className="flex flex-wrap items-center gap-1.5">
        {entries.map((e) => {
          const r = reasonsById[e.reasonCode];
          const driver = r?.category === "DRIVER";
          return (
            <span
              key={e.reasonCode}
              className={`inline-flex items-center gap-1.5 rounded-full border bg-surface2 py-0.5 pl-2.5 pr-1 text-xs ${driver ? "border-catDriver/40" : "border-rule"}`}
            >
              <span className={driver ? "text-catDriver" : "text-ink"}>{r?.label ?? e.reasonCode}</span>
              <NoteInput
                value={e.note}
                disabled={disabled}
                onCommit={(note) =>
                  onChange(entries.map((x) => (x.reasonCode === e.reasonCode ? { ...x, note } : x)))}
              />
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${r?.label ?? e.reasonCode}`}
                onClick={() => toggle(e.reasonCode)}
                className="rounded-full px-1 text-ink3 hover:bg-surface hover:text-late disabled:opacity-50"
              >
                ×
              </button>
            </span>
          );
        })}
        <button
          type="button"
          disabled={disabled}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor({
              top: Math.min(r.bottom + 4, window.innerHeight - 340),
              left: Math.min(r.left, window.innerWidth - 336),
            });
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          className="rounded-full border border-ruleStrong px-2.5 py-1 font-mono text-xs text-ink2 hover:bg-surface2 disabled:opacity-50"
        >
          + {metric} reason
        </button>
      </div>
      {open && !disabled && (
        <div
          style={{ position: "fixed", top: anchor.top, left: anchor.left }}
          className="z-50 w-80 max-w-[90vw] rounded-lg border border-ruleStrong bg-surface p-2 shadow-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
          }}
        >
          <input
            type="text"
            value={q}
            autoFocus
            placeholder="Search reasons…"
            aria-label="Search reasons"
            onChange={(e) => setQ(e.target.value)}
            className="mb-2 w-full rounded border border-rule bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink3 focus:outline-none focus:border-brand"
          />
          <div className="max-h-72 overflow-y-auto">
            {suggested && <div className="mb-1 border-b border-rule pb-1">{row(suggested, "suggested")}</div>}
            {groups.map((g) => (
              <div key={g.category} className="mb-1">
                <div className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${g.category === "DRIVER" ? "text-catDriver" : "text-ink3"}`}>
                  {g.category}
                </div>
                {g.items.map((r) => row(r))}
              </div>
            ))}
            {!suggested && groups.length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-ink3">No matching reasons</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
