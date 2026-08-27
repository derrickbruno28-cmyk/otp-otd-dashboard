import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection, doc, limit, onSnapshot, orderBy, query, setDoc, updateDoc,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { fmtDateTime, nowIso } from "../lib/format";
import { createLoad, deleteLoad, updateLoad } from "../lib/loads";
import type { Signer } from "../lib/loads";
import { autoMap, parseWorkbook, rowsToLoads, TARGET_FIELDS } from "../lib/xlsxImport";
import type { TargetField } from "../lib/xlsxImport";
import type { ImportBatch, Load, Stop } from "../lib/types";
import { atLeast, useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { useToast } from "./Toast";
import { ConfirmDialog, EmptyState, ErrorNote, Spinner } from "./ui";

type Step = "pick" | "map" | "preview" | "committing" | "done";
const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "pick", label: "File" }, { id: "map", label: "Map" },
  { id: "preview", label: "Preview" }, { id: "committing", label: "Commit" },
];
const stepIndex = (s: Step) => (s === "done" ? 3 : STEP_LABELS.findIndex((x) => x.id === s));

const keyOf = (customerId: string, loadNumber: string) =>
  `${customerId}::${loadNumber.trim().toUpperCase()}`;

const nonEmpty = (v: unknown) => v !== null && v !== undefined && v !== "";

/** Merge non-empty imported fields over an existing load; returns the patch + pre-image for undo. */
function buildUpdatePatch(
  imp: Load, cur: Load, batchId: string, mapping: Record<string, string | null>,
): { patch: Partial<Load>; previous: Record<string, unknown> } {
  const patch: Partial<Load> = {};
  const previous: Record<string, unknown> = {};
  const put = <K extends keyof Load>(key: K, value: Load[K]) => {
    if (!nonEmpty(value) || value === cur[key]) return;
    patch[key] = value;
    previous[key as string] = cur[key] ?? null;
  };
  // lsNumber is synthesized (= loadNumber) when the LS # column is absent, and it is
  // the identifier every report quotes — patch it ONLY when the file truly carried it.
  if (mapping.lsNumber) put("lsNumber", imp.lsNumber);
  put("referenceNumber", imp.referenceNumber);
  put("equipmentType", imp.equipmentType);
  // status/opco are defaulted by rowsToLoads — only merge when the column was actually mapped
  if (mapping.status) put("status", imp.status);
  if (mapping.operatingCompany) put("operatingCompany", imp.operatingCompany);
  put("pieces", imp.pieces);
  put("weightLbs", imp.weightLbs);
  put("billingMiles", imp.billingMiles);
  put("commodity", imp.commodity);
  put("truckNumber", imp.truckNumber);
  put("primaryDriverName", imp.primaryDriverName);
  put("secondaryDriverName", imp.secondaryDriverName);

  const stops = cur.stops.map((s) => ({ ...s }));
  let stopsChanged = false;
  const mergeStop = (dst: Stop | undefined, src: Stop | undefined) => {
    if (!dst || !src) return;
    const keys: (keyof Stop)[] = ["locationName", "address", "city", "zip", "appt", "actualArrival", "actualDeparture"];
    // timeZone is derived from state on import, but a person may have deliberately
    // overridden the zone (split-zone states) — only reset it when the state changed.
    if (nonEmpty(src.state) && src.state !== dst.state) keys.push("state", "timeZone");
    for (const k of keys) {
      const v = src[k];
      if (nonEmpty(v) && v !== dst[k]) {
        (dst as unknown as Record<string, unknown>)[k] = v;
        stopsChanged = true;
      }
    }
  };
  mergeStop(stops.find((s) => s.type === "PICKUP"), imp.stops.find((s) => s.type === "PICKUP"));
  mergeStop([...stops].reverse().find((s) => s.type === "DELIVERY"), imp.stops.find((s) => s.type === "DELIVERY"));
  if (stopsChanged) { patch.stops = stops; previous.stops = cur.stops; }
  if (Object.keys(patch).length) { patch.batchId = batchId; previous.batchId = cur.batchId ?? null; }
  return { patch, previous };
}

interface CommitResult { created: number; updated: number; skipped: number; problems: string[]; }
type BatchWithId = ImportBatch & { id: string };

export function ImportModal({ open, onClose, existing }: {
  open: boolean; onClose(): void; existing: Load[];
}) {
  const { profile, role } = useAuth();
  const { customers, customersById, fleet } = useData();
  const toast = useToast();

  const [step, setStep] = useState<Step>("pick");
  const [fileName, setFileName] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<CommitResult | null>(null);
  const [lastBatch, setLastBatch] = useState<BatchWithId | null>(null);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [undoAsk, setUndoAsk] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const autoRef = useRef<Record<string, string | null>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = step === "committing" || undoing;
  const canWrite = atLeast(role, "ops") && !!profile?.id;

  const reset = () => {
    setStep("pick"); setFileName(""); setParsing(false); setParseError(null);
    setHeaders([]); setRows([]); setMapping({}); setResult(null);
    setProgress({ done: 0, total: 0 });
  };
  useEffect(() => { if (open) reset(); }, [open]);

  // Most recent not-rolled-back batch → "Undo last import".
  useEffect(() => {
    if (!open) return;
    const q = query(collection(db, "importBatches"), orderBy("createdAt", "desc"), limit(10));
    return onSnapshot(q, (snap) => {
      const b = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as ImportBatch) }))
        .find((x) => !x.rolledBackAt) ?? null;
      setLastBatch(b);
      setBatchErr(null);
    }, (e) => setBatchErr(e.message));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  const preview = useMemo(
    () => (rows.length ? rowsToLoads(rows, mapping, { customers, nowIso }) : { loads: [], problems: [] as string[] }),
    [rows, mapping, customers],
  );
  const existingByKey = useMemo(() => {
    const m = new Map<string, Load>();
    for (const l of existing) m.set(keyOf(l.customerId, l.loadNumber), l);
    return m;
  }, [existing]);
  const plan = useMemo(() => {
    let create = 0, update = 0;
    for (const l of preview.loads) {
      if (existingByKey.has(keyOf(l.customerId, l.loadNumber))) update++; else create++;
    }
    return { create, update };
  }, [preview, existingByKey]);

  const handleFile = async (f: File) => {
    setParsing(true);
    setParseError(null);
    setFileName(f.name);
    try {
      const parsed = await parseWorkbook(f);
      if (!parsed.rows.length) {
        setParseError("No data rows found under the header row.");
      } else {
        const m = autoMap(parsed.headers);
        autoRef.current = m;
        setHeaders(parsed.headers);
        setRows(parsed.rows);
        setMapping(m);
        setStep("map");
      }
    } catch (e) {
      setParseError(String((e as Error)?.message ?? e));
    }
    setParsing(false);
  };

  const toggleField = (key: TargetField) => {
    setMapping((m) => {
      if (m[key]) return { ...m, [key]: null };
      const restore = autoRef.current[key];
      return restore ? { ...m, [key]: restore } : m;
    });
  };

  const sampleFor = (header: string | null): string => {
    if (!header) return "";
    for (const r of rows) {
      const v = r[header];
      if (v === null || v === undefined) continue;
      const s = v instanceof Date ? v.toLocaleString() : String(v).trim();
      if (s) return s.length > 42 ? `${s.slice(0, 39)}…` : s;
    }
    return "";
  };

  const commit = async () => {
    if (!profile?.id) { toast.push("error", "Not signed in — cannot import."); return; }
    const signer: Signer = { uid: profile.id, name: profile.displayName };
    const batchRef = doc(collection(db, "importBatches"));
    const createdLoadIds: string[] = [];
    const updatedLoads: { id: string; previousData: Record<string, unknown> }[] = [];
    const problems = [...preview.problems];
    let created = 0, updated = 0, unchanged = 0, failed = 0;
    setStep("committing");
    setProgress({ done: 0, total: preview.loads.length });
    for (const l of preview.loads) {
      const match = existingByKey.get(keyOf(l.customerId, l.loadNumber));
      try {
        if (match?.id) {
          const { patch, previous } = buildUpdatePatch(l, match, batchRef.id, mapping);
          if (Object.keys(patch).length) {
            await updateLoad(match.id, patch, signer, "import");
            updatedLoads.push({ id: match.id, previousData: previous });
            updated++;
          } else {
            unchanged++;
          }
        } else {
          const id = await createLoad({ ...l, batchId: batchRef.id }, signer, "import");
          createdLoadIds.push(id);
          created++;
        }
      } catch (e) {
        failed++;
        problems.push(`${l.lsNumber || l.loadNumber}: write failed — ${String((e as Error)?.message ?? e)}`);
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    if (created || updated) {
      try {
        await setDoc(batchRef, {
          createdAt: nowIso(), createdBy: signer.uid, createdByName: signer.name,
          rowCount: rows.length, createdLoadIds, updatedLoads, rolledBackAt: null,
        });
      } catch (e) {
        problems.push(`Batch record failed — undo unavailable for this import: ${String((e as Error)?.message ?? e)}`);
      }
    }
    const skipped = rows.length - preview.loads.length + unchanged + failed;
    setResult({ created, updated, skipped, problems });
    setStep("done");
    if (failed) toast.push("error", `Import finished with ${failed} failed write${failed === 1 ? "" : "s"}`);
    else toast.push("ok", `Imported ${created} new, ${updated} updated, ${skipped} skipped`);
  };

  const undo = async () => {
    if (!lastBatch || !profile?.id) return;
    const signer: Signer = { uid: profile.id, name: profile.displayName };
    setUndoing(true);
    try {
      for (const id of lastBatch.createdLoadIds) await deleteLoad(id);
      for (const u of lastBatch.updatedLoads) {
        await updateLoad(u.id, u.previousData as Partial<Load>, signer, "import");
      }
      await updateDoc(doc(db, "importBatches", lastBatch.id), { rolledBackAt: nowIso() });
      toast.push("ok", `Rolled back ${lastBatch.createdLoadIds.length} created + ${lastBatch.updatedLoads.length} updated loads`);
    } catch (e) {
      toast.push("error", `Undo failed: ${String((e as Error)?.message ?? e)}`);
    }
    setUndoing(false);
    setUndoAsk(false);
  };

  if (!open) return null;

  const mappedCount = TARGET_FIELDS.filter((f) => mapping[f.key]).length;
  const requiredOk = TARGET_FIELDS.every((f) => !f.required || mapping[f.key]);
  const rowsSkipped = rows.length - preview.loads.length;
  const undoCount = (lastBatch?.createdLoadIds.length ?? 0) + (lastBatch?.updatedLoads.length ?? 0);

  const problemsBox = (list: string[]) => list.length > 0 && (
    <div className="border border-late/40 bg-lateSoft rounded-lg p-3 max-h-40 overflow-y-auto">
      <p className="text-xs font-semibold text-late mb-1">{list.length} problem{list.length === 1 ? "" : "s"}</p>
      <ul className="text-xs font-mono text-late space-y-0.5">
        {list.map((p, i) => <li key={i}>{p}</li>)}
      </ul>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!busy) onClose(); }} />
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-2 md:inset-y-8 md:left-1/2 md:-translate-x-1/2 md:inset-x-auto md:w-[min(920px,calc(100vw-2rem))] bg-surface border border-rule rounded-lg shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-rule shrink-0">
          <h2 className="font-display font-semibold text-lg">Import Excel</h2>
          <div className="flex items-center gap-1 text-xs font-mono">
            {STEP_LABELS.map((s, i) => (
              <span key={s.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-ink3">›</span>}
                <span className={i === stepIndex(step) ? "text-brand font-semibold" : i < stepIndex(step) ? "text-ink2" : "text-ink3"}>
                  {i + 1} {s.label}
                </span>
              </span>
            ))}
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="px-2 py-0.5 rounded text-ink2 hover:bg-surface2 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {step === "pick" && (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) void handleFile(f);
                }}
                className={`border-2 border-dashed rounded-lg p-10 text-center ${dragOver ? "border-brand bg-surface2" : "border-ruleStrong"}`}
              >
                {parsing ? <Spinner label="Reading workbook…" /> : (
                  <>
                    <p className="font-display font-semibold text-lg">Drop a spreadsheet here</p>
                    <p className="text-sm text-ink3 mt-1">
                      .xlsx / .xls / .csv — the first sheet is read and the header row is detected automatically.
                    </p>
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="mt-4 px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90"
                    >
                      Choose file
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleFile(f);
                        e.target.value = "";
                      }}
                    />
                  </>
                )}
              </div>
              {parseError && <ErrorNote message={parseError} />}
            </>
          )}

          {step === "map" && (
            <>
              <div className="flex items-center justify-between gap-2 text-sm text-ink2">
                <span className="font-mono">{fileName} · {rows.length} rows · {headers.length} columns</span>
                <button
                  type="button"
                  onClick={() => { setStep("pick"); setParseError(null); }}
                  className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
                >
                  Choose another file
                </button>
              </div>
              <p className="text-xs text-ink3">
                Click a chip to skip or restore a field — green is matched to a column, steel will not be imported.
                Fine-tune any column with the selects below.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {TARGET_FIELDS.map((f) => {
                  const mapped = mapping[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => toggleField(f.key)}
                      title={mapped ? `Mapped to "${mapped}" — click to skip` : "Not imported — click to restore the auto-match"}
                      className={`px-2.5 py-1 rounded-full text-xs font-mono border whitespace-nowrap hover:bg-surface2 ${
                        mapped ? "border-ontime text-ontime" : "border-ruleStrong text-pending"
                      }`}
                    >
                      {mapped ? "✓" : "○"} {f.label}{f.required ? " ✱" : ""}{mapped ? ` → ${mapped}` : ""}
                    </button>
                  );
                })}
              </div>
              {!requiredOk && (
                <ErrorNote message="Customer and Load # columns are required before previewing." />
              )}
              <div className="scroll-x bg-surface border border-rule rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-mono uppercase text-ink3 border-b border-rule">
                      <th className="px-3 py-2">Field</th>
                      <th className="px-3 py-2">Sheet column</th>
                      <th className="px-3 py-2">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TARGET_FIELDS.map((f) => (
                      <tr key={f.key} className="border-b border-rule last:border-b-0">
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {f.label}{f.required && <span className="text-brand"> ✱</span>}
                        </td>
                        <td className="px-3 py-1.5">
                          <select
                            aria-label={`Column for ${f.label}`}
                            value={mapping[f.key] ?? ""}
                            onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || null }))}
                            className="w-full max-w-xs bg-surface2 border border-rule rounded px-2 py-1 text-sm text-ink"
                          >
                            <option value="">— skip —</option>
                            {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-ink3 max-w-[16rem] truncate">
                          {sampleFor(mapping[f.key])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {step === "preview" && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-ontimeSoft text-ontime tnum">{plan.create} new</span>
                <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-surface2 text-ink2 tnum">{plan.update} will update existing</span>
                <span className="px-2.5 py-1 rounded-full text-xs font-mono bg-pendingSoft text-pending tnum">{rowsSkipped} skipped</span>
              </div>
              {problemsBox(preview.problems)}
              {preview.loads.length === 0 ? (
                <EmptyState title="Nothing importable" hint="Every row was skipped — check the customer and load number mappings." />
              ) : (
                <div className="scroll-x bg-surface border border-rule rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left font-mono uppercase text-ink3 border-b border-rule">
                        <th className="px-2 py-2">LS #</th>
                        <th className="px-2 py-2">Load #</th>
                        <th className="px-2 py-2">Customer</th>
                        <th className="px-2 py-2">Co.</th>
                        <th className="px-2 py-2">Lane</th>
                        <th className="px-2 py-2">PU appt</th>
                        <th className="px-2 py-2">PU actual</th>
                        <th className="px-2 py-2">DEL appt</th>
                        <th className="px-2 py-2">DEL actual</th>
                        <th className="px-2 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.loads.slice(0, 10).map((l, i) => {
                        const pu = l.stops[0], del = l.stops[1];
                        return (
                          <tr key={i} className="border-b border-rule last:border-b-0">
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{l.lsNumber}</td>
                            <td className="px-2 py-1.5 font-mono whitespace-nowrap">{l.loadNumber}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{customersById[l.customerId]?.name ?? l.customerId}</td>
                            <td className="px-2 py-1.5 font-mono">{l.operatingCompany}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {pu.city || "—"}{pu.state ? `, ${pu.state}` : ""} → {del.city || "—"}{del.state ? `, ${del.state}` : ""}
                            </td>
                            <td className="px-2 py-1.5 font-mono tnum whitespace-nowrap">{fmtDateTime(pu.appt, pu.timeZone)}</td>
                            <td className="px-2 py-1.5 font-mono tnum whitespace-nowrap">{fmtDateTime(pu.actualArrival, pu.timeZone)}</td>
                            <td className="px-2 py-1.5 font-mono tnum whitespace-nowrap">{fmtDateTime(del.appt, del.timeZone)}</td>
                            <td className="px-2 py-1.5 font-mono tnum whitespace-nowrap">{fmtDateTime(del.actualArrival, del.timeZone)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{l.status}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {preview.loads.length > 10 && (
                    <p className="px-3 py-2 text-xs text-ink3 tnum">+ {preview.loads.length - 10} more loads not shown</p>
                  )}
                </div>
              )}
            </>
          )}

          {step === "committing" && (
            <div className="py-10 max-w-md mx-auto text-center">
              <p className="font-display font-semibold mb-2">Writing loads…</p>
              <p className="text-sm text-ink2 tnum mb-3">{progress.done} / {progress.total}</p>
              <div className="h-2 rounded bg-surface2 overflow-hidden">
                <div
                  className="h-full bg-brand transition-all"
                  style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                />
              </div>
              <p className="text-xs text-ink3 mt-3">Keep this window open until the import finishes.</p>
            </div>
          )}

          {step === "done" && result && (
            <>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ["Created", result.created, "text-ontime"],
                  ["Updated", result.updated, "text-ink"],
                  ["Skipped", result.skipped, "text-pending"],
                ] as const).map(([label, n, cls]) => (
                  <div key={label} className="bg-surface border border-rule rounded-lg p-4 text-center">
                    <p className={`font-display font-bold text-3xl tnum ${cls}`}>{n}</p>
                    <p className="text-xs font-mono uppercase text-ink3 mt-1">{label}</p>
                  </div>
                ))}
              </div>
              {problemsBox(result.problems)}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-rule shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {lastBatch && (step === "pick" || step === "done") && (
              <button
                type="button"
                disabled={undoing || !canWrite}
                title={canWrite ? `Import by ${lastBatch.createdByName}, ${fmtDateTime(lastBatch.createdAt, fleet.timeZone)}` : "Requires the ops role"}
                onClick={() => setUndoAsk(true)}
                className="px-3 py-1.5 rounded text-sm text-late border border-late/40 hover:bg-lateSoft disabled:opacity-50 whitespace-nowrap"
              >
                {undoing ? "Undoing…" : `Undo last import (${undoCount} loads)`}
              </button>
            )}
            {batchErr && <span className="text-xs text-late truncate">Import history unavailable: {batchErr}</span>}
          </div>
          <div className="flex items-center gap-2">
            {step === "map" && (
              <>
                <span className="text-xs text-ink3 font-mono tnum">{mappedCount}/{TARGET_FIELDS.length} fields mapped</span>
                <button
                  type="button"
                  disabled={!requiredOk}
                  title={requiredOk ? undefined : "Map the Customer and Load # columns first"}
                  onClick={() => setStep("preview")}
                  className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Preview →
                </button>
              </>
            )}
            {step === "preview" && (
              <>
                <button
                  type="button"
                  onClick={() => setStep("map")}
                  className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
                >
                  ← Back to mapping
                </button>
                <button
                  type="button"
                  disabled={!canWrite || preview.loads.length === 0}
                  title={canWrite ? undefined : "Requires the ops role"}
                  onClick={() => void commit()}
                  className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  Import {preview.loads.length} load{preview.loads.length === 1 ? "" : "s"}
                </button>
              </>
            )}
            {step === "done" && (
              <>
                <button
                  type="button"
                  onClick={reset}
                  className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
                >
                  Import another file
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90"
                >
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={undoAsk}
        title="Undo last import"
        body={`Delete ${lastBatch?.createdLoadIds.length ?? 0} created load(s) and restore ${lastBatch?.updatedLoads.length ?? 0} updated load(s) to their previous values? This cannot itself be undone.`}
        confirmLabel="Undo import"
        danger
        onConfirm={() => void undo()}
        onCancel={() => setUndoAsk(false)}
      />
    </div>
  );
}
