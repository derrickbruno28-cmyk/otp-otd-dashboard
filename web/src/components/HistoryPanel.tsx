import { useEffect, useMemo, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { fmtDateTime } from "../lib/format";
import { useData } from "../state/DataContext";
import type { Revision } from "../lib/types";
import { Drawer, EmptyState, ErrorNote, Spinner } from "./ui";

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function HistoryPanel({ loadId, open, onClose }: {
  loadId: string;
  open: boolean;
  onClose(): void;
}) {
  const { fleet } = useData();
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open || !loadId) return;
    setRevisions(null);
    setError(null);
    setPerson("");
    setExpanded({});
    const unsub = onSnapshot(
      query(collection(db, "loads", loadId, "revisions"), orderBy("at", "desc"), limit(200)),
      (snap) => {
        setRevisions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Revision) })));
        setError(null);
      },
      (e) => setError(e.message),
    );
    return unsub;
  }, [open, loadId]);

  const people = useMemo(() => {
    const names = new Set<string>();
    for (const r of revisions ?? []) names.add(r.displayName);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [revisions]);

  const shown = useMemo(
    () => (revisions ?? []).filter((r) => !person || r.displayName === person),
    [revisions, person],
  );

  return (
    <Drawer open={open} onClose={onClose} title="History">
      {error && <ErrorNote message={`Could not load history: ${error}`} />}
      {!error && revisions === null && <Spinner label="Loading history…" />}
      {!error && revisions !== null && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-ink2">
            <span className="text-xs font-mono uppercase tracking-wide text-ink3">Person</span>
            <select
              value={person}
              onChange={(e) => setPerson(e.target.value)}
              disabled={people.length === 0}
              className="flex-1 bg-surface2 border border-ruleStrong rounded px-2 py-1.5 text-sm text-ink disabled:opacity-50"
            >
              <option value="">Everyone</option>
              {people.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>

          {revisions.length === 0 && (
            <EmptyState title="No history yet" hint="Every save on this load will appear here." />
          )}
          {revisions.length > 0 && shown.length === 0 && (
            <EmptyState title="No entries for this person" hint="Clear the person filter to see all revisions." />
          )}

          <ol className="flex flex-col gap-2">
            {shown.map((r) => {
              const key = r.id ?? `${r.at}_${r.uid}`;
              const isOpen = !!expanded[key];
              return (
                <li key={key} className="bg-surface border border-rule rounded-lg px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-semibold text-ink">{r.displayName}</span>
                    <span className="text-xs font-mono text-ink3 tnum">{fmtDateTime(r.at, fleet.timeZone)}</span>
                    <span className="px-1.5 py-0.5 rounded border border-ruleStrong text-[10px] font-mono uppercase tracking-wide text-ink3">
                      {r.source}
                    </span>
                  </div>
                  <p className="text-sm text-ink2 mt-1">{r.summary}</p>
                  <button
                    type="button"
                    onClick={() => setExpanded((m) => ({ ...m, [key]: !isOpen }))}
                    aria-expanded={isOpen}
                    className="mt-1.5 text-xs font-mono text-ink3 hover:text-ink underline underline-offset-2"
                  >
                    {isOpen ? "Hide" : "Show"} {r.changes.length} {r.changes.length === 1 ? "change" : "changes"}
                  </button>
                  {isOpen && (
                    r.changes.length === 0 ? (
                      <p className="mt-2 text-xs text-ink3">No field-level changes recorded.</p>
                    ) : (
                      <div className="scroll-x mt-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-ink3 font-mono uppercase tracking-wide">
                              <th className="py-1 pr-3 font-normal">Field</th>
                              <th className="py-1 pr-3 font-normal">Before</th>
                              <th className="py-1 font-normal">After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.changes.map((c, i) => (
                              <tr key={`${c.path}_${i}`} className="border-t border-rule align-top">
                                <td className="py-1 pr-3 font-mono text-ink2 whitespace-nowrap">{c.path}</td>
                                <td className="py-1 pr-3 font-mono text-ink3 break-all">{fmtValue(c.before)}</td>
                                <td className="py-1 font-mono text-ink break-all">{fmtValue(c.after)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                  )}
                </li>
              );
            })}
          </ol>

          {revisions.length > 0 && (
            <p className="text-xs text-ink3">
              Revisions are append-only — a correction is a new revision, never a rewrite.
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
