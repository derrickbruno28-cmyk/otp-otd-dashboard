import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { addDoc, collection } from "firebase/firestore";
import { db } from "../lib/firebase";
import { Drawer, Field } from "./ui";
import { useToast } from "./Toast";
import type { Driver, OperatingCompany } from "../lib/types";

interface Row { name: string; company: OperatingCompany; }

/**
 * Bulk driver import: paste names one per line, or drop the spreadsheet dispatch
 * already keeps (first sheet; name + optional company column, fuzzy-matched).
 * Dedupes case-insensitively against the roster and within the input.
 */
export function ImportDriversModal({ open, onClose, existing }: {
  open: boolean;
  onClose(): void;
  existing: Driver[];
}) {
  const toast = useToast();
  const [pasted, setPasted] = useState("");
  const [fileRows, setFileRows] = useState<Row[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [defaultCompany, setDefaultCompany] = useState<OperatingCompany>("GH");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const existingNames = useMemo(
    () => new Set(existing.map((d) => d.name.trim().toLowerCase())),
    [existing],
  );

  const parseCompany = (v: unknown): OperatingCompany | null => {
    const s = String(v ?? "").toUpperCase();
    if (s.includes("AJG")) return "AJG";
    if (s.includes("GH") || s.includes("GOMEZ")) return "GH";
    return null;
  };

  // Pasted lines: "Name" or "Name, AJG" / "Name - GH"
  const pastedRows: Row[] = useMemo(() => pasted
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)[,\-–|\t]\s*(AJG|GH|GOMEZ[^,]*)$/i);
      if (m) return { name: m[1].trim(), company: parseCompany(m[2]) ?? defaultCompany };
      return { name: line, company: defaultCompany };
    })
    .filter((r) => r.name.length > 1), [pasted, defaultCompany]);

  const rows = fileRows ?? pastedRows;
  const fresh = useMemo(() => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = r.name.trim().toLowerCase();
      if (!k || existingNames.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [rows, existingNames]);
  const skipped = rows.length - fresh.length;

  const onFile = async (f: File) => {
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const keys = raw.length ? Object.keys(raw[0]) : [];
      const nameKey = keys.find((k) => /name|driver/i.test(k)) ?? keys[0];
      const coKey = keys.find((k) => /compan|carrier|co\b|fleet/i.test(k));
      const out: Row[] = raw
        .map((r) => ({
          name: String(r[nameKey] ?? "").trim(),
          company: (coKey && parseCompany(r[coKey])) || defaultCompany,
        }))
        .filter((r) => r.name.length > 1 && !/^name$|^driver/i.test(r.name));
      setFileRows(out);
      setFileName(f.name);
      if (!out.length) toast.push("error", `No driver names found in ${f.name} (looked for a "${nameKey}" column)`);
    } catch (e) {
      toast.push("error", `Could not read ${f.name}: ${String((e as Error)?.message ?? e)}`);
    }
  };

  const commit = async () => {
    if (!fresh.length || busy) return;
    setBusy(true);
    let created = 0;
    try {
      for (const r of fresh) {
        await addDoc(collection(db, "drivers"), {
          name: r.name, operatingCompany: r.company, active: true,
          reviewState: "NONE", reviewedBy: null, reviewedByName: null,
          reviewedAt: null, reviewNotes: "",
        });
        created++;
      }
      toast.push("ok", `Imported ${created} driver${created === 1 ? "" : "s"}${skipped ? ` · ${skipped} already on the roster` : ""}`);
      setPasted(""); setFileRows(null); setFileName("");
      onClose();
    } catch (e) {
      toast.push("error", `Import stopped after ${created}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Import drivers" width="min(560px,100vw)">
      <div className="space-y-4">
        <Field label="Default company for imported drivers"
          hint="Used when a line or row doesn't name AJG or GH itself.">
          <div className="flex gap-2">
            {(["GH", "AJG"] as OperatingCompany[]).map((c) => (
              <button key={c} type="button" onClick={() => setDefaultCompany(c)}
                className={`px-3 py-1 rounded-full text-xs font-mono border ${defaultCompany === c ? "bg-brand text-brandInk border-brand" : "border-ruleStrong text-ink2 hover:bg-surface2"}`}>
                {c}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Paste names — one per line"
          hint={'Optionally add the company: "George Crowley Jr, GH" or "Edward Hall - AJG".'}>
          <textarea
            rows={8}
            value={pasted}
            disabled={fileRows !== null}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"George Crowley Jr\nDametrica Shuntel Crowley, GH\nEdward James Hall - AJG"}
            className="w-full rounded border border-rule bg-surface2 px-2 py-1.5 text-sm text-ink font-mono"
          />
        </Field>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono uppercase tracking-wider text-ink3">or</span>
          <button type="button" onClick={() => fileInput.current?.click()}
            className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
            Choose spreadsheet (.xlsx / .csv)
          </button>
          <input ref={fileInput} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
          {fileName && (
            <span className="text-xs text-ink2 font-mono">{fileName}
              <button type="button" className="ml-2 text-late" onClick={() => { setFileRows(null); setFileName(""); }}>×</button>
            </span>
          )}
        </div>

        {rows.length > 0 && (
          <div className="rounded border border-rule bg-surface2/50 p-3 text-sm">
            <p className="text-ink">
              <span className="tnum font-semibold">{fresh.length}</span> new driver{fresh.length === 1 ? "" : "s"} to add
              {skipped > 0 && <span className="text-ink3"> · {skipped} skipped (already on the roster or duplicated)</span>}
            </p>
            <div className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
              {fresh.slice(0, 30).map((r) => (
                <div key={r.name} className="flex justify-between text-xs">
                  <span className="text-ink2">{r.name}</span>
                  <span className="font-mono text-ink3">{r.company}</span>
                </div>
              ))}
              {fresh.length > 30 && <div className="text-xs text-ink3">…and {fresh.length - 30} more</div>}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
            Cancel
          </button>
          <button type="button" disabled={!fresh.length || busy} onClick={() => void commit()}
            className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50">
            {busy ? "Importing…" : `Import ${fresh.length || ""}`}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
