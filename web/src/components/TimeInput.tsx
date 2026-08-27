import { useEffect, useRef, useState } from "react";
import { isoToLocalInput, localInputToIso, tzAbbr } from "../lib/format";

export function TimeInput({ value, timeZone, onCommit, onCancel, autoFocus, ariaLabel }: {
  value: string | null;
  timeZone: string;
  onCommit(next: string | null): void;
  onCancel?(): void;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const original = isoToLocalInput(value, timeZone);
  const [draft, setDraft] = useState(original);
  const cancelled = useRef(false);
  useEffect(() => { setDraft(original); }, [original]);

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="datetime-local"
        value={draft}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (cancelled.current) { cancelled.current = false; return; }
          const next = e.target.value; // DOM value — never stale on the Enter-then-blur path
          if (next !== original) onCommit(next ? localInputToIso(next, timeZone) : null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur(); // blur handler commits exactly once
          } else if (e.key === "Escape") {
            // Swallow Esc so an enclosing Drawer stays open; cancel only this edit.
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            setDraft(original);
            e.currentTarget.blur();
            onCancel?.();
          }
        }}
        className="rounded border border-ruleStrong bg-surface px-1.5 py-0.5 text-sm text-ink font-mono tnum focus:outline-none focus:border-brand"
      />
      <span className="text-xs font-mono text-ink3">{tzAbbr(timeZone)}</span>
    </span>
  );
}
