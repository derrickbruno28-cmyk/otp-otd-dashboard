import { useEffect, useMemo, useState } from "react";
import {
  addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { fmtDateTime, fmtPct, nowIso } from "../lib/format";
import { weekRangeLabel } from "../lib/scoring";
import { atLeast, useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { useToast } from "../components/Toast";
import { ImportDriversModal } from "../components/ImportDriversModal";
import {
  Chip, ConfirmDialog, Drawer, EmptyState, ErrorNote, Field, Section, Spinner,
} from "../components/ui";
import type {
  Driver, DriverCompany, DriverFlag, Load, OperatingCompany, ReasonEntry, ReviewState,
} from "../lib/types";
import { OPERATING_COMPANIES } from "../lib/types";

const REVIEW_LABEL: Record<ReviewState, string> = {
  NONE: "NO REVIEW",
  STEP_1_CALL: "STEP 1 — CALL",
  STEP_2_WRITE_UP: "STEP 2 — WRITE-UP",
};
const REVIEW_CLASS: Record<ReviewState, string> = {
  NONE: "bg-surface2 text-ink3",
  STEP_1_CALL: "bg-pendingSoft text-pending",
  STEP_2_WRITE_UP: "bg-lateSoft text-late",
};

function ReviewBadge({ state }: { state: ReviewState }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-mono whitespace-nowrap ${REVIEW_CLASS[state]}`}>
      {REVIEW_LABEL[state]}
    </span>
  );
}

/** allTime stores on-time/late only; the remainder of `loads` is pending (incl. EARLY not counted). */
function pendingOf(d: Driver, metric: "otp" | "otd"): number {
  const at = d.allTime;
  if (!at) return 0;
  const graded = metric === "otp" ? at.otpOnTime + at.otpLate : at.otdOnTime + at.otdLate;
  return Math.max(0, at.loads - graded);
}

function PctWithPending({ pct, pending }: { pct: number | null | undefined; pending: number }) {
  return (
    <span className="whitespace-nowrap">
      <span className="tnum">{fmtPct(pct ?? null)}</span>{" "}
      <span className="text-pending text-xs">({pending} pend)</span>
    </span>
  );
}

interface FailRow { load: Load; metric: "OTP" | "OTD"; reasons: ReasonEntry[]; }

const inputCls =
  "w-full bg-ground border border-ruleStrong rounded px-2 py-1.5 text-sm text-ink focus:outline-none focus:border-brand";

export function DriversScreen({ loads }: { loads: Load[] }) {
  const { profile, role } = useAuth();
  const { drivers, driversById, reasonsById, fleet } = useData();
  const toast = useToast();
  const canManage = atLeast(role, "manager");
  const canOps = atLeast(role, "ops");
  const tz = fleet.timeZone;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("active");
  const [coFilter, setCoFilter] = useState<OperatingCompany | null>(null);

  const listed = useMemo(() => drivers.filter((d) => {
    if (activeFilter === "active" && !d.active) return false;
    if (activeFilter === "inactive" && d.active) return false;
    if (coFilter && d.operatingCompany !== coFilter && d.operatingCompany !== "BOTH") return false;
    const needle = search.trim().toLowerCase();
    if (needle && !d.name.toLowerCase().includes(needle)) return false;
    return true;
  }), [drivers, activeFilter, coFilter, search]);

  const selected: Driver | null = selectedId ? driversById[selectedId] ?? null : null;

  /* ---- selected driver's loads, week rollup, fail history ---- */
  const driverLoads = useMemo(() => {
    if (!selectedId) return [];
    return loads.filter(
      (l) => l.primaryDriverId === selectedId || l.secondaryDriverId === selectedId,
    );
  }, [loads, selectedId]);

  const weekRows = useMemo(() => {
    const byWeek = new Map<string, { weekYear: number | null; weekNumber: number | null; loads: number; otpFails: number; otdFails: number }>();
    for (const l of driverLoads) {
      const key = l.weekYear != null && l.weekNumber != null ? `${l.weekYear}_${l.weekNumber}` : "—";
      const row = byWeek.get(key) ?? {
        weekYear: l.weekYear ?? null, weekNumber: l.weekNumber ?? null,
        loads: 0, otpFails: 0, otdFails: 0,
      };
      row.loads++;
      if (l.otp?.status === "LATE") row.otpFails++;
      if (l.otd?.status === "LATE") row.otdFails++;
      byWeek.set(key, row);
    }
    return [...byWeek.entries()]
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => (b.weekYear ?? 0) - (a.weekYear ?? 0) || (b.weekNumber ?? 0) - (a.weekNumber ?? 0));
  }, [driverLoads]);

  const failRows = useMemo(() => {
    const rows: FailRow[] = [];
    for (const l of driverLoads) {
      if (l.otp?.status === "LATE") rows.push({ load: l, metric: "OTP", reasons: l.otpReasons });
      if (l.otd?.status === "LATE") rows.push({ load: l, metric: "OTD", reasons: l.otdReasons });
    }
    return rows.sort((a, b) =>
      (b.load.firstPickupAppt ?? "").localeCompare(a.load.firstPickupAppt ?? ""));
  }, [driverLoads]);

  /* ---- driverFlags: subscribe only for the selected driver ---- */
  const [flags, setFlags] = useState<DriverFlag[] | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId) { setFlags(null); setFlagsError(null); return; }
    setFlags(null);
    setFlagsError(null);
    const q = query(
      collection(db, "driverFlags"),
      where("driverId", "==", selectedId),
      orderBy("weekYear", "desc"),
      orderBy("weekNumber", "desc"),
      limit(20),
    );
    return onSnapshot(
      q,
      (snap) => setFlags(snap.docs.map((d) => ({ id: d.id, ...(d.data() as DriverFlag) }))),
      (e) => setFlagsError(String(e?.message ?? e)),
    );
  }, [selectedId]);

  /* ---- confirm step ---- */
  const [confirm, setConfirm] = useState<{ flag: DriverFlag; step: ReviewState } | null>(null);
  const [confirming, setConfirming] = useState(false);
  async function doConfirm() {
    if (!confirm || !profile) return;
    const { flag, step } = confirm;
    setConfirming(true);
    try {
      // One atomic batch: a personnel action must never half-apply, leaving the
      // flag and the driver record contradicting each other.
      const batch = writeBatch(db);
      batch.update(doc(db, "driverFlags", flag.id!), {
        confirmedStep: step,
        confirmedBy: profile.id!,
        confirmedByName: profile.displayName,
        confirmedAt: nowIso(),
      });
      batch.update(doc(db, "drivers", flag.driverId), {
        reviewState: step,
        reviewedBy: profile.id!,
        reviewedByName: profile.displayName,
        reviewedAt: nowIso(),
      });
      await batch.commit();
      toast.push("ok", `${REVIEW_LABEL[step]} confirmed for ${flag.driverName}`);
    } catch (e) {
      toast.push("error", `Confirm failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setConfirming(false);
      setConfirm(null);
    }
  }

  /* ---- review notes ---- */
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  useEffect(() => {
    setNotes(selectedId ? driversById[selectedId]?.reviewNotes ?? "" : "");
    // reset only when the selection changes — live snapshots must not clobber typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  async function saveNotes() {
    if (!selected?.id) return;
    setSavingNotes(true);
    try {
      await updateDoc(doc(db, "drivers", selected.id), { reviewNotes: notes });
      toast.push("ok", "Review notes saved");
    } catch (e) {
      toast.push("error", `Saving notes failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setSavingNotes(false);
    }
  }

  /* ---- add driver ---- */
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState<Driver | null>(null);
  const canAdmin = atLeast(role, "admin");
  const toggleActive = async (d: Driver) => {
    try {
      await updateDoc(doc(db, "drivers", d.id!), { active: d.active === false });
      toast.push("ok", d.active === false ? `${d.name} reactivated` : `${d.name} deactivated — kept in history, hidden from pickers`);
    } catch (e) {
      toast.push("error", `Update failed: ${String((e as Error)?.message ?? e)}`);
    }
  };
  const doDeleteDriver = async () => {
    const d = deleteAsk;
    if (!d) return;
    setDeleteAsk(null);
    try {
      await deleteDoc(doc(db, "drivers", d.id!));
      if (selectedId === d.id) setSelectedId(null);
      toast.push("ok", `Driver ${d.name} deleted`);
    } catch (e) {
      toast.push("error", `Delete failed: ${String((e as Error)?.message ?? e)}`);
    }
  };
  const [newName, setNewName] = useState("");
  const [newCo, setNewCo] = useState<DriverCompany>("GH");
  const [adding, setAdding] = useState(false);
  async function addDriver() {
    const name = newName.trim();
    if (!name) { toast.push("error", "Driver name is required"); return; }
    setAdding(true);
    try {
      const ref = await addDoc(collection(db, "drivers"), {
        name,
        operatingCompany: newCo,
        active: true,
        reviewState: "NONE",
        reviewedBy: null,
        reviewedByName: null,
        reviewedAt: null,
        reviewNotes: "",
      });
      setSelectedId(ref.id);
      setAddOpen(false);
      setNewName("");
      toast.push("ok", `Driver "${name}" added`);
    } catch (e) {
      toast.push("error", `Add driver failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setAdding(false);
    }
  }

  const weekLabel = (wy: number | null, wn: number | null) =>
    wy != null && wn != null ? `Wk ${wn} · ${weekRangeLabel(wy, wn)}` : "No week";

  const reasonSpans = (reasons: ReasonEntry[]) =>
    reasons.length === 0 ? (
      <span className="text-ink3">— no reason entered</span>
    ) : (
      reasons.map((r, i) => {
        const fr = reasonsById[r.reasonCode];
        const driverCat = fr?.category === "DRIVER";
        return (
          <span key={`${r.reasonCode}_${i}`} className="block">
            <span className={driverCat ? "text-catDriver font-semibold" : "text-ink2"}>
              {fr?.label ?? r.reasonCode}
            </span>
            {r.note && <span className="text-ink3"> — {r.note}</span>}
          </span>
        );
      })
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[340px,1fr] items-start">
      {/* ---------------- left: driver list ---------------- */}
      <div className="bg-surface border border-rule rounded-lg">
        <div className="p-3 border-b border-rule space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search drivers…"
              aria-label="Search drivers"
              className={inputCls}
            />
            {canOps && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
              >
                + Add driver
              </button>
            )}
            {canOps && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2 whitespace-nowrap"
              >
                ⬆ Import
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={activeFilter === "active"} onClick={() => setActiveFilter("active")}>Active</Chip>
            <Chip active={activeFilter === "inactive"} onClick={() => setActiveFilter("inactive")}>Inactive</Chip>
            <Chip active={activeFilter === "all"} onClick={() => setActiveFilter("all")}>All</Chip>
            <span className="w-px h-5 bg-rule mx-1" aria-hidden="true" />
            <Chip active={coFilter === null} onClick={() => setCoFilter(null)}>All co.</Chip>
            {OPERATING_COMPANIES.map((co) => (
              <Chip key={co} active={coFilter === co} onClick={() => setCoFilter(coFilter === co ? null : co)}>
                {co}
              </Chip>
            ))}
          </div>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          {listed.length === 0 ? (
            <div className="p-3">
              <EmptyState title="No drivers match" hint="Adjust the search or filters." />
            </div>
          ) : listed.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setSelectedId(d.id!)}
              className={`w-full text-left px-3 py-2 border-b border-rule last:border-b-0 hover:bg-surface2 border-l-2 ${
                d.id === selectedId ? "bg-surface2 border-l-brand" : "border-l-transparent"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`font-semibold ${d.active ? "text-ink" : "text-ink3"}`}>{d.name}</span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-xs text-ink3">{d.operatingCompany}</span>
                  {d.reviewState !== "NONE" && <ReviewBadge state={d.reviewState} />}
                </span>
              </div>
              <div className="text-xs text-ink2 mt-0.5 flex flex-wrap gap-x-3">
                <span>OTP <PctWithPending pct={d.allTime?.otpPct} pending={pendingOf(d, "otp")} /></span>
                <span>OTD <PctWithPending pct={d.allTime?.otdPct} pending={pendingOf(d, "otd")} /></span>
                <span className="tnum">{d.allTime?.loads ?? 0} loads</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- right: detail ---------------- */}
      {!selected ? (
        <EmptyState title="Select a driver" hint="Pick a driver on the left to see stats, fail history, and review flags." />
      ) : (
        <div className="space-y-4 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="font-display font-semibold text-xl truncate">{selected.name}</h2>
              <span className="font-mono text-xs text-ink3">{selected.operatingCompany}</span>
              {selected.active === false && (
                <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-pendingSoft text-pending">inactive</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {canOps && (
                <button type="button" onClick={() => void toggleActive(selected)}
                  title={selected.active === false ? "Show in pickers again" : "A driver who left: history and stats stay, name leaves the pickers"}
                  className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2">
                  {selected.active === false ? "Reactivate" : "Deactivate"}
                </button>
              )}
              {canAdmin && (
                <button type="button" onClick={() => setDeleteAsk(selected)}
                  title="Remove the roster record entirely (for import mistakes) — loads keep the printed name"
                  className="px-3 py-1.5 rounded border border-late/40 text-late text-sm hover:bg-lateSoft">
                  🗑 Delete
                </button>
              )}
            </div>
          </div>
          {/* all-time tiles */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="bg-surface border border-rule rounded-lg p-3">
              <div className="text-xs font-mono uppercase tracking-wide text-ink3">All-time OTP</div>
              <div className="font-display font-bold text-3xl tnum">{fmtPct(selected.allTime?.otpPct ?? null)}</div>
              <div className="text-xs text-ink2 mt-1">
                {selected.allTime?.otpOnTime ?? 0} on time · {selected.allTime?.otpLate ?? 0} late ·{" "}
                <span className="text-pending">{pendingOf(selected, "otp")} pending</span>
              </div>
            </div>
            <div className="bg-surface border border-rule rounded-lg p-3">
              <div className="text-xs font-mono uppercase tracking-wide text-ink3">All-time OTD</div>
              <div className="font-display font-bold text-3xl tnum">{fmtPct(selected.allTime?.otdPct ?? null)}</div>
              <div className="text-xs text-ink2 mt-1">
                {selected.allTime?.otdOnTime ?? 0} on time · {selected.allTime?.otdLate ?? 0} late ·{" "}
                <span className="text-pending">{pendingOf(selected, "otd")} pending</span>
              </div>
            </div>
            <div className="bg-surface border border-rule rounded-lg p-3">
              <div className="text-xs font-mono uppercase tracking-wide text-ink3">Loads · Review</div>
              <div className="font-display font-bold text-3xl tnum">{selected.allTime?.loads ?? 0}</div>
              <div className="text-xs mt-1 flex items-center gap-1.5 flex-wrap">
                <ReviewBadge state={selected.reviewState} />
                {selected.reviewedAt && (
                  <span className="text-ink3">
                    by {selected.reviewedByName ?? "—"} · {fmtDateTime(selected.reviewedAt, tz)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* week-by-week */}
          <Section title="Week by week">
            {weekRows.length === 0 ? (
              <EmptyState title="No loads for this driver" hint="Loads with this driver assigned will appear here." />
            ) : (
              <div className="scroll-x">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-mono uppercase tracking-wide text-ink3 border-b border-rule">
                      <th className="py-1.5 pr-3">Week</th>
                      <th className="py-1.5 pr-3">Loads</th>
                      <th className="py-1.5 pr-3">OTP fails</th>
                      <th className="py-1.5">OTD fails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekRows.map((r) => (
                      <tr key={r.key} className="border-b border-rule last:border-b-0">
                        <td className="py-1.5 pr-3 font-mono text-xs">{weekLabel(r.weekYear, r.weekNumber)}</td>
                        <td className="py-1.5 pr-3 tnum">{r.loads}</td>
                        <td className={`py-1.5 pr-3 tnum ${r.otpFails ? "text-late" : "text-ink3"}`}>{r.otpFails}</td>
                        <td className={`py-1.5 tnum ${r.otdFails ? "text-late" : "text-ink3"}`}>{r.otdFails}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* fail history */}
          <Section title="Fail history">
            {failRows.length === 0 ? (
              <EmptyState title="No late loads" hint="Late OTP/OTD loads with this driver will appear here." />
            ) : (
              <div className="scroll-x">
                <table className="w-full text-sm align-top">
                  <thead>
                    <tr className="text-left text-xs font-mono uppercase tracking-wide text-ink3 border-b border-rule">
                      <th className="py-1.5 pr-3">LS #</th>
                      <th className="py-1.5 pr-3">Week</th>
                      <th className="py-1.5 pr-3">Metric</th>
                      <th className="py-1.5">Reasons</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failRows.map((row) => {
                      const driverCat = row.reasons.some((r) => reasonsById[r.reasonCode]?.category === "DRIVER");
                      return (
                        <tr key={`${row.load.id}_${row.metric}`} className="border-b border-rule last:border-b-0">
                          <td className={`py-1.5 pr-3 font-mono ${driverCat ? "text-catDriver font-semibold" : ""}`}>
                            {row.load.lsNumber}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">
                            {weekLabel(row.load.weekYear ?? null, row.load.weekNumber ?? null)}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-xs">{row.metric}</td>
                          <td className="py-1.5 text-xs">{reasonSpans(row.reasons)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* review panel */}
          <Section
            title="Review"
            right={<ReviewBadge state={selected.reviewState} />}
          >
            <div className="space-y-3">
              {flagsError && <ErrorNote message={`Flags failed to load: ${flagsError}`} />}
              {!flagsError && flags === null && <Spinner label="Loading flags…" />}
              {flags !== null && flags.length === 0 && (
                <p className="text-sm text-ink3">No flags proposed for this driver. Flags are proposed by the weekly evaluation (3+ fail reasons in a week) — never auto-escalated.</p>
              )}
              {flags?.map((f) => (
                <div key={f.id} className="border border-rule rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-mono text-xs">{weekLabel(f.weekYear, f.weekNumber)}</span>
                    <span className="text-xs text-ink2">
                      <span className="tnum font-semibold">{f.failCount}</span> fail reasons · proposed{" "}
                      <ReviewBadge state={f.proposedStep} />
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 mt-2">
                    {(["otpFails", "otdFails"] as const).map((k) => (
                      <div key={k} className="bg-surface2 rounded p-2">
                        <div className="text-xs font-mono uppercase text-ink3 mb-1">
                          {k === "otpFails" ? "OTP fails" : "OTD fails"}
                        </div>
                        {f[k].length === 0 ? (
                          <span className="text-xs text-ink3">None</span>
                        ) : (
                          f[k].map((e) => (
                            <div key={`${e.loadId}`} className="text-xs">
                              <span className="font-mono">{e.lsNumber}</span>
                              <span className="text-ink3"> — {e.reasons.join(", ") || "no reason entered"}</span>
                            </div>
                          ))
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {f.confirmedStep ? (
                      <span className="text-xs text-ink2 flex items-center gap-1.5 flex-wrap">
                        Confirmed <ReviewBadge state={f.confirmedStep} /> by {f.confirmedByName ?? "—"}
                        {f.confirmedAt && <span className="text-ink3">· {fmtDateTime(f.confirmedAt, tz)}</span>}
                      </span>
                    ) : canManage ? (
                      <>
                        <button
                          type="button"
                          disabled={confirming}
                          onClick={() => setConfirm({ flag: f, step: "STEP_1_CALL" })}
                          className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2 disabled:opacity-50"
                        >
                          Confirm Step 1 — Call
                        </button>
                        <button
                          type="button"
                          disabled={confirming}
                          onClick={() => setConfirm({ flag: f, step: "STEP_2_WRITE_UP" })}
                          className="px-3 py-1.5 rounded text-late border border-late/40 text-sm hover:bg-lateSoft disabled:opacity-50"
                        >
                          Confirm Step 2 — Write-Up
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-ink3">Awaiting manager confirmation.</span>
                    )}
                  </div>
                </div>
              ))}

              <Field label="Review notes" hint={canManage ? undefined : "Manager or admin role required to edit."}>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={!canManage}
                  rows={3}
                  className={`${inputCls} disabled:opacity-60`}
                  placeholder="Coaching notes, call summaries, follow-ups…"
                />
              </Field>
              {canManage && (
                <button
                  type="button"
                  onClick={saveNotes}
                  disabled={savingNotes || notes === (selected.reviewNotes ?? "")}
                  className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {savingNotes ? "Saving…" : "Save notes"}
                </button>
              )}
            </div>
          </Section>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.step === "STEP_2_WRITE_UP" ? "Confirm write-up" : "Confirm coaching call"}
        body={
          confirm?.step === "STEP_2_WRITE_UP"
            ? `A write-up is a personnel action. Confirm STEP_2_WRITE_UP for ${confirm?.flag.driverName ?? ""}?`
            : `Confirm STEP_1_CALL for ${confirm?.flag.driverName ?? ""}? This records a coaching call — nothing escalates automatically.`
        }
        confirmLabel={confirming ? "Confirming…" : confirm?.step === "STEP_2_WRITE_UP" ? "Confirm write-up" : "Confirm call"}
        danger={confirm?.step === "STEP_2_WRITE_UP"}
        onConfirm={doConfirm}
        onCancel={() => { if (!confirming) setConfirm(null); }}
      />

      <ConfirmDialog
        open={deleteAsk !== null}
        title="Delete driver"
        body={deleteAsk ? `Delete ${deleteAsk.name} from the roster? Their name stays on existing loads and past audits, but their record, all-time stats, and review history are removed. For a driver who left the company, Deactivate is usually the right choice instead.` : ""}
        confirmLabel="Delete driver"
        danger
        onConfirm={doDeleteDriver}
        onCancel={() => setDeleteAsk(null)}
      />
      <ImportDriversModal open={importOpen} onClose={() => setImportOpen(false)} existing={drivers} />
      <Drawer open={addOpen} onClose={() => setAddOpen(false)} title="Add driver" width="min(420px,100vw)">
        <div className="space-y-3">
          <Field label="Name">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              className={inputCls}
              placeholder="Driver name"
            />
          </Field>
          <Field label="Operating company">
            <select
              value={newCo}
              onChange={(e) => setNewCo(e.target.value as DriverCompany)}
              className={inputCls}
            >
              {OPERATING_COMPANIES.map((co) => <option key={co} value={co}>{co}</option>)}
              <option value="BOTH">Both — AJG and GH</option>
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={addDriver}
              disabled={adding || !newName.trim()}
              className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {adding ? "Adding…" : "Add driver"}
            </button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
