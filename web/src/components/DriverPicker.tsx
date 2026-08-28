import { useMemo, useRef, useState } from "react";
import { addDoc, collection } from "firebase/firestore";
import { db } from "../lib/firebase";
import { useData } from "../state/DataContext";
import { useToast } from "./Toast";
import type { OperatingCompany } from "../lib/types";

/**
 * Type-ahead driver field: filters the roster as you type, and offers
 * "+ Add «name»" when no driver matches — creating the drivers doc on the spot
 * (ops+ by rules), so a new hire never blocks keying a load. Fixed-position
 * dropdown so table/drawer overflow can't clip it.
 */
export function DriverPicker({ label, value, name, company, onChange, disabled }: {
  label: string;
  value: string | null;                 // driver id
  name: string;                         // denormalized display name
  company: OperatingCompany;            // default company for a newly added driver
  onChange(next: { id: string | null; name: string }): void;
  disabled?: boolean;
}) {
  const { drivers } = useData();
  const toast = useToast();
  const [text, setText] = useState<string | null>(null);   // null = not editing
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 280 });
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = text ?? name;
  const q = (text ?? "").trim().toLowerCase();
  const matches = useMemo(
    () => drivers
      .filter((d) => d.active !== false)
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .slice(0, 8),
    [drivers, q],
  );
  const exact = drivers.some((d) => d.name.toLowerCase() === q);

  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAnchor({
      top: Math.min(r.bottom + 4, window.innerHeight - 280),
      left: Math.min(r.left, window.innerWidth - 300),
      width: Math.max(r.width, 280),
    });
    setOpen(true);
  };
  const pick = (id: string | null, pickedName: string) => {
    onChange({ id, name: pickedName });
    setText(null);
    setOpen(false);
  };
  const addNew = async () => {
    const newName = (text ?? "").trim();
    if (!newName || busy) return;
    setBusy(true);
    try {
      const ref = await addDoc(collection(db, "drivers"), {
        name: newName, operatingCompany: company, active: true,
        reviewState: "NONE", reviewedBy: null, reviewedByName: null,
        reviewedAt: null, reviewNotes: "",
      });
      pick(ref.id, newName);
      toast.push("ok", `Driver "${newName}" added (${company})`);
    } catch (e) {
      toast.push("error", `Add driver failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <span className="block text-xs font-mono uppercase tracking-wider text-ink3 mb-1">{label}</span>
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={shown}
          placeholder="Type a driver name…"
          className="w-full rounded border border-rule bg-surface2 px-2 py-1 text-sm text-ink"
          onFocus={(e) => { setText(name); openAt(e.currentTarget); }}
          onChange={(e) => { setText(e.target.value); openAt(e.currentTarget); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (matches.length === 1) pick(matches[0].id!, matches[0].name);
              else if (!exact && q) void addNew();
            } else if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation();
              setText(null); setOpen(false); e.currentTarget.blur();
            }
          }}
          onBlur={() => setTimeout(() => { setOpen(false); setText(null); }, 150)}
        />
        {value && !disabled && (
          <button type="button" aria-label={`Clear ${label}`} title="Clear"
            className="px-1.5 text-ink3 hover:text-late"
            onClick={() => pick(null, "")}>×</button>
        )}
      </div>
      {open && !disabled && (
        <div
          style={{ position: "fixed", top: anchor.top, left: anchor.left, width: anchor.width }}
          className="z-50 max-h-64 overflow-y-auto rounded-lg border border-ruleStrong bg-surface p-1 shadow-xl"
        >
          {matches.map((d) => (
            <button key={d.id} type="button"
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-surface2"
              onMouseDown={(e) => { e.preventDefault(); pick(d.id!, d.name); }}>
              <span>{d.name}</span>
              <span className="font-mono text-xs text-ink3">{d.operatingCompany}</span>
            </button>
          ))}
          {q && !exact && (
            <button type="button" disabled={busy}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-brand hover:bg-surface2 disabled:opacity-50"
              onMouseDown={(e) => { e.preventDefault(); void addNew(); }}>
              + Add “{(text ?? "").trim()}” as a new {company} driver
            </button>
          )}
          {!matches.length && !q && (
            <div className="px-2 py-1.5 text-sm text-ink3">Type to search or add a driver</div>
          )}
        </div>
      )}
    </div>
  );
}
