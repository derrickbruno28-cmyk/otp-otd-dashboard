import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { createLoad, updateLoad, type Signer } from "../lib/loads";
import { timeZoneForState, tzAbbr } from "../lib/format";
import type { CustomerId, Load, Stop, StopType } from "../lib/types";
import { LOAD_STATUSES, OPERATING_COMPANIES } from "../lib/types";
import { Drawer, ErrorNote, Field } from "./ui";
import { DriverPicker } from "./DriverPicker";
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

function emptyStop(seq: number, type: StopType): Stop {
  return {
    seq, type, locationName: "", address: "", city: "", state: "", zip: "",
    timeZone: "America/Chicago",
    appt: null, apptEnd: null, actualArrival: null, actualDeparture: null,
  };
}

function emptyLoad(): Load {
  return {
    lsNumber: "", loadNumber: "", referenceNumber: "",
    customerId: "" as CustomerId, // blank until chosen — validation blocks save
    operatingCompany: "GH",
    equipmentType: "", status: "Tendered",
    pieces: null, weightLbs: null, billingMiles: null, commodity: "",
    stops: [emptyStop(1, "PICKUP"), emptyStop(2, "DELIVERY")],
    primaryDriverId: null, secondaryDriverId: null,
    primaryDriverName: "", secondaryDriverName: "",
    truckNumber: "", runType: "", tripNumber: "", isShuttleLeg: false,
    otpReasons: [], otdReasons: [],
    cf: { otp: null, otd: null },
  };
}

function numOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validate(d: Load): string[] {
  const out: string[] = [];
  if (!d.lsNumber.trim()) out.push("LS # is required.");
  if (!d.loadNumber.trim()) out.push("Load # is required.");
  if (!d.customerId) out.push("Customer is required.");
  if (!d.stops.some((s) => s.type === "PICKUP")) out.push("At least one PICKUP stop is required.");
  if (!d.stops.some((s) => s.type === "DELIVERY")) out.push("At least one DELIVERY stop is required.");
  return out;
}

export function LoadDrawer({ open, initial, onClose, existing }: {
  open: boolean;
  initial: Load | null;
  onClose(): void;
  existing?: Load[];
}) {
  const { profile } = useAuth();
  const { customers, drivers } = useData();
  const toast = useToast();

  const [draft, setDraft] = useState<Load>(() => initial ?? emptyLoad());
  const [problems, setProblems] = useState<string[]>([]);
  const [saveAnyway, setSaveAnyway] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(initial ? { ...initial, stops: initial.stops.map((s) => ({ ...s })) } : emptyLoad());
    setProblems([]);
    setSaveAnyway(false);
    setSaving(false);
  }, [open, initial]);

  const duplicate = useMemo(() => {
    if (initial || !existing) return false;
    const ln = draft.loadNumber.trim().toLowerCase();
    if (!ln || !draft.customerId) return false;
    return existing.some(
      (l) => l.customerId === draft.customerId && l.loadNumber.trim().toLowerCase() === ln,
    );
  }, [initial, existing, draft.loadNumber, draft.customerId]);

  const patch = (p: Partial<Load>) => setDraft((d) => ({ ...d, ...p }));
  const patchStop = (idx: number, p: Partial<Stop>) =>
    setDraft((d) => ({ ...d, stops: d.stops.map((s, i) => (i === idx ? { ...s, ...p } : s)) }));
  const renumber = (stops: Stop[]) => stops.map((s, i) => ({ ...s, seq: i + 1 }));
  const addStop = () =>
    setDraft((d) => ({ ...d, stops: renumber([...d.stops, emptyStop(d.stops.length + 1, "DELIVERY")]) }));
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

  const setDriver = (slot: "primary" | "secondary", id: string) => {
    const name = drivers.find((dr) => dr.id === id)?.name ?? "";
    if (slot === "primary") patch({ primaryDriverId: id || null, primaryDriverName: id ? name : "" });
    else patch({ secondaryDriverId: id || null, secondaryDriverName: id ? name : "" });
  };

  const save = async () => {
    const errs = validate(draft);
    if (duplicate && !saveAnyway) errs.push("Load number already exists for this customer — check “Save anyway” to proceed.");
    setProblems(errs);
    if (errs.length) return;
    if (!profile?.id) { toast.push("error", "Not signed in."); return; }
    const signer: Signer = { uid: profile.id, name: profile.displayName };
    // Strip client-computed stop grades; the Cloud Function rewrites canonical grades.
    const stops = draft.stops.map(({ onTime, dwellMin, ...s }, i) => ({ ...s, seq: i + 1 }));
    setSaving(true);
    try {
      if (initial?.id) {
        await updateLoad(initial.id, { ...draft, stops }, signer, "manual");
        toast.push("ok", `Load ${draft.lsNumber} updated`);
      } else {
        await createLoad({ ...draft, stops }, signer, "manual");
        toast.push("ok", `Load ${draft.lsNumber} created`);
      }
      onClose();
    } catch (e: unknown) {
      const msg = String((e as Error)?.message ?? e);
      toast.push("error", `Save failed: ${msg}`);
      setProblems([`Save failed: ${msg}`]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={initial ? `Edit load ${initial.lsNumber || ""}`.trim() : "Add load"}
      width="min(760px,100vw)"
    >
      <div className="space-y-4">
        {problems.length > 0 && <ErrorNote message={problems.join(" ")} />}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="LS #">
            <input className={`${INPUT} font-mono`} value={draft.lsNumber}
              onChange={(e) => patch({ lsNumber: e.target.value })} />
          </Field>
          <Field label="Load #">
            <input className={`${INPUT} font-mono`} value={draft.loadNumber}
              onChange={(e) => patch({ loadNumber: e.target.value })} />
          </Field>
          <Field label="Reference #">
            <input className={`${INPUT} font-mono`} value={draft.referenceNumber}
              onChange={(e) => patch({ referenceNumber: e.target.value })} />
          </Field>
        </div>

        {duplicate && (
          <div className="border border-late/40 bg-lateSoft rounded-lg px-3 py-2 text-sm text-late">
            Load number already exists for this customer.
            <label className="flex items-center gap-2 mt-1 text-ink2">
              <input type="checkbox" checked={saveAnyway} onChange={(e) => setSaveAnyway(e.target.checked)} />
              Save anyway
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Customer">
            <select className={INPUT} value={draft.customerId}
              onChange={(e) => patch({ customerId: e.target.value as CustomerId })}>
              <option value="">— select customer —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
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

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Equipment type">
            <input className={INPUT} value={draft.equipmentType}
              onChange={(e) => patch({ equipmentType: e.target.value })} />
          </Field>
          <Field label="Pieces">
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.pieces ?? ""}
              onChange={(e) => patch({ pieces: numOrNull(e.target.value) })} />
          </Field>
          <Field label="Weight (lbs)">
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.weightLbs ?? ""}
              onChange={(e) => patch({ weightLbs: numOrNull(e.target.value) })} />
          </Field>
          <Field label="Billing miles">
            <input type="number" min={0} className={`${INPUT} tnum`} value={draft.billingMiles ?? ""}
              onChange={(e) => patch({ billingMiles: numOrNull(e.target.value) })} />
          </Field>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Commodity">
            <input className={INPUT} value={draft.commodity}
              onChange={(e) => patch({ commodity: e.target.value })} />
          </Field>
          <Field label="Truck #">
            <input className={`${INPUT} font-mono`} value={draft.truckNumber}
              onChange={(e) => patch({ truckNumber: e.target.value })} />
          </Field>
          <Field label="Trip #">
            <input className={`${INPUT} font-mono`} value={draft.tripNumber}
              onChange={(e) => patch({ tripNumber: e.target.value })} />
          </Field>
          <Field label="Run type">
            <input className={INPUT} value={draft.runType}
              onChange={(e) => patch({ runType: e.target.value })} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 items-end">
          <DriverPicker label="Primary driver" company={draft.operatingCompany}
            value={draft.primaryDriverId} name={draft.primaryDriverName}
            onChange={({ id, name }) => patch({ primaryDriverId: id, primaryDriverName: name })} />
          <DriverPicker label="Secondary driver" company={draft.operatingCompany}
            value={draft.secondaryDriverId} name={draft.secondaryDriverName}
            onChange={({ id, name }) => patch({ secondaryDriverId: id, secondaryDriverName: name })} />
        </div>

        <label className="flex items-center gap-2 text-sm text-ink2">
          <input type="checkbox" checked={draft.isShuttleLeg}
            onChange={(e) => patch({ isShuttleLeg: e.target.checked })} />
          Shuttle leg — excluded from CF breakdown, still scored
        </label>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display font-semibold">Stops</h3>
            <button type="button" onClick={addStop}
              className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
              + Add stop
            </button>
          </div>

          {draft.stops.map((s, i) => (
            <div key={i} className="border border-rule rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs uppercase tracking-wide text-ink3">
                  Stop {s.seq} — {s.type}
                </span>
                <span className="flex items-center gap-1">
                  <button type="button" title="Move up" aria-label={`Move stop ${s.seq} up`}
                    className={MINI_BTN} disabled={i === 0} onClick={() => moveStop(i, -1)}>↑</button>
                  <button type="button" title="Move down" aria-label={`Move stop ${s.seq} down`}
                    className={MINI_BTN} disabled={i === draft.stops.length - 1} onClick={() => moveStop(i, 1)}>↓</button>
                  <button type="button" title={draft.stops.length <= 2 ? "A load needs at least 2 stops" : "Remove stop"}
                    aria-label={`Remove stop ${s.seq}`}
                    className={`${MINI_BTN} text-late border-late/40`}
                    disabled={draft.stops.length <= 2} onClick={() => removeStop(i)}>✕</button>
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Field label="Type">
                  <select className={INPUT} value={s.type}
                    onChange={(e) => patchStop(i, { type: e.target.value as StopType })}>
                    <option value="PICKUP">PICKUP</option>
                    <option value="DELIVERY">DELIVERY</option>
                  </select>
                </Field>
                <Field label="Location name">
                  <input className={INPUT} value={s.locationName}
                    onChange={(e) => patchStop(i, { locationName: e.target.value })} />
                </Field>
                <Field label="Address">
                  <input className={INPUT} value={s.address}
                    onChange={(e) => patchStop(i, { address: e.target.value })} />
                </Field>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="City">
                  <input className={INPUT} value={s.city}
                    onChange={(e) => patchStop(i, { city: e.target.value })} />
                </Field>
                <Field label="State">
                  <input className={`${INPUT} font-mono uppercase`} maxLength={2} value={s.state}
                    onChange={(e) => {
                      const st = e.target.value.toUpperCase();
                      patchStop(i, st.length === 2
                        ? { state: st, timeZone: timeZoneForState(st) }
                        : { state: st });
                    }} />
                </Field>
                <Field label="Zip">
                  <input className={`${INPUT} font-mono`} value={s.zip}
                    onChange={(e) => patchStop(i, { zip: e.target.value })} />
                </Field>
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
                <Field label="Appointment">
                  <TimeInput value={s.appt} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} appointment`}
                    onCommit={(next) => patchStop(i, { appt: next })} />
                </Field>
                <Field label="Window close" hint="Normally empty — only for appointment windows.">
                  <TimeInput value={s.apptEnd} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} window close`}
                    onCommit={(next) => patchStop(i, { apptEnd: next })} />
                </Field>
                <Field label="Actual arrival">
                  <TimeInput value={s.actualArrival} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} actual arrival`}
                    onCommit={(next) => patchStop(i, { actualArrival: next })} />
                </Field>
                <Field label="Actual departure">
                  <TimeInput value={s.actualDeparture} timeZone={s.timeZone}
                    ariaLabel={`Stop ${s.seq} actual departure`}
                    onCommit={(next) => patchStop(i, { actualDeparture: next })} />
                </Field>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-rule">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50">
            {saving ? "Saving…" : initial ? "Save changes" : "Create load"}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
