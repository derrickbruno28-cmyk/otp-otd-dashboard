/**
 * Loads screen — the operational surface. Filter chips over the live load list,
 * load/stop table views with inline actual-time keying, reason + CF coding, and
 * entry points for Add Load / Import / Tender / CSV export.
 */
import { Fragment, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { atLeast, useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import {
  EMPTY_FILTERS, deleteLoad, missingReason, needsCfCoding, pendingActuals, updateLoad,
} from "../lib/loads";
import type { LoadFilters, Signer } from "../lib/loads";
import { isGhostShutdown } from "../lib/scoring";
import { fmtDateTime, fmtDwell, fmtVariance } from "../lib/format";
import { downloadCsv, loadsToSheetCsv, loadsToStopCsv } from "../lib/csv";
import { Chip, ConfirmDialog, EmptyState, GhostChip, StatusChip } from "../components/ui";
import { useToast } from "../components/Toast";
import { TimeInput } from "../components/TimeInput";
import { ReasonPicker } from "../components/ReasonPicker";
import { CfControl } from "../components/CfControl";
import { LoadDrawer } from "../components/LoadDrawer";
import { HistoryPanel } from "../components/HistoryPanel";
import { ImportModal } from "../components/ImportModal";
import { TenderZone } from "../components/TenderZone";
import type {
  CfCode, FailReason, Load, LoadStatus, OnTimeStatus, ReasonEntry, Stop,
} from "../lib/types";
import { LOAD_STATUSES, OPERATING_COMPANIES } from "../lib/types";

const PRIMARY_BTN = "px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50";
const GHOST_BTN = "px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2 disabled:opacity-50";
const INPUT = "bg-surface border border-rule rounded px-2 py-1 text-sm text-ink";
const TH = "px-2 py-2 text-left font-mono text-[11px] uppercase tracking-wide text-ink3 whitespace-nowrap";
const TD = "px-2 py-2 align-top";
const LOAD_COLS = 18;

const OT_STATUSES: OnTimeStatus[] = ["PENDING", "EARLY", "ON_TIME", "LATE"];
const STATUS_RANK: Record<OnTimeStatus, number> = { PENDING: 0, EARLY: 1, ON_TIME: 2, LATE: 3 };
const CF_LABEL: Record<CfCode, string> = { CF: "CF", NON_CF: "Non-CF", CF_CHALLENGE: "Challenge" };

type SortKey = "ls" | "pu" | "otp" | "otd";
interface SortState { key: SortKey; dir: 1 | -1; }
interface TimeEdit { loadId: string; seq: number; field: "actualArrival" | "actualDeparture"; }

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);
const halt = (e: ReactMouseEvent<HTMLElement>) => e.stopPropagation();

function firstPickup(l: Load): Stop | null {
  return l.stops.find((s) => s.type === "PICKUP") ?? null;
}
function finalDelivery(l: Load): Stop | null {
  const d = l.stops.filter((s) => s.type === "DELIVERY");
  return d.length ? d[d.length - 1] : null;
}
function hasDriverReason(l: Load, reasonsById: Record<string, FailReason>): boolean {
  return [...l.otpReasons, ...l.otdReasons].some((r) => reasonsById[r.reasonCode]?.category === "DRIVER");
}

function GoldChip({ active, onClick, title, children }: {
  active: boolean; onClick(): void; title?: string; children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-mono border whitespace-nowrap ${
        active ? "bg-brand text-brandInk border-brand" : "border-brand text-brand hover:bg-surface2"
      }`}
    >
      {children}
    </button>
  );
}

function SortTh({ label, k, sort, onSort }: {
  label: string; k: SortKey; sort: SortState | null; onSort(k: SortKey): void;
}) {
  const active = sort?.key === k;
  return (
    <th className={TH}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink ${active ? "text-ink" : ""}`}
      >
        {label}
        <span aria-hidden="true" className={active ? "" : "opacity-30"}>
          {active && sort!.dir === -1 ? "▼" : "▲"}
        </span>
      </button>
    </th>
  );
}

function FSelect({ label, value, onChange, options }: {
  label: string; value: string | null; onChange(v: string | null): void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={`Filter by ${label}`}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={INPUT}
    >
      <option value="">{label}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function CfMini({ label, value }: { label: string; value: CfCode | null }) {
  return (
    <span
      className="whitespace-nowrap"
      title={value === null ? "Not yet coded — this is a to-do, not a verdict" : undefined}
    >
      <span className="text-ink3">{label} </span>
      <span className={value === null ? "text-pending" : "text-ink"}>
        {value === null ? "No Flag" : CF_LABEL[value]}
      </span>
    </span>
  );
}

function StopTimeCell({ iso, timeZone, editing, canEdit, onStart, onCommit, onCancel, ariaLabel }: {
  iso: string | null; timeZone: string; editing: boolean; canEdit: boolean;
  onStart(): void; onCommit(next: string | null): void; onCancel(): void; ariaLabel: string;
}) {
  if (editing) {
    return (
      <TimeInput
        value={iso}
        timeZone={timeZone}
        onCommit={onCommit}
        onCancel={onCancel}
        autoFocus
        ariaLabel={ariaLabel}
      />
    );
  }
  if (!canEdit) {
    return <span className="font-mono text-xs tnum whitespace-nowrap">{fmtDateTime(iso, timeZone)}</span>;
  }
  return (
    <button
      type="button"
      onClick={onStart}
      aria-label={`Edit ${ariaLabel}`}
      className="font-mono text-xs tnum whitespace-nowrap px-1 py-0.5 rounded border border-transparent hover:border-ruleStrong hover:bg-surface2"
    >
      {fmtDateTime(iso, timeZone)}
    </button>
  );
}

export function LoadsScreen({ loads, filtered, filters, onFilters }: {
  loads: Load[]; filtered: Load[]; filters: LoadFilters; onFilters(f: LoadFilters): void;
}) {
  const { profile, role } = useAuth();
  const { customers, customersById, reasons, reasonsById } = useData();
  const toast = useToast();
  const ops = atLeast(role, "ops");
  const manager = atLeast(role, "manager");
  const canDelete = (l: Load) => manager || (ops && !!l.batchId);
  const [deleteAsk, setDeleteAsk] = useState<Load | null>(null);
  const doDelete = async () => {
    const l = deleteAsk;
    if (!l) return;
    setDeleteAsk(null);
    try {
      await deleteLoad(l.id!);
      toast.push("ok", `Load ${l.lsNumber} deleted`);
    } catch (e) {
      fail("Delete")(e);
    }
  };
  const signer: Signer = { uid: profile?.id ?? "", name: profile?.displayName ?? "" };

  const [view, setView] = useState<"load" | "stop">("load");
  const [sort, setSort] = useState<SortState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reasonEditId, setReasonEditId] = useState<string | null>(null);
  const [cfEditId, setCfEditId] = useState<string | null>(null);
  const [timeEdit, setTimeEdit] = useState<TimeEdit | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; initial: Load | null }>({ open: false, initial: null });
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [tenderOpen, setTenderOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const counts = useMemo(() => ({
    ghost: loads.filter((l) => isGhostShutdown(l)).length,
    needsCf: loads.filter((l) => needsCfCoding(l, customersById)).length,
    missing: loads.filter(missingReason).length,
    pending: loads.filter(pendingActuals).length,
  }), [loads, customersById]);

  const categories = useMemo(() => [...new Set(reasons.map((r) => r.category))], [reasons]);

  const rows = useMemo(() => {
    if (!sort) return filtered;
    const metric = (l: Load) => (sort.key === "otp" ? l.otp : l.otd);
    const val = (l: Load): string | number =>
      sort.key === "ls" ? l.lsNumber
        : sort.key === "pu" ? (l.firstPickupAppt ?? "9999")
          : STATUS_RANK[metric(l)?.status ?? "PENDING"] * 1e6 + (metric(l)?.varianceMin ?? 0);
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [filtered, sort]);

  const setF = (patch: Partial<LoadFilters>) => onFilters({ ...filters, ...patch });
  const toggleSort = (key: SortKey) =>
    setSort((s): SortState => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const toggleQuick = (q: NonNullable<LoadFilters["quick"]>) =>
    setF({ quick: filters.quick === q ? null : q });

  const fail = (what: string) => (e: unknown) => toast.push("error", `${what} failed: ${errMsg(e)}`);

  const saveStatus = (l: Load, status: LoadStatus) =>
    updateLoad(l.id!, { status }, signer, "manual").catch(fail("Status save"));
  const saveReasons = (l: Load, metric: "OTP" | "OTD", next: ReasonEntry[]) =>
    updateLoad(l.id!, metric === "OTP" ? { otpReasons: next } : { otdReasons: next }, signer, "manual")
      .catch(fail("Reason save"));
  const saveCf = (l: Load, metric: "otp" | "otd", v: CfCode | null) =>
    updateLoad(l.id!, { cf: { otp: l.cf?.otp ?? null, otd: l.cf?.otd ?? null, [metric]: v } }, signer, "manual")
      .catch(fail("CF save"));
  const closeTimeEditIfCurrent = (loadId: string, seq: number, field: TimeEdit["field"]) =>
    setTimeEdit((t) =>
      t && t.loadId === loadId && t.seq === seq && t.field === field ? null : t);
  const commitTime = async (l: Load, seq: number, field: TimeEdit["field"], next: string | null) => {
    const current = l.stops.find((s) => s.seq === seq)?.[field] ?? null;
    if ((next ?? null) === (current ?? null)) {
      // Unchanged: close without a pointless write.
      closeTimeEditIfCurrent(l.id!, seq, field);
      return;
    }
    const stops = l.stops.map((s) => (s.seq === seq ? { ...s, [field]: next } : s));
    // Close this cell's editor immediately — awaiting the server ack and then
    // clearing unconditionally would unmount whichever editor the user tabbed
    // into next, silently dropping their half-typed entry.
    closeTimeEditIfCurrent(l.id!, seq, field);
    try {
      await updateLoad(l.id!, { stops }, signer, "manual");
    } catch (e) {
      fail("Time save")(e);
      setTimeEdit({ loadId: l.id!, seq, field }); // reopen so the value isn't lost silently
    }
  };
  const isEditing = (l: Load, s: Stop, field: TimeEdit["field"]) =>
    timeEdit !== null && timeEdit.loadId === l.id && timeEdit.seq === s.seq && timeEdit.field === field;

  const stamp = new Date().toISOString().slice(0, 10);
  const exportSheet = () => {
    downloadCsv(`gh-loads-${stamp}.csv`, loadsToSheetCsv(rows, customersById));
    setExportOpen(false);
    toast.push("ok", `Exported ${rows.length} loads`);
  };
  const exportStops = () => {
    downloadCsv(`gh-stops-${stamp}.csv`, loadsToStopCsv(rows));
    setExportOpen(false);
    toast.push("ok", `Exported stops for ${rows.length} loads`);
  };

  const statusChipFor = (l: Load, metric: "OTP" | "OTD") => {
    const m = metric === "OTP" ? l.otp : l.otd;
    const st = m?.status ?? "PENDING";
    const chip = <StatusChip status={st} varianceMin={m?.varianceMin} />;
    if (!ops || st !== "LATE") return chip;
    return (
      <button
        type="button"
        title="Edit fail reasons"
        onClick={() => setReasonEditId(reasonEditId === l.id ? null : l.id!)}
      >
        {chip}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {/* customer + company chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={filters.customerId === null} onClick={() => setF({ customerId: null })}>All customers</Chip>
        {customers.map((c) => (
          <Chip key={c.id} active={filters.customerId === c.id} onClick={() => setF({ customerId: c.id! })}>
            {c.name}
          </Chip>
        ))}
        <span className="w-px h-5 bg-rule mx-1" aria-hidden="true" />
        <Chip active={filters.operatingCompany === null} onClick={() => setF({ operatingCompany: null })}>All companies</Chip>
        {OPERATING_COMPANIES.map((co) => (
          <Chip key={co} active={filters.operatingCompany === co} onClick={() => setF({ operatingCompany: co })}>
            {co}
          </Chip>
        ))}
      </div>

      {/* quick filters + search + range + selects */}
      <div className="flex flex-wrap items-center gap-2">
        <GoldChip
          active={filters.quick === "ghost"}
          onClick={() => toggleQuick("ghost")}
          title="USPS protocol: hourly customer updates until delivered"
        >
          Ghost Shutdown · {counts.ghost}
        </GoldChip>
        <Chip active={filters.quick === "needsCf"} onClick={() => toggleQuick("needsCf")}>
          Needs CF coding · {counts.needsCf}
        </Chip>
        <Chip active={filters.quick === "missingReason"} onClick={() => toggleQuick("missingReason")}>
          Missing reason · {counts.missing}
        </Chip>
        <Chip active={filters.quick === "pendingActuals"} onClick={() => toggleQuick("pendingActuals")}>
          Pending actuals · {counts.pending}
        </Chip>
        <input
          type="search"
          value={filters.search}
          onChange={(e) => setF({ search: e.target.value })}
          placeholder="Search LS#, load #, driver, city…"
          aria-label="Search loads"
          className={`${INPUT} min-w-[220px]`}
        />
        <label className="flex items-center gap-1 text-xs text-ink3">
          From
          <input
            type="date" value={filters.from ?? ""} aria-label="From date"
            onChange={(e) => setF({ from: e.target.value || null })} className={INPUT}
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-ink3">
          To
          <input
            type="date" value={filters.to ?? ""} aria-label="To date"
            onChange={(e) => setF({ to: e.target.value || null })} className={INPUT}
          />
        </label>
        <FSelect
          label="Status" value={filters.status} onChange={(v) => setF({ status: v })}
          options={LOAD_STATUSES.map((s) => ({ value: s, label: s }))}
        />
        <FSelect
          label="OTP" value={filters.otp} onChange={(v) => setF({ otp: v as OnTimeStatus | null })}
          options={OT_STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
        />
        <FSelect
          label="OTD" value={filters.otd} onChange={(v) => setF({ otd: v as OnTimeStatus | null })}
          options={OT_STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") }))}
        />
        <FSelect
          label="Reason" value={filters.reasonCode} onChange={(v) => setF({ reasonCode: v })}
          options={reasons.map((r) => ({ value: r.id!, label: r.label }))}
        />
        <FSelect
          label="Category" value={filters.reasonCategory} onChange={(v) => setF({ reasonCategory: v })}
          options={categories.map((c) => ({ value: c, label: c }))}
        />
        <button
          type="button"
          className="text-xs text-ink3 underline hover:text-ink"
          onClick={() => onFilters(EMPTY_FILTERS)}
        >
          Clear filters
        </button>
      </div>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded border border-ruleStrong overflow-hidden">
          <button
            type="button"
            onClick={() => setView("load")}
            className={`px-3 py-1.5 text-sm ${view === "load" ? "bg-surface2 text-ink font-semibold" : "text-ink2 hover:bg-surface2"}`}
          >
            Load view
          </button>
          <button
            type="button"
            onClick={() => setView("stop")}
            className={`px-3 py-1.5 text-sm ${view === "stop" ? "bg-surface2 text-ink font-semibold" : "text-ink2 hover:bg-surface2"}`}
          >
            Stop view
          </button>
        </div>
        <button
          type="button" className={PRIMARY_BTN} disabled={!ops}
          title={ops ? undefined : "Requires ops role"}
          onClick={() => setDrawer({ open: true, initial: null })}
        >
          + Add Load
        </button>
        <button
          type="button" className={GHOST_BTN} disabled={!ops}
          title={ops ? undefined : "Requires ops role"}
          onClick={() => setImportOpen(true)}
        >
          Import Excel
        </button>
        <button
          type="button" className={GHOST_BTN} disabled={!ops}
          title={ops ? undefined : "Requires ops role"}
          onClick={() => setTenderOpen(true)}
        >
          Drop tender
        </button>
        <div className="relative">
          <button type="button" className={GHOST_BTN} onClick={() => setExportOpen((o) => !o)}>
            Export CSV ▾
          </button>
          {exportOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
              <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-rule rounded-lg shadow-2xl min-w-[190px] py-1">
                <button type="button" className="block w-full text-left px-3 py-1.5 text-sm hover:bg-surface2" onClick={exportSheet}>
                  Sheet shape (per load)
                </button>
                <button type="button" className="block w-full text-left px-3 py-1.5 text-sm hover:bg-surface2" onClick={exportStops}>
                  Per stop
                </button>
              </div>
            </>
          )}
        </div>
        <span className="ml-auto text-xs font-mono text-ink3 tnum">
          {filtered.length} of {loads.length} loads
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No loads match the current filters" hint="Adjust the chips above, or clear filters." />
      ) : view === "load" ? (
        <div className="scroll-x bg-surface border border-rule rounded-lg">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-ruleStrong">
                <SortTh label="LS #" k="ls" sort={sort} onSort={toggleSort} />
                <th className={TH}>Load #</th>
                <th className={TH}>Ref #</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Co.</th>
                <th className={TH}>Stops</th>
                <th className={TH}>Lane</th>
                <SortTh label="PU appt / actual" k="pu" sort={sort} onSort={toggleSort} />
                <SortTh label="OTP" k="otp" sort={sort} onSort={toggleSort} />
                <th className={TH}>DEL appt / actual</th>
                <SortTh label="OTD" k="otd" sort={sort} onSort={toggleSort} />
                <th className={TH}>Reasons</th>
                <th className={TH}>CF</th>
                <th className={TH}>Drivers</th>
                <th className={TH}>Status</th>
                <th className={TH}><span className="sr-only">Edit</span></th>
                <th className={TH}><span className="sr-only">History</span></th>
                <th className={TH}><span className="sr-only">Delete</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const pu = firstPickup(l);
                const del = finalDelivery(l);
                const cust = customersById[l.customerId];
                const gold = hasDriverReason(l, reasonsById);
                const allReasons = [...l.otpReasons, ...l.otdReasons];
                return (
                  <Fragment key={l.id}>
                    <tr
                      className="border-t border-rule hover:bg-surface2/50 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === l.id ? null : l.id!)}
                    >
                      <td className={`${TD} font-mono whitespace-nowrap ${gold ? "text-brand font-semibold" : ""}`}>{l.lsNumber}</td>
                      <td className={`${TD} font-mono whitespace-nowrap`}>{l.loadNumber}</td>
                      <td className={`${TD} font-mono whitespace-nowrap`}>{l.referenceNumber || "—"}</td>
                      <td className={`${TD} whitespace-nowrap`}>{cust?.name ?? l.customerId}</td>
                      <td className={`${TD} font-mono`}>{l.operatingCompany}</td>
                      <td className={TD}>
                        <span className="inline-block px-1.5 py-0.5 rounded bg-surface2 text-ink2 text-[11px] font-mono whitespace-nowrap">
                          {l.stops.length} stops
                        </span>
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        {pu ? `${pu.city}, ${pu.state}` : "—"} → {del ? `${del.city}, ${del.state}` : "—"}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <div className="font-mono text-xs tnum">{fmtDateTime(pu?.appt, pu?.timeZone ?? "America/Chicago")}</div>
                        <div className="font-mono text-xs tnum text-ink3">{fmtDateTime(pu?.actualArrival, pu?.timeZone ?? "America/Chicago")}</div>
                      </td>
                      <td className={TD} onClick={halt}>{statusChipFor(l, "OTP")}</td>
                      <td className={`${TD} whitespace-nowrap`}>
                        <div className="font-mono text-xs tnum">{fmtDateTime(del?.appt, del?.timeZone ?? "America/Chicago")}</div>
                        <div className="font-mono text-xs tnum text-ink3">{fmtDateTime(del?.actualArrival, del?.timeZone ?? "America/Chicago")}</div>
                      </td>
                      <td className={TD} onClick={halt}>
                        <div className="flex flex-col items-start gap-1">
                          {statusChipFor(l, "OTD")}
                          {isGhostShutdown(l) && <GhostChip />}
                        </div>
                      </td>
                      <td className={TD} onClick={halt}>
                        <div className="flex flex-wrap items-center gap-1 max-w-[240px]">
                          {allReasons.map((r, i) => {
                            const meta = reasonsById[r.reasonCode];
                            const driver = meta?.category === "DRIVER";
                            return (
                              <span
                                key={`${r.reasonCode}_${i}`}
                                title={r.note || meta?.label}
                                className={`inline-block px-1.5 py-0.5 rounded-full border text-[11px] font-mono whitespace-nowrap ${
                                  driver ? "border-catDriver text-catDriver" : "border-rule text-ink2"
                                }`}
                              >
                                {meta?.label ?? r.reasonCode}
                              </span>
                            );
                          })}
                          {!ops && allReasons.length === 0 && <span className="text-ink3">—</span>}
                          {ops && (
                            <button
                              type="button"
                              className="text-[11px] font-mono text-ink3 underline hover:text-ink"
                              onClick={() => setReasonEditId(reasonEditId === l.id ? null : l.id!)}
                            >
                              {missingReason(l) ? "+ reason" : "edit"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className={TD} onClick={halt}>
                        {cust?.cfCodingEnabled ? (
                          cfEditId === l.id && ops ? (
                            <div className="space-y-1 min-w-[260px]">
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono text-ink3 w-8">OTP</span>
                                <CfControl value={l.cf?.otp ?? null} onChange={(v) => saveCf(l, "otp", v)} />
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-mono text-ink3 w-8">OTD</span>
                                <CfControl value={l.cf?.otd ?? null} onChange={(v) => saveCf(l, "otd", v)} />
                              </div>
                              <button
                                type="button"
                                className="text-[11px] font-mono text-ink3 underline hover:text-ink"
                                onClick={() => setCfEditId(null)}
                              >
                                Done
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={!ops}
                              title={ops ? "Edit CF coding" : "CF coding requires ops role"}
                              onClick={() => setCfEditId(l.id!)}
                              className="flex flex-col items-start gap-0.5 text-[11px] font-mono disabled:cursor-default"
                            >
                              <CfMini label="P" value={l.cf?.otp ?? null} />
                              <CfMini label="D" value={l.cf?.otd ?? null} />
                            </button>
                          )
                        ) : (
                          <span className="text-ink3">—</span>
                        )}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>
                        {l.primaryDriverName || "—"}
                        {l.secondaryDriverName ? ` / ${l.secondaryDriverName}` : ""}
                      </td>
                      <td className={TD} onClick={halt}>
                        <select
                          value={l.status}
                          disabled={!ops}
                          aria-label={`Status for ${l.lsNumber}`}
                          onChange={(e) => saveStatus(l, e.target.value as LoadStatus)}
                          className="bg-surface2 border border-rule rounded px-1.5 py-1 text-xs"
                        >
                          {LOAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className={TD} onClick={halt}>
                        <button
                          type="button" title="Edit load" aria-label={`Edit ${l.lsNumber}`}
                          className="px-1.5 py-0.5 rounded hover:bg-surface2"
                          onClick={() => setDrawer({ open: true, initial: l })}
                        >
                          ✎
                        </button>
                      </td>
                      <td className={TD} onClick={halt}>
                        <button
                          type="button" title="History" aria-label={`History for ${l.lsNumber}`}
                          className="px-1.5 py-0.5 rounded hover:bg-surface2"
                          onClick={() => setHistoryId(l.id!)}
                        >
                          🕘
                        </button>
                      </td>
                      <td className={TD} onClick={halt}>
                        <button
                          type="button"
                          title={canDelete(l) ? "Delete load"
                            : "Deleting needs the manager role (ops can delete imported loads)"}
                          aria-label={`Delete ${l.lsNumber}`}
                          disabled={!canDelete(l)}
                          className="px-1.5 py-0.5 rounded text-ink3 hover:bg-lateSoft hover:text-late disabled:opacity-30"
                          onClick={() => setDeleteAsk(l)}
                        >
                          🗑
                        </button>
                      </td>
                    </tr>

                    {reasonEditId === l.id && (
                      <tr className="bg-surface2/40">
                        <td colSpan={LOAD_COLS} className="px-4 py-3" onClick={halt}>
                          <div className="flex flex-wrap items-start gap-8">
                            <div>
                              <div className="text-xs font-mono uppercase tracking-wide text-ink3 mb-1">OTP reasons</div>
                              <ReasonPicker
                                metric="OTP"
                                entries={l.otpReasons}
                                onChange={(next) => saveReasons(l, "OTP", next)}
                                disabled={!ops}
                              />
                            </div>
                            <div>
                              <div className="text-xs font-mono uppercase tracking-wide text-ink3 mb-1">OTD reasons</div>
                              <ReasonPicker
                                metric="OTD"
                                entries={l.otdReasons}
                                onChange={(next) => saveReasons(l, "OTD", next)}
                                suggestCascade={(l.otp?.status ?? "PENDING") === "LATE"}
                                disabled={!ops}
                              />
                            </div>
                            <button type="button" className={GHOST_BTN} onClick={() => setReasonEditId(null)}>Done</button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {expandedId === l.id && (
                      <tr className="bg-surface2/40">
                        <td colSpan={LOAD_COLS} className="px-4 py-2" onClick={halt}>
                          <table className="w-full text-xs">
                            <thead>
                              <tr>
                                <th className={TH}>#</th>
                                <th className={TH}>Type</th>
                                <th className={TH}>Location</th>
                                <th className={TH}>City / State</th>
                                <th className={TH}>Appt</th>
                                <th className={TH}>Window close</th>
                                <th className={TH}>Actual arrival</th>
                                <th className={TH}>Actual departure</th>
                                <th className={TH}>Status</th>
                                <th className={TH}>Dwell</th>
                              </tr>
                            </thead>
                            <tbody>
                              {l.stops.map((s) => (
                                <tr key={s.seq} className="border-t border-rule">
                                  <td className={`${TD} font-mono tnum`}>{s.seq}</td>
                                  <td className={`${TD} font-mono`}>{s.type}</td>
                                  <td className={TD}>{s.locationName || "—"}</td>
                                  <td className={`${TD} whitespace-nowrap`}>{s.city}, {s.state}</td>
                                  <td className={`${TD} font-mono tnum whitespace-nowrap`}>{fmtDateTime(s.appt, s.timeZone)}</td>
                                  <td className={`${TD} font-mono tnum whitespace-nowrap`}>{fmtDateTime(s.apptEnd, s.timeZone)}</td>
                                  <td className={TD}>
                                    <StopTimeCell
                                      iso={s.actualArrival}
                                      timeZone={s.timeZone}
                                      editing={isEditing(l, s, "actualArrival")}
                                      canEdit={ops}
                                      onStart={() => setTimeEdit({ loadId: l.id!, seq: s.seq, field: "actualArrival" })}
                                      onCommit={(next) => commitTime(l, s.seq, "actualArrival", next)}
                                      onCancel={() => setTimeEdit(null)}
                                      ariaLabel={`${l.lsNumber} stop ${s.seq} actual arrival`}
                                    />
                                  </td>
                                  <td className={TD}>
                                    <StopTimeCell
                                      iso={s.actualDeparture}
                                      timeZone={s.timeZone}
                                      editing={isEditing(l, s, "actualDeparture")}
                                      canEdit={ops}
                                      onStart={() => setTimeEdit({ loadId: l.id!, seq: s.seq, field: "actualDeparture" })}
                                      onCommit={(next) => commitTime(l, s.seq, "actualDeparture", next)}
                                      onCancel={() => setTimeEdit(null)}
                                      ariaLabel={`${l.lsNumber} stop ${s.seq} actual departure`}
                                    />
                                  </td>
                                  <td className={TD}>
                                    <StatusChip status={s.onTime?.status ?? "PENDING"} varianceMin={s.onTime?.varianceMin} />
                                  </td>
                                  <td className={`${TD} tnum`}>{fmtDwell(s.dwellMin)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="scroll-x bg-surface border border-rule rounded-lg">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-ruleStrong">
                <th className={TH}>LS #</th>
                <th className={TH}>Load #</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Stop</th>
                <th className={TH}>Location</th>
                <th className={TH}>City / State</th>
                <th className={TH}>Appt</th>
                <th className={TH}>Window close</th>
                <th className={TH}>Actual arrival</th>
                <th className={TH}>Actual departure</th>
                <th className={TH}>Status</th>
                <th className={TH}>Variance</th>
                <th className={TH}>Dwell</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((l) =>
                l.stops.map((s) => (
                  <tr key={`${l.id}_${s.seq}`} className="border-t border-rule">
                    <td className={`${TD} font-mono whitespace-nowrap ${hasDriverReason(l, reasonsById) ? "text-brand font-semibold" : ""}`}>
                      {l.lsNumber}
                    </td>
                    <td className={`${TD} font-mono whitespace-nowrap`}>{l.loadNumber}</td>
                    <td className={`${TD} whitespace-nowrap`}>{customersById[l.customerId]?.name ?? l.customerId}</td>
                    <td className={`${TD} font-mono whitespace-nowrap`}>{s.seq} · {s.type}</td>
                    <td className={TD}>{s.locationName || "—"}</td>
                    <td className={`${TD} whitespace-nowrap`}>{s.city}, {s.state}</td>
                    <td className={`${TD} font-mono tnum whitespace-nowrap`}>{fmtDateTime(s.appt, s.timeZone)}</td>
                    <td className={`${TD} font-mono tnum whitespace-nowrap`}>{fmtDateTime(s.apptEnd, s.timeZone)}</td>
                    <td className={TD}>
                      <StopTimeCell
                        iso={s.actualArrival}
                        timeZone={s.timeZone}
                        editing={isEditing(l, s, "actualArrival")}
                        canEdit={ops}
                        onStart={() => setTimeEdit({ loadId: l.id!, seq: s.seq, field: "actualArrival" })}
                        onCommit={(next) => commitTime(l, s.seq, "actualArrival", next)}
                        onCancel={() => setTimeEdit(null)}
                        ariaLabel={`${l.lsNumber} stop ${s.seq} actual arrival`}
                      />
                    </td>
                    <td className={TD}>
                      <StopTimeCell
                        iso={s.actualDeparture}
                        timeZone={s.timeZone}
                        editing={isEditing(l, s, "actualDeparture")}
                        canEdit={ops}
                        onStart={() => setTimeEdit({ loadId: l.id!, seq: s.seq, field: "actualDeparture" })}
                        onCommit={(next) => commitTime(l, s.seq, "actualDeparture", next)}
                        onCancel={() => setTimeEdit(null)}
                        ariaLabel={`${l.lsNumber} stop ${s.seq} actual departure`}
                      />
                    </td>
                    <td className={TD}><StatusChip status={s.onTime?.status ?? "PENDING"} /></td>
                    <td className={`${TD} font-mono tnum`}>{fmtVariance(s.onTime?.varianceMin)}</td>
                    <td className={`${TD} tnum`}>{fmtDwell(s.dwellMin)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      <LoadDrawer
        open={drawer.open}
        initial={drawer.initial}
        existing={loads}
        onClose={() => setDrawer({ open: false, initial: null })}
      />
      <ConfirmDialog
        open={deleteAsk !== null}
        title="Delete load"
        body={deleteAsk ? `Delete load ${deleteAsk.lsNumber} (${deleteAsk.loadNumber})? Its edit history is retained, but the load leaves every scorecard and audit.` : ""}
        confirmLabel="Delete"
        danger
        onConfirm={doDelete}
        onCancel={() => setDeleteAsk(null)}
      />
      {historyId !== null && (
        <HistoryPanel loadId={historyId} open onClose={() => setHistoryId(null)} />
      )}
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} existing={loads} />
      <TenderZone open={tenderOpen} onClose={() => setTenderOpen(false)} existing={loads} />
    </div>
  );
}
