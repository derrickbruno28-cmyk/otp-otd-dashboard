/**
 * Tender drop zone + review. Upload creates the tenders doc first, then the Storage
 * object at tenders/{docId} — the finalize trigger (parseTender) keys off that path.
 * A parsed tender NEVER auto-saves: the review drawer edits a local draft Load and
 * nothing writes until "Confirm & create load".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  collection, doc, limit, onSnapshot, orderBy, query, setDoc, updateDoc,
} from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "../lib/firebase";
import { atLeast, useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { createLoad, type Signer } from "../lib/loads";
import { fmtDateTime, localInputToIso, nowIso, timeZoneForState, tzAbbr } from "../lib/format";
import type {
  Customer, CustomerId, FieldExtraction, Load, Stop, StopType, Tender, TenderParsedStop,
} from "../lib/types";
import { LOAD_STATUSES, OPERATING_COMPANIES } from "../lib/types";
import { ConfirmDialog, Drawer, EmptyState, ErrorNote, Field, Spinner } from "./ui";
import { TimeInput } from "./TimeInput";
import { useToast } from "./Toast";

const INPUT =
  "w-full rounded border border-ruleStrong bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:border-brand disabled:opacity-50";
const MINI_BTN =
  "px-1.5 py-0.5 rounded border border-ruleStrong text-ink2 text-xs hover:bg-surface2 disabled:opacity-40 disabled:hover:bg-transparent";
const US_ZONES = [
  "America/New_York", "America/Detroit", "America/Indiana/Indianapolis",
  "America/Chicago", "America/Denver", "America/Boise", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Printed appointment string → ISO instant in the stop's zone; null when unresolvable. */
function resolveAppt(raw: string | null, timeZone: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? localInputToIso(m[1], timeZone) : null;
}

interface DraftStop extends Omit<Stop, "type"> {
  type: StopType | "";           // blank until a human sets it — never guessed
  px?: TenderParsedStop;         // extraction provenance for badges; stripped on save
}
interface DraftLoad extends Omit<Load, "stops"> { stops: DraftStop[]; }

function emptyDraftStop(seq: number): DraftStop {
  return {
    seq, type: "", locationName: "", address: "", city: "", state: "", zip: "",
    timeZone: "America/Chicago", appt: null, apptEnd: null,
    actualArrival: null, actualDeparture: null,
  };
}

function draftFromTender(t: Tender, customers: Customer[]): DraftLoad {
  const p = t.parsed;
  const stops: DraftStop[] = (p?.stops ?? []).map((ps, i) => {
    const state = (ps.state.value ?? "").toUpperCase();
    const tz = state.length === 2 ? timeZoneForState(state) : "America/Chicago";
    return {
      seq: i + 1,
      type: ps.type.value ?? "",
      locationName: ps.locationName.value ?? "",
      address: ps.address.value ?? "",
      city: ps.city.value ?? "",
      state,
      zip: ps.zip.value ?? "",
      timeZone: tz,
      appt: resolveAppt(ps.appt.value, tz),
      apptEnd: resolveAppt(ps.apptEnd.value, tz),
      actualArrival: null,
      actualDeparture: null,
      px: ps,
    };
  });
  while (stops.length < 2) stops.push(emptyDraftStop(stops.length + 1));
  const name = (p?.customerName.value ?? "").trim().toLowerCase();
  const cust = name
    ? customers.find((c) =>
        c.name.trim().toLowerCase() === name ||
        c.aliases.some((a) => a.trim().toLowerCase() === name))
    : undefined;
  return {
    lsNumber: "",
    loadNumber: p?.loadNumber.value ?? "",
    referenceNumber: p?.referenceNumber.value ?? "",
    customerId: (cust?.id ?? "") as CustomerId,
    operatingCompany: "GH",
    equipmentType: p?.equipmentType.value ?? "",
    status: "Tendered",
    pieces: p?.pieces.value ?? null,
    weightLbs: p?.weightLbs.value ?? null,
    billingMiles: p?.billingMiles.value ?? null,
    commodity: p?.commodity.value ?? "",
    stops,
    primaryDriverId: null, secondaryDriverId: null,
    primaryDriverName: "", secondaryDriverName: "",
    truckNumber: "", runType: "", tripNumber: "", isShuttleLeg: false,
    otpReasons: [], otdReasons: [],
    cf: { otp: null, otd: null },
  };
}

function validateDraft(d: DraftLoad): string[] {
  const out: string[] = [];
  if (!d.lsNumber.trim()) out.push("LS # is required.");
  if (!d.loadNumber.trim()) out.push("Load # is required.");
  if (!d.customerId) out.push("Customer is required.");
  d.stops.forEach((s, i) => { if (!s.type) out.push(`Stop ${i + 1} needs a type.`); });
  if (!d.stops.some((s) => s.type === "PICKUP")) out.push("At least one PICKUP stop is required.");
  if (!d.stops.some((s) => s.type === "DELIVERY")) out.push("At least one DELIVERY stop is required.");
  return out;
}

/** Label row for a parsed field: name + low-confidence CHECK tag + provenance tooltip. */
function PxLabel({ text, f }: { text: string; f: FieldExtraction<unknown> | undefined }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide text-ink3 mb-1">
      {text}
      {f?.confidence === "low" && (
        <span className="px-1 rounded border border-brand text-brand text-[10px] font-semibold normal-case">CHECK</span>
      )}
      {f && (f.sourceText !== null || f.labelRead !== null) && (
        <span
          className="cursor-help text-ink3 normal-case"
          title={`read as: ${f.labelRead ?? "—"} — “${f.sourceText ?? ""}”`}
        >
          ⓘ
        </span>
      )}
    </span>
  );
}

function ApptEcho({ px, iso, timeZone }: {
  px: FieldExtraction<string> | undefined; iso: string | null; timeZone: string;
}) {
  if (!px || px.value === null) return null;
  return (
    <span className="block text-xs text-ink3 mt-1">
      printed “{px.sourceText ?? px.value}” →{" "}
      {iso
        ? <span className="font-mono tnum text-ink2">{fmtDateTime(iso, timeZone)}</span>
        : <span className="text-late">unresolved — enter manually</span>}
    </span>
  );
}

function TenderReview({ tender, existing, onClose }: {
  tender: Tender; existing: Load[]; onClose(): void;
}) {
  const { profile, role } = useAuth();
  const { customers, fleet } = useData();
  const toast = useToast();
  const canConfirm = atLeast(role, "ops");

  const [draft, setDraft] = useState<DraftLoad>(() => draftFromTender(tender, customers));
  const [problems, setProblems] = useState<string[]>([]);
  const [createAnyway, setCreateAnyway] = useState(false);
  const [saving, setSaving] = useState(false);
  const [discardAsk, setDiscardAsk] = useState(false);
  const px = tender.parsed;

  const duplicate = useMemo(() => {
    const ln = draft.loadNumber.trim().toLowerCase();
    if (!ln || !draft.customerId) return false;
    return existing.some(
      (l) => l.customerId === draft.customerId && l.loadNumber.trim().toLowerCase() === ln,
    );
  }, [existing, draft.loadNumber, draft.customerId]);

  const patch = (p: Partial<DraftLoad>) => setDraft((d) => ({ ...d, ...p }));
  const patchStop = (idx: number, p: Partial<DraftStop>) =>
    setDraft((d) => ({ ...d, stops: d.stops.map((s, i) => (i === idx ? { ...s, ...p } : s)) }));
  const renumber = (stops: DraftStop[]) => stops.map((s, i) => ({ ...s, seq: i + 1 }));
  const addStop = () =>
    setDraft((d) => ({ ...d, stops: renumber([...d.stops, emptyDraftStop(d.stops.length + 1)]) }));
  const removeStop = (idx: number) =>
    setDraft((d) => d.stops.length <= 2 ? d : { ...d, stops: renumber(d.stops.filter((_, i) => i !== idx)) });
  const moveStop = (idx: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = idx + dir;
      if (j < 0 || j >= d.stops.length) return d;
      const stops = [...d.stops];
      [stops[idx], stops[j]] = [stops[j], stops[idx]];
      return { ...d, stops: renumber(stops) };
    });

  const confirm = async () => {
    const errs = validateDraft(draft);
    if (duplicate && !createAnyway) {
      errs.push("Load number already exists for this customer — check “Create anyway” to proceed.");
    }
    setProblems(errs);
    if (errs.length) return;
    if (!profile?.id) { toast.push("error", "Not signed in."); return; }
    const signer: Signer = { uid: profile.id, name: profile.displayName };
    const stops: Stop[] = draft.stops.map(({ px: _px, type, ...s }, i) =>
      ({ ...s, seq: i + 1, type: type as StopType }));
    setSaving(true);
    try {
      const loadId = await createLoad({ ...draft, stops, tenderId: tender.id ?? null }, signer, "tender");
      await updateDoc(doc(db, "tenders", tender.id!), { status: "confirmed", loadId });
      toast.push("ok", `Load ${draft.lsNumber} created from tender`);
      onClose();
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      toast.push("error", `Create failed: ${msg}`);
      setProblems([`Create failed: ${msg}`]);
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    setDiscardAsk(false);
    try {
      await updateDoc(doc(db, "tenders", tender.id!), { status: "discarded" });
      toast.push("ok", "Tender discarded");
      onClose();
    } catch (e: unknown) {
      toast.push("error", `Discard failed: ${String((e as Error)?.message ?? e)}`);
    }
  };

  return (
    <Drawer
      open
      onClose={() => { if (!discardAsk) onClose(); }}
      title="Review tender"
      width="min(760px,100vw)"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink3">
          <span className="font-mono text-ink2">{tender.fileName}</span>
          <span>{Math.max(1, Math.round(tender.sizeBytes / 1024))} KB</span>
          <span>uploaded by {tender.uploadedByName}</span>
          <span className="font-mono tnum">{fmtDateTime(tender.createdAt, fleet.timeZone)}</span>
        </div>

        {problems.length > 0 && <ErrorNote message={problems.join(" ")} />}
        {!px && <ErrorNote message="This tender has no parsed data to review." />}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="LS #" hint="Internal — not on the tender.">
            <input className={`${INPUT} font-mono`} value={draft.lsNumber}
              onChange={(e) => patch({ lsNumber: e.target.value })} />
          </Field>
          <div>
            <PxLabel text="Load #" f={px?.loadNumber} />
            <input className={`${INPUT} font-mono`} value={draft.loadNumber}
              onChange={(e) => patch({ loadNumber: e.target.value })} />
          </div>
          <div>
            <PxLabel text="Reference #" f={px?.referenceNumber} />
            <input className={`${INPUT} font-mono`} value={draft.referenceNumber}
              onChange={(e) => patch({ referenceNumber: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <PxLabel text="Customer" f={px?.customerName} />
            <select className={INPUT} value={draft.customerId}
              onChange={(e) => patch({ customerId: e.target.value as CustomerId })}>
              <option value="">— select customer —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {px?.customerName.value !== null && px?.customerName.value !== undefined && !draft.customerId && (
              <span className="block text-xs text-ink3 mt-1">printed “{px.customerName.value}” — no match</span>
            )}
          </div>
          <Field label="Operating company">
            <select className={INPUT} value={draft.operatingCompany}
              onChange={(e) => patch({ operatingCompany: e.target.value as Load["operatingCompany"] })}>
              {OPERATING_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select className={INPUT} value={draft.status}
              onChange={(e) => patch({ status: e.target.value as Load["status"] })}>
              {LOAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div>
            <PxLabel text="Equipment" f={px?.equipmentType} />
            <input className={INPUT} value={draft.equipmentType}
              onChange={(e) => patch({ equipmentType: e.target.value })} />
          </div>
          <div>
            <PxLabel text="Pieces" f={px?.pieces} />
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.pieces ?? ""}
              onChange={(e) => patch({ pieces: numOrNull(e.target.value) })} />
          </div>
          <div>
            <PxLabel text="Weight (lbs)" f={px?.weightLbs} />
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.weightLbs ?? ""}
              onChange={(e) => patch({ weightLbs: numOrNull(e.target.value) })} />
          </div>
          <div>
            <PxLabel text="Billing miles" f={px?.billingMiles} />
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.billingMiles ?? ""}
              onChange={(e) => patch({ billingMiles: numOrNull(e.target.value) })} />
          </div>
          <div>
            <PxLabel text="Commodity" f={px?.commodity} />
            <input className={INPUT} value={draft.commodity}
              onChange={(e) => patch({ commodity: e.target.value })} />
          </div>
        </div>

        {duplicate && (
          <div className="border border-late/40 bg-lateSoft rounded-lg px-3 py-2 text-sm text-late">
            Load number already exists for this customer.
            <label className="flex items-center gap-2 mt-1 text-ink2">
              <input type="checkbox" checked={createAnyway} onChange={(e) => setCreateAnyway(e.target.checked)} />
              Create anyway
            </label>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-semibold">Stops — printed order</h3>
            <button type="button" onClick={addStop}
              className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
              + Add stop
            </button>
          </div>

          {draft.stops.map((s, i) => (
            <div key={i} className="border border-rule rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs uppercase tracking-wide text-ink3">
                  Stop {s.seq}{s.type ? ` — ${s.type}` : ""}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" title="Move up" aria-label={`Move stop ${s.seq} up`}
                    className={MINI_BTN} disabled={i === 0} onClick={() => moveStop(i, -1)}>↑</button>
                  <button type="button" title="Move down" aria-label={`Move stop ${s.seq} down`}
                    className={MINI_BTN} disabled={i === draft.stops.length - 1} onClick={() => moveStop(i, 1)}>↓</button>
                  <button type="button"
                    title={draft.stops.length <= 2 ? "A load needs at least 2 stops" : "Remove stop"}
                    aria-label={`Remove stop ${s.seq}`}
                    className={`${MINI_BTN} text-late border-late/40`}
                    disabled={draft.stops.length <= 2} onClick={() => removeStop(i)}>✕</button>
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <PxLabel text="Type" f={s.px?.type} />
                  <select className={INPUT} value={s.type}
                    onChange={(e) => patchStop(i, { type: e.target.value as StopType | "" })}>
                    <option value="">— select —</option>
                    <option value="PICKUP">PICKUP</option>
                    <option value="DELIVERY">DELIVERY</option>
                  </select>
                </div>
                <div>
                  <PxLabel text="Location name" f={s.px?.locationName} />
                  <input className={INPUT} value={s.locationName}
                    onChange={(e) => patchStop(i, { locationName: e.target.value })} />
                </div>
                <div>
                  <PxLabel text="Address" f={s.px?.address} />
                  <input className={INPUT} value={s.address}
                    onChange={(e) => patchStop(i, { address: e.target.value })} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <PxLabel text="City" f={s.px?.city} />
                  <input className={INPUT} value={s.city}
                    onChange={(e) => patchStop(i, { city: e.target.value })} />
                </div>
                <div>
                  <PxLabel text="State" f={s.px?.state} />
                  <input className={`${INPUT} font-mono uppercase`} maxLength={2} value={s.state}
                    onChange={(e) => {
                      const st = e.target.value.toUpperCase();
                      patchStop(i, st.length === 2
                        ? { state: st, timeZone: timeZoneForState(st) }
                        : { state: st });
                    }} />
                </div>
                <div>
                  <PxLabel text="Zip" f={s.px?.zip} />
                  <input className={`${INPUT} font-mono`} value={s.zip}
                    onChange={(e) => patchStop(i, { zip: e.target.value })} />
                </div>
                <Field label="Time zone">
                  <select className={INPUT} value={s.timeZone}
                    onChange={(e) => patchStop(i, { timeZone: e.target.value })}>
                    {(US_ZONES.includes(s.timeZone) ? US_ZONES : [s.timeZone, ...US_ZONES]).map((z) => (
                      <option key={z} value={z}>{tzAbbr(z)} — {z}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <PxLabel text="Appointment" f={s.px?.appt} />
                  <TimeInput value={s.appt} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} appointment`}
                    onCommit={(next) => patchStop(i, { appt: next })} />
                  <ApptEcho px={s.px?.appt} iso={s.appt} timeZone={s.timeZone} />
                </div>
                <div>
                  <PxLabel text="Window close" f={s.px?.apptEnd} />
                  <TimeInput value={s.apptEnd} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} window close`}
                    onCommit={(next) => patchStop(i, { apptEnd: next })} />
                  <ApptEcho px={s.px?.apptEnd} iso={s.apptEnd} timeZone={s.timeZone} />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-rule">
          <button type="button" onClick={() => setDiscardAsk(true)}
            className="px-3 py-1.5 rounded text-sm text-late border border-late/40 hover:bg-lateSoft">
            Discard
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
              Cancel
            </button>
            <button type="button" onClick={confirm} disabled={saving || !canConfirm}
              title={canConfirm ? undefined : "Requires ops role or above"}
              className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50">
              {saving ? "Creating…" : "Confirm & create load"}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={discardAsk}
        title="Discard tender?"
        body={`No load will be created from “${tender.fileName}”. The uploaded file and parsed data remain on record.`}
        confirmLabel="Discard"
        danger
        onConfirm={discard}
        onCancel={() => setDiscardAsk(false)}
      />
    </Drawer>
  );
}

function TenderStatusCell({ t, onReview }: { t: Tender; onReview(): void }) {
  switch (t.status) {
    case "uploaded":
      return <Spinner label="uploaded — waiting for parse" />;
    case "parsing":
      return <Spinner label="parsing…" />;
    case "parsed":
      return (
        <button type="button" onClick={onReview}
          className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50">
          Review
        </button>
      );
    case "error":
      return (
        <span className="text-sm text-late break-words" title={t.error ?? undefined}>
          {t.error ?? "Parse failed"}
        </span>
      );
    case "confirmed":
      return (
        <span className="font-mono text-xs text-ontime underline underline-offset-2"
          title={t.loadId ? `Load ID ${t.loadId} — find it on the Loads tab` : undefined}>
          load created
        </span>
      );
    case "discarded":
      return <span className="font-mono text-xs text-ink3">discarded</span>;
  }
}

export function TenderZone({ open, onClose, existing }: {
  open: boolean; onClose(): void; existing: Load[];
}) {
  const { profile } = useAuth();
  const { fleet } = useData();
  const toast = useToast();

  const [tenders, setTenders] = useState<Tender[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [review, setReview] = useState<Tender | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Subscribe only while the modal is open.
  useEffect(() => {
    if (!open) return;
    setListLoading(true);
    setListError(null);
    const q = query(collection(db, "tenders"), orderBy("createdAt", "desc"), limit(25));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setTenders(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Tender) })));
        setListLoading(false);
      },
      (e) => { setListError(String(e?.message ?? e)); setListLoading(false); },
    );
    return unsub;
  }, [open]);

  useEffect(() => {
    if (!open) { setReview(null); setDragging(false); return; }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && review === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, review, onClose]);

  const uploadFiles = async (fileList: FileList | File[]) => {
    const all = Array.from(fileList);
    if (!profile?.id) { toast.push("error", "Not signed in."); return; }
    const pdfs = all.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const skipped = all.length - pdfs.length;
    if (skipped > 0) toast.push("error", `${skipped} non-PDF file${skipped === 1 ? "" : "s"} skipped — tenders must be PDFs.`);
    for (const file of pdfs) {
      const dref = doc(collection(db, "tenders"));
      const tender: Tender = {
        fileName: file.name,
        storagePath: `tenders/${dref.id}`,
        sha256: null,
        sizeBytes: file.size,
        status: "uploaded",
        parsed: null,
        error: null,
        loadId: null,
        uploadedBy: profile.id,
        uploadedByName: profile.displayName,
        createdAt: nowIso(),
      };
      setUploading((n) => n + 1);
      try {
        await setDoc(dref, tender);
        await uploadBytes(ref(storage, `tenders/${dref.id}`), file, { contentType: "application/pdf" });
      } catch (e: unknown) {
        const msg = String((e as Error)?.message ?? e);
        toast.push("error", `Upload failed for ${file.name}: ${msg}`);
        try { await updateDoc(dref, { status: "error", error: `Upload failed: ${msg}` }); } catch { /* doc write itself failed */ }
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) void uploadFiles(e.target.files);
    e.target.value = "";
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden={false}>
        <div className="absolute inset-0 bg-black/60" onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          className="absolute inset-2 sm:inset-8 bg-ground border border-rule rounded-lg shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-rule bg-surface shrink-0">
            <h2 className="font-display font-semibold text-lg">Drop tender</h2>
            <button type="button" aria-label="Close" onClick={onClose}
              className="px-2 py-0.5 rounded text-ink2 hover:bg-surface2">
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
              className={`rounded-lg border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
                dragging ? "border-brand bg-surface2" : "border-ruleStrong bg-surface hover:bg-surface2"
              }`}
            >
              <p className="font-display font-semibold text-ink">Drop tender PDF(s) here</p>
              <p className="text-sm text-ink3 mt-1">or click to choose files — parsing starts automatically after upload</p>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple className="hidden"
                aria-label="Choose tender PDFs" onChange={onPick} />
              {uploading > 0 && <Spinner label={`Uploading ${uploading} file${uploading === 1 ? "" : "s"}…`} />}
            </div>

            <div className="bg-surface border border-rule rounded-lg">
              <div className="px-4 py-2.5 border-b border-rule">
                <h3 className="font-display font-semibold">Recent tenders</h3>
              </div>
              <div className="p-2">
                {listError && <ErrorNote message={listError} />}
                {!listError && listLoading && <Spinner label="Loading tenders…" />}
                {!listError && !listLoading && tenders.length === 0 && (
                  <EmptyState title="No tenders yet" hint="Drop a rate confirmation PDF above to get started." />
                )}
                {!listError && !listLoading && tenders.length > 0 && (
                  <ul className="divide-y divide-rule">
                    {tenders.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-2">
                        <span className="font-mono text-sm text-ink truncate max-w-[16rem]" title={t.fileName}>
                          {t.fileName}
                        </span>
                        <span className="text-xs text-ink3 tnum">{Math.max(1, Math.round(t.sizeBytes / 1024))} KB</span>
                        <span className="text-xs text-ink3">{t.uploadedByName}</span>
                        <span className="text-xs text-ink3 font-mono tnum">{fmtDateTime(t.createdAt, fleet.timeZone)}</span>
                        <span className="ml-auto flex items-center">
                          <TenderStatusCell t={t} onReview={() => setReview(t)} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {review && (
        <TenderReview
          key={review.id}
          tender={review}
          existing={existing}
          onClose={() => setReview(null)}
        />
      )}
    </>
  );
}
