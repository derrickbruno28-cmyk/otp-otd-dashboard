/**
 * Weekly OTP/OTD audit. Computed client-side from the live loads by default (works before
 * any snapshot exists); "Generate & save snapshot" calls the generateWeeklyAudit callable
 * and renders its result through the exact same component — the math here mirrors
 * functions/src/weeklyAudit.ts and the WeeklyAudit type field-for-field.
 */
import { useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase";
import { useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { useToast } from "../components/Toast";
import { EmptyState, Section } from "../components/ui";
import { fmtDateTime, fmtGapPts, fmtPct, nowIso } from "../lib/format";
import {
  dayNumberToUtcDate, effectiveTarget, gapPoints, summarizeMetric,
  weekDayRange, weekOf, weekRangeLabel,
} from "../lib/scoring";
import { pendingActuals } from "../lib/loads";
import type {
  AuditFailEntry, AuditFlaggedDriver, AuditMetricRow, AuditReasonIndexRow,
  AuditReasonRow, CfBreakdownRow, Customer, CustomerId, Driver, FailReason,
  FleetSettings, Load, OperatingCompany, WeeklyAudit,
} from "../lib/types";
import { OPERATING_COMPANIES } from "../lib/types";

const NO_FLAG_NOTE =
  "No Flag = no CF/Non-CF determination has been entered — a to-do, not a verdict.";

/* ------------------------------------------------------------------ */
/* Client-side computation — mirrors functions/src/weeklyAudit.ts.     */
/* ------------------------------------------------------------------ */

interface ComputeArgs {
  loads: Load[];
  weekYear: number;
  weekNumber: number;
  customerId: CustomerId | null;
  operatingCompany: OperatingCompany | null;
  customersById: Record<string, Customer>;
  reasonsById: Record<string, FailReason>;
  driversById: Record<string, Driver>;
  fleet: FleetSettings;
  generatedBy: string;
  generatedByName: string;
}

interface FlagAcc {
  driverId: string; driverName: string;
  teamNames: Set<string>;
  otpFails: AuditFailEntry[]; otdFails: AuditFailEntry[];
}

function crewOf(l: Load): { id: string; name: string }[] {
  const crew: { id: string; name: string }[] = [];
  if (l.primaryDriverId) crew.push({ id: l.primaryDriverId, name: l.primaryDriverName || "Unknown" });
  if (l.secondaryDriverId && l.secondaryDriverId !== l.primaryDriverId) {
    crew.push({ id: l.secondaryDriverId, name: l.secondaryDriverName || "Unknown" });
  }
  return crew;
}

/** Per-driver fail-entry accumulation — teams credit both drivers with the same load. */
function flagAccumulate(list: Load[], reasonsById: Record<string, FailReason>): Map<string, FlagAcc> {
  const map = new Map<string, FlagAcc>();
  for (const l of list) {
    const crew = crewOf(l);
    if (!crew.length) continue;
    for (const metric of ["otp", "otd"] as const) {
      if (l[metric]?.status !== "LATE") continue;
      const reasons = metric === "otp" ? l.otpReasons : l.otdReasons;
      if (!reasons.length) continue;
      for (const d of crew) {
        let acc = map.get(d.id);
        if (!acc) {
          acc = { driverId: d.id, driverName: d.name, teamNames: new Set(), otpFails: [], otdFails: [] };
          map.set(d.id, acc);
        }
        for (const mate of crew) if (mate.id !== d.id) acc.teamNames.add(mate.name);
        const box = metric === "otp" ? acc.otpFails : acc.otdFails;
        for (const r of reasons) {
          const meta = reasonsById[r.reasonCode];
          box.push({
            lsNumber: l.lsNumber,
            reasonLabel: meta?.label ?? r.reasonCode,
            category: meta?.category ?? "EXTERNAL",
            note: r.note,
          });
        }
      }
    }
  }
  return map;
}

function computeAudit(a: ComputeArgs): WeeklyAudit {
  const {
    loads, weekYear, weekNumber, customerId, operatingCompany,
    customersById, reasonsById, driversById, fleet,
  } = a;
  const inScope = (l: Load) =>
    (!customerId || l.customerId === customerId) &&
    (!operatingCompany || l.operatingCompany === operatingCompany);
  const weekLoads = loads.filter(
    (l) => l.weekYear === weekYear && l.weekNumber === weekNumber && inScope(l),
  );
  const { startDay } = weekDayRange(weekYear, weekNumber);
  // Previous week via day-number math — handles the year boundary.
  const prev = weekOf(dayNumberToUtcDate(startDay - 7).toISOString(), "UTC");
  const prevLoads = loads.filter(
    (l) => l.weekYear === prev.weekYear && l.weekNumber === prev.weekNumber && inScope(l),
  );

  const scopeCustomer = customerId ? customersById[customerId] ?? null : null;
  const metricRow = (list: Load[], metric: "otp" | "otd"): AuditMetricRow => {
    const s = summarizeMetric(list, metric, customersById);
    const target = effectiveTarget(metric, scopeCustomer, fleet);
    // EARLY-counted-as-miss folds into `late` so onTime + late = the denominator.
    return { onTime: s.onTime, late: s.late + s.earlyAsMiss, rate: s.rate, target, gapPts: gapPoints(s.rate, target) };
  };
  const otpRow = metricRow(weekLoads, "otp");
  const otdRow = metricRow(weekLoads, "otd");
  const pending = weekLoads.filter(pendingActuals).length;
  const totalScored = weekLoads.length - pending;

  const wowPrev = prevLoads.length
    ? (() => {
        const po = metricRow(prevLoads, "otp");
        const pd = metricRow(prevLoads, "otd");
        return {
          otpPct: po.rate, otpLate: po.late, otdPct: pd.rate, otdLate: pd.late,
          totalScored: prevLoads.filter((l) => !pendingActuals(l)).length,
          pending: prevLoads.filter(pendingActuals).length,
        };
      })()
    : null;

  const uspsInScope = customerId === null || customerId === "usps";
  const cfFor = (metric: "otp" | "otd"): { row: CfBreakdownRow; shuttle: number } => {
    const late = weekLoads.filter((l) => l.customerId === "usps" && l[metric]?.status === "LATE");
    const shuttle = late.filter((l) => l.isShuttleLeg).length;
    const scored = late.filter((l) => !l.isShuttleLeg);
    const code = (l: Load) => l.cf?.[metric] ?? null;
    return {
      shuttle,
      row: {
        lateTotal: scored.length,
        cf: scored.filter((l) => code(l) === "CF").length,
        nonCf: scored.filter((l) => code(l) === "NON_CF").length,
        noFlag: scored.filter((l) => code(l) === null).length,
        cfChallenge: scored.filter((l) => code(l) === "CF_CHALLENGE").length,
      },
    };
  };
  const cfOtp = uspsInScope ? cfFor("otp") : null;
  const cfOtd = uspsInScope ? cfFor("otd") : null;

  const reasonAgg = (metric: "otp" | "otd") => {
    const late = weekLoads.filter((l) => l[metric]?.status === "LATE");
    const byCode = new Map<string, { count: number; entries: { lsNumber: string; driverNames: string }[] }>();
    for (const l of late) {
      const names = [l.primaryDriverName, l.secondaryDriverName].filter(Boolean).join(" / ") || "—";
      const reasons = metric === "otp" ? l.otpReasons : l.otdReasons;
      for (const r of reasons) {
        const cur = byCode.get(r.reasonCode) ?? { count: 0, entries: [] };
        cur.count += 1;
        cur.entries.push({ lsNumber: l.lsNumber, driverNames: names });
        byCode.set(r.reasonCode, cur);
      }
    }
    const sorted = [...byCode.entries()].sort((x, y) => y[1].count - x[1].count);
    const rows: AuditReasonRow[] = [];
    const index: AuditReasonIndexRow[] = [];
    let rank = 0, prevCount = -1;
    sorted.forEach(([codeKey, agg], i) => {
      if (agg.count !== prevCount) { rank = i + 1; prevCount = agg.count; } // ties share a rank
      const meta = reasonsById[codeKey];
      const label = meta?.label ?? codeKey;
      const category = meta?.category ?? "EXTERNAL";
      rows.push({ rank, label, category, count: agg.count });
      index.push({ label, category, count: agg.count, entries: agg.entries });
    });
    return { rows, index };
  };
  const otpReasons = reasonAgg("otp");
  const otdReasons = reasonAgg("otd");

  const curAcc = flagAccumulate(weekLoads, reasonsById);
  const prevFlaggedIds = new Set(
    [...flagAccumulate(prevLoads, reasonsById).values()]
      .filter((x) => x.otpFails.length + x.otdFails.length >= 3)
      .map((x) => x.driverId),
  );
  const flaggedDrivers: AuditFlaggedDriver[] = [...curAcc.values()]
    .map((x) => ({ acc: x, failCount: x.otpFails.length + x.otdFails.length }))
    .filter((x) => x.failCount >= 3)
    .sort((x, y) => y.failCount - x.failCount)
    .map(({ acc, failCount }) => {
      const at = driversById[acc.driverId]?.allTime;
      const repeat = prevFlaggedIds.has(acc.driverId);
      return {
        driverId: acc.driverId, driverName: acc.driverName, teamNames: [...acc.teamNames],
        failCount,
        allTime: { otpPct: at?.otpPct ?? null, otdPct: at?.otdPct ?? null, loads: at?.loads ?? 0 },
        otpFails: acc.otpFails, otdFails: acc.otdFails,
        repeatFromPrevWeek: repeat,
        proposedStep: repeat ? "STEP_2_WRITE_UP" as const : "STEP_1_CALL" as const,
      };
    });
  const repeatIds = new Set(flaggedDrivers.filter((d) => d.repeatFromPrevWeek).map((d) => d.driverId));
  const flaggedIds = new Set(flaggedDrivers.map((d) => d.driverId));

  // MTD = the month of the week's Sunday; drivers counted individually here.
  const monthKey = weekOf(dayNumberToUtcDate(startDay).toISOString(), "UTC").monthKey;
  const mtdLoads = loads.filter((l) => l.monthKey === monthKey && inScope(l));
  const perf = new Map<string, { driverId: string; driverName: string; loadsMtd: number; otpFails: number; otdFails: number }>();
  for (const l of mtdLoads) {
    for (const d of crewOf(l)) {
      let p = perf.get(d.id);
      if (!p) { p = { driverId: d.id, driverName: d.name, loadsMtd: 0, otpFails: 0, otdFails: 0 }; perf.set(d.id, p); }
      p.loadsMtd += 1;
      if (l.otp?.status === "LATE") p.otpFails += 1;
      if (l.otd?.status === "LATE") p.otdFails += 1;
    }
  }
  const worstPerformersMtd = [...perf.values()]
    .filter((p) => p.loadsMtd >= 3)
    .map((p) => ({ ...p, totalLate: p.otpFails + p.otdFails }))
    .filter((p) => p.totalLate > 0)
    .sort((x, y) => y.totalLate - x.totalLate)
    .slice(0, 10)
    .map((p) => ({
      ...p,
      // Mirrors generateWeeklyAudit: an alert implies a proposed SOP step, so a
      // driver who was never flagged this week gets a blank cell — not "Step 1".
      alert: flaggedIds.has(p.driverId)
        ? repeatIds.has(p.driverId)
          ? `Monitoring — Step 1 Call/Action | Week ${weekNumber} Repeat → Step 2`
          : "Monitoring — Step 1 Call/Action"
        : "",
    }));

  return {
    weekYear, weekNumber,
    scope: { customerId, operatingCompany },
    rangeLabel: weekRangeLabel(weekYear, weekNumber),
    generatedAt: nowIso(),
    generatedBy: a.generatedBy,
    generatedByName: a.generatedByName,
    scorecard: {
      otp: otpRow, otd: otdRow, totalScored, pending,
      wow: { prev: wowPrev },
      cfBreakdown: {
        otp: cfOtp?.row ?? null, otd: cfOtd?.row ?? null,
        shuttleExcluded: { otp: cfOtp?.shuttle ?? 0, otd: cfOtd?.shuttle ?? 0 },
      },
    },
    topFailReasons: { otp: otpReasons.rows, otd: otdReasons.rows },
    flaggedDrivers,
    worstPerformersMtd,
    reasonIndex: { otp: otpReasons.index, otd: otdReasons.index },
  };
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

const TH = "px-3 py-1.5 text-left text-[11px] font-mono uppercase tracking-wide text-ink3";
const TD = "px-3 py-1.5 align-top";

function Pct({ rate, pending }: { rate: number | null; pending: number | string }) {
  return (
    <span className="tnum whitespace-nowrap">
      {fmtPct(rate)} <span className="text-pending text-xs">· {pending} pend</span>
    </span>
  );
}

function DeltaPts({ cur, prev }: { cur: number | null; prev: number | null }) {
  if (cur === null || prev === null) return <span className="text-ink3">—</span>;
  const d = (cur - prev) * 100;
  const cls = d > 0 ? "text-ontime" : d < 0 ? "text-late" : "text-ink3";
  return <span className={`tnum ${cls}`}>{d > 0 ? "▲" : d < 0 ? "▼" : "＝"} {fmtGapPts(d)}</span>;
}

function ReasonLabel({ label, category }: { label: string; category: string }) {
  return (
    <span className={category === "DRIVER" ? "text-catDriver font-semibold" : "text-ink"}>
      {label}
    </span>
  );
}

function FailBox({ title, entries }: { title: string; entries: AuditFailEntry[] }) {
  return (
    <div className="border border-rule rounded p-2.5 bg-surface2/40">
      <div className="text-[11px] font-mono uppercase tracking-wide text-ink3 mb-1.5">
        {title} ({entries.length})
      </div>
      {entries.length === 0 ? (
        <div className="text-sm text-ink3">None</div>
      ) : (
        <ul className="space-y-1">
          {entries.map((e, i) => (
            <li key={`${e.lsNumber}_${i}`} className="text-sm leading-snug">
              <span className="font-mono text-xs text-ink2">{e.lsNumber}</span>{" "}
              <ReasonLabel label={e.reasonLabel} category={e.category} />
              {e.note && <span className="text-ink3 italic"> — {e.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pending derived from driver all-time counts; works for snapshot renders too. */
function driverAllTimeLine(d: AuditFlaggedDriver, driversById: Record<string, Driver>) {
  const at = driversById[d.driverId]?.allTime;
  const otpPend = at ? Math.max(0, at.loads - at.otpOnTime - at.otpLate) : "—";
  const otdPend = at ? Math.max(0, at.loads - at.otdOnTime - at.otdLate) : "—";
  return (
    <div className="text-xs text-ink2">
      All-time OTP <Pct rate={d.allTime.otpPct} pending={otpPend} />{" "}
      · OTD <Pct rate={d.allTime.otdPct} pending={otdPend} />{" "}
      · <span className="tnum">{d.allTime.loads}</span> loads
    </div>
  );
}

function TopReasonsColumn({ metric, rows }: { metric: string; rows: AuditReasonRow[] }) {
  const top = rows.filter((r) => r.rank <= 5);
  const overflow = rows.filter((r) => r.rank > 5);
  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-wide text-ink3 mb-1.5">{metric}</div>
      {top.length === 0 ? (
        <div className="text-sm text-ink3">No fail reasons recorded.</div>
      ) : (
        <ol className="space-y-1">
          {top.map((r, i) => (
            <li key={`${r.label}_${i}`} className="text-sm flex items-baseline gap-2">
              <span className="font-mono text-xs text-ink3 tnum w-5 shrink-0">{r.rank}.</span>
              <ReasonLabel label={r.label} category={r.category} />
              <span className="font-mono text-xs text-ink2 tnum">({r.count})</span>
            </li>
          ))}
        </ol>
      )}
      {overflow.length > 0 && (
        <p className="text-xs text-ink3 mt-2">
          Also: {overflow.map((r) => `${r.label} (${r.count})`).join(", ")}
        </p>
      )}
    </div>
  );
}

function CfTable({ metric, row, shuttleExcluded }: { metric: string; row: CfBreakdownRow; shuttleExcluded: number }) {
  return (
    <tr className="border-t border-rule">
      <td className={`${TD} font-mono text-xs`}>{metric}</td>
      <td className={`${TD} tnum`}>{row.lateTotal}</td>
      <td className={`${TD} tnum`}>{row.cf}</td>
      <td className={`${TD} tnum`}>{row.nonCf}</td>
      <td className={`${TD} tnum`}>{row.cfChallenge}</td>
      <td className={`${TD} tnum text-pending`}>{row.noFlag}</td>
      <td className={`${TD} tnum text-ink3`}>{shuttleExcluded}</td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export function AuditScreen({ loads }: { loads: Load[] }) {
  const { profile } = useAuth();
  const { customers, customersById, reasonsById, driversById, fleet } = useData();
  const toast = useToast();

  const weekOptions = useMemo(() => {
    const cur = weekOf(new Date().toISOString(), fleet.timeZone);
    const keys = new Map<string, { weekYear: number; weekNumber: number }>();
    keys.set(`${cur.weekYear}_${cur.weekNumber}`, { weekYear: cur.weekYear, weekNumber: cur.weekNumber });
    for (const l of loads) {
      if (l.weekYear != null && l.weekNumber != null) {
        keys.set(`${l.weekYear}_${l.weekNumber}`, { weekYear: l.weekYear, weekNumber: l.weekNumber });
      }
    }
    return [...keys.entries()]
      .map(([key, w]) => ({ key, ...w, label: `Week ${w.weekNumber} — ${weekRangeLabel(w.weekYear, w.weekNumber)}` }))
      .sort((a, b) => b.weekYear - a.weekYear || b.weekNumber - a.weekNumber);
  }, [loads, fleet.timeZone]);

  const [weekKey, setWeekKey] = useState(() => {
    const cur = weekOf(new Date().toISOString(), fleet.timeZone);
    return `${cur.weekYear}_${cur.weekNumber}`;
  });
  const [customerId, setCustomerId] = useState<CustomerId | "">("");
  const [company, setCompany] = useState<OperatingCompany | "">("");
  const [snapshot, setSnapshot] = useState<WeeklyAudit | null>(null);
  const [generating, setGenerating] = useState(false);

  const [wy, wn] = weekKey.split("_").map(Number);

  const clientAudit = useMemo(
    () => computeAudit({
      loads, weekYear: wy, weekNumber: wn,
      customerId: customerId || null, operatingCompany: company || null,
      customersById, reasonsById, driversById, fleet,
      generatedBy: profile?.id ?? "", generatedByName: profile?.displayName ?? "",
    }),
    [loads, wy, wn, customerId, company, customersById, reasonsById, driversById, fleet, profile],
  );
  const audit = snapshot ?? clientAudit;
  const sc = audit.scorecard;

  const generate = async () => {
    setGenerating(true);
    try {
      const call = httpsCallable(functions, "generateWeeklyAudit");
      const payload: Record<string, unknown> = { weekYear: wy, weekNumber: wn };
      if (customerId) payload.customerId = customerId;
      if (company) payload.operatingCompany = company;
      const res = await call(payload);
      setSnapshot(res.data as WeeklyAudit);
      toast.push("ok", `Snapshot saved for Week ${wn}, ${wy}`);
    } catch (e: unknown) {
      setSnapshot(null); // fall back to the identical client-side computation
      toast.push("error", `Snapshot failed — showing live client computation. ${(e as Error)?.message ?? e}`);
    } finally {
      setGenerating(false);
    }
  };

  const scopeCustomerName = audit.scope.customerId
    ? customersById[audit.scope.customerId]?.name ?? audit.scope.customerId
    : "Fleet-wide";
  const scopeCompany = audit.scope.operatingCompany ?? "AJG + GH";

  const wow = sc.wow.prev;
  const empty = sc.totalScored === 0 && sc.pending === 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="no-print flex flex-wrap items-center gap-2">
        <select
          aria-label="Week"
          value={weekKey}
          onChange={(e) => { setWeekKey(e.target.value); setSnapshot(null); }}
        >
          {weekOptions.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        <select
          aria-label="Customer scope"
          value={customerId}
          onChange={(e) => { setCustomerId(e.target.value as CustomerId | ""); setSnapshot(null); }}
        >
          <option value="">Fleet-wide</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          aria-label="Company scope"
          value={company}
          onChange={(e) => { setCompany(e.target.value as OperatingCompany | ""); setSnapshot(null); }}
        >
          <option value="">Both companies</option>
          {OPERATING_COMPANIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {generating ? "Generating…" : "Generate & save snapshot"}
        </button>
        <button
          type="button"
          onClick={() => window.print()}
          className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
        >
          Print / PDF
        </button>
      </div>

      {/* Report header */}
      <header className="bg-surface border border-rule rounded-lg px-4 py-3">
        <div className="font-mono text-[11px] uppercase tracking-widest text-ink3">GH Logistics — Operations</div>
        <h1 className="font-display font-bold text-2xl leading-tight">
          OTP / OTD OPERATIONS AUDIT — WEEK {audit.weekNumber}
        </h1>
        <div className="text-sm text-ink2 mt-0.5">
          Scope: {scopeCustomerName} · {scopeCompany} · {audit.rangeLabel}
        </div>
        <div className="text-xs font-mono text-ink3 mt-1">
          Generated {fmtDateTime(audit.generatedAt, fleet.timeZone)} by {audit.generatedByName || "—"}
          {snapshot ? " · saved snapshot" : " · live computation (not yet saved)"}
        </div>
      </header>

      {empty ? (
        <EmptyState
          title={`No loads in Week ${audit.weekNumber} for this scope`}
          hint="Pick another week or widen the customer/company scope."
        />
      ) : (
        <>
          {/* 01 Scorecard */}
          <Section title={<span><span className="font-mono text-ink3 mr-2">01</span>Scorecard</span>}>
            <div className="scroll-x">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-ruleStrong">
                    <th className={TH}>Metric</th>
                    <th className={TH}>On-time</th>
                    <th className={TH}>Late</th>
                    <th className={TH}>Rate</th>
                    <th className={TH}>Target</th>
                    <th className={TH}>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {([["OTP", sc.otp], ["OTD", sc.otd]] as const).map(([name, row]) => (
                    <tr key={name} className="border-t border-rule">
                      <td className={`${TD} font-mono text-xs`}>{name}</td>
                      <td className={`${TD} tnum text-ontime`}>{row.onTime}</td>
                      <td className={`${TD} tnum text-late`}>{row.late}</td>
                      <td className={`${TD} font-display font-semibold text-base`}>
                        <Pct rate={row.rate} pending={sc.pending} />
                      </td>
                      <td className={`${TD} tnum`}>{fmtPct(row.target)}</td>
                      <td className={`${TD} tnum ${row.gapPts !== null && row.gapPts < 0 ? "text-late" : "text-ontime"}`}>
                        {fmtGapPts(row.gapPts)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-pending mt-2">
              Pending (excluded from every rate): {sc.pending} load{sc.pending === 1 ? "" : "s"} ·
              {" "}{sc.totalScored} fully scored.
            </p>

            <h4 className="font-display font-semibold text-sm mt-4 mb-1">Week-over-week</h4>
            {wow ? (
              <div className="scroll-x">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-ruleStrong">
                      <th className={TH}></th>
                      <th className={TH}>This week</th>
                      <th className={TH}>Previous week</th>
                      <th className={TH}>Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-rule">
                      <td className={`${TD} font-mono text-xs`}>OTP</td>
                      <td className={TD}><Pct rate={sc.otp.rate} pending={sc.pending} /> <span className="text-late text-xs tnum">({sc.otp.late} late)</span></td>
                      <td className={TD}><Pct rate={wow.otpPct} pending={wow.pending} /> <span className="text-late text-xs tnum">({wow.otpLate} late)</span></td>
                      <td className={TD}><DeltaPts cur={sc.otp.rate} prev={wow.otpPct} /></td>
                    </tr>
                    <tr className="border-t border-rule">
                      <td className={`${TD} font-mono text-xs`}>OTD</td>
                      <td className={TD}><Pct rate={sc.otd.rate} pending={sc.pending} /> <span className="text-late text-xs tnum">({sc.otd.late} late)</span></td>
                      <td className={TD}><Pct rate={wow.otdPct} pending={wow.pending} /> <span className="text-late text-xs tnum">({wow.otdLate} late)</span></td>
                      <td className={TD}><DeltaPts cur={sc.otd.rate} prev={wow.otdPct} /></td>
                    </tr>
                    <tr className="border-t border-rule">
                      <td className={`${TD} font-mono text-xs`}>Scored</td>
                      <td className={`${TD} tnum`}>{sc.totalScored}</td>
                      <td className={`${TD} tnum`}>{wow.totalScored}</td>
                      <td className={`${TD} tnum text-ink3`}>{sc.totalScored - wow.totalScored >= 0 ? "+" : "−"}{Math.abs(sc.totalScored - wow.totalScored)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-ink3">No loads recorded for the previous week in this scope.</p>
            )}

            {(sc.cfBreakdown.otp || sc.cfBreakdown.otd) && (
              <>
                <h4 className="font-display font-semibold text-sm mt-4 mb-1">CF / Non-CF breakdown — USPS</h4>
                <div className="scroll-x">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-ruleStrong">
                        <th className={TH}>Metric</th>
                        <th className={TH}>Late total</th>
                        <th className={TH}>CF</th>
                        <th className={TH}>Non-CF</th>
                        <th className={TH}>Challenge</th>
                        <th className={TH}>No Flag</th>
                        <th className={TH}>Shuttle excl.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sc.cfBreakdown.otp && <CfTable metric="OTP" row={sc.cfBreakdown.otp} shuttleExcluded={sc.cfBreakdown.shuttleExcluded.otp} />}
                      {sc.cfBreakdown.otd && <CfTable metric="OTD" row={sc.cfBreakdown.otd} shuttleExcluded={sc.cfBreakdown.shuttleExcluded.otd} />}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-pending mt-2">{NO_FLAG_NOTE}</p>
              </>
            )}
          </Section>

          {/* 02 Top fail reasons */}
          <Section title={<span><span className="font-mono text-ink3 mr-2">02</span>Top 5 fail reasons</span>}>
            <div className="grid sm:grid-cols-2 gap-4">
              <TopReasonsColumn metric="OTP" rows={audit.topFailReasons.otp} />
              <TopReasonsColumn metric="OTD" rows={audit.topFailReasons.otd} />
            </div>
          </Section>

          {/* 03 Drivers flagged */}
          <Section title={<span><span className="font-mono text-ink3 mr-2">03</span>Drivers flagged for review — 3+ fail reasons</span>}>
            {audit.flaggedDrivers.length === 0 ? (
              <p className="text-sm text-ink3">No drivers with 3 or more fail reasons this week.</p>
            ) : (
              <div className="space-y-3">
                {audit.flaggedDrivers.map((d) => (
                  <div key={d.driverId} className="border border-rule rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-display font-semibold">{d.driverName}</span>
                      {d.teamNames.length > 0 && (
                        <span className="text-xs text-ink3">team w/ {d.teamNames.join(", ")}</span>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-lateSoft text-late tnum">
                        {d.failCount} fail reasons
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-mono border ${
                        d.proposedStep === "STEP_2_WRITE_UP" ? "border-late/40 text-late" : "border-ruleStrong text-ink2"
                      }`}>
                        {d.proposedStep === "STEP_2_WRITE_UP" ? "Proposed: Step 2 — Write-Up" : "Proposed: Step 1 — Call"}
                      </span>
                    </div>
                    {d.repeatFromPrevWeek && (
                      <p className="text-xs text-late mt-1">
                        Week {audit.weekNumber} reappearance triggers Step 2 (Write-Up) per SOP GHL-OPS-003
                      </p>
                    )}
                    <div className="mt-1.5">{driverAllTimeLine(d, driversById)}</div>
                    <div className="grid sm:grid-cols-2 gap-3 mt-2">
                      <FailBox title="OTP fails" entries={d.otpFails} />
                      <FailBox title="OTD fails" entries={d.otdFails} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 04 Worst performers MTD */}
          <Section title={<span><span className="font-mono text-ink3 mr-2">04</span>Top 10 worst performers — month to date (min 3 loads)</span>}>
            {audit.worstPerformersMtd.length === 0 ? (
              <p className="text-sm text-ink3">No qualifying drivers (minimum 3 loads MTD with at least one late event).</p>
            ) : (
              <div className="scroll-x">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-ruleStrong">
                      <th className={TH}>#</th>
                      <th className={TH}>Driver</th>
                      <th className={TH}>Loads MTD</th>
                      <th className={TH}>OTP fails</th>
                      <th className={TH}>OTD fails</th>
                      <th className={TH}>Total late</th>
                      <th className={TH}>Alert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.worstPerformersMtd.map((p, i) => (
                      <tr key={p.driverId} className="border-t border-rule">
                        <td className={`${TD} font-mono text-xs tnum`}>{i + 1}</td>
                        <td className={TD}>{p.driverName}</td>
                        <td className={`${TD} tnum`}>{p.loadsMtd}</td>
                        <td className={`${TD} tnum`}>{p.otpFails}</td>
                        <td className={`${TD} tnum`}>{p.otdFails}</td>
                        <td className={`${TD} tnum font-semibold text-late`}>{p.totalLate}</td>
                        <td className={`${TD} text-xs ${p.alert.includes("Step 2") ? "text-late" : "text-ink2"}`}>{p.alert}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* 05 Fail reason summary index */}
          <Section title={<span><span className="font-mono text-ink3 mr-2">05</span>Fail reason summary index</span>}>
            {audit.reasonIndex.otp.length === 0 && audit.reasonIndex.otd.length === 0 ? (
              <p className="text-sm text-ink3">No fail reasons recorded this week.</p>
            ) : (
              <div className="space-y-4">
                {([["OTP", audit.reasonIndex.otp], ["OTD", audit.reasonIndex.otd]] as const).map(([name, list]) => (
                  <div key={name}>
                    <div className="text-[11px] font-mono uppercase tracking-wide text-ink3 mb-1.5">{name}</div>
                    {list.length === 0 ? (
                      <p className="text-sm text-ink3">None.</p>
                    ) : (
                      <ul className="space-y-2">
                        {list.map((r, i) => (
                          <li key={`${r.label}_${i}`} className="text-sm">
                            <ReasonLabel label={r.label} category={r.category} />{" "}
                            <span className="font-mono text-xs text-ink2 tnum">({r.count})</span>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                              {r.entries.map((e, j) => (
                                <span key={`${e.lsNumber}_${j}`} className="text-xs text-ink2 whitespace-nowrap">
                                  <span className="font-mono">{e.lsNumber}</span>
                                  <span className="text-ink3"> — {e.driverNames}</span>
                                </span>
                              ))}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
