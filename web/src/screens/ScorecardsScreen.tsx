import { useMemo, type ReactNode } from "react";
import { useData } from "../state/DataContext";
import {
  EMPTY_FILTERS, missingReason, needsCfCoding, pendingActuals, type LoadFilters,
} from "../lib/loads";
import {
  dayNumberToUtcDate, effectiveTarget, gapPoints, isGhostShutdown, summarizeMetric,
  weekDayRange, weekOf, weekRangeLabel,
} from "../lib/scoring";
import type { RateSummary } from "../lib/scoring";
import { fmtDwell, fmtGapPts, fmtPct, nowIso } from "../lib/format";
import { Chip, EmptyState, Section } from "../components/ui";
import type { Customer, Load } from "../lib/types";
import { OPERATING_COMPANIES } from "../lib/types";

function Meter({ rate, target }: { rate: number | null; target: number }) {
  const pct = rate === null ? 0 : Math.min(100, Math.max(0, rate * 100));
  return (
    <div className="relative h-2 rounded bg-surface2" title={`target ${fmtPct(target)}`}>
      {rate !== null && (
        <div
          className={`absolute inset-y-0 left-0 rounded ${rate >= target ? "bg-ontime" : "bg-late"}`}
          style={{ width: `${pct}%` }}
        />
      )}
      <div
        className="absolute inset-y-0 bg-ink"
        style={{ left: `calc(${Math.min(100, target * 100)}% - 1px)`, width: 2 }}
      />
    </div>
  );
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-surface border border-rule rounded-lg p-3 flex flex-col">
      <p className="text-xs font-mono uppercase tracking-wide text-ink3 mb-1">{label}</p>
      {children}
    </div>
  );
}

function RateTile({ label, s, target }: { label: string; s: RateSummary; target: number }) {
  const gap = gapPoints(s.rate, target);
  return (
    <Tile label={label}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-display font-bold text-3xl leading-none tnum">{fmtPct(s.rate)}</span>
        <span className={`text-sm tnum ${gap === null ? "text-ink3" : gap >= 0 ? "text-ontime" : "text-late"}`}>
          {fmtGapPts(gap)}
        </span>
      </div>
      <p className="text-xs text-ink3 mt-1 tnum">
        target {fmtPct(target)} · {s.onTime}/{s.denominator} on time
      </p>
      <div className="mt-2"><Meter rate={s.rate} target={target} /></div>
      <p className="text-xs text-pending mt-1 tnum">{s.pending} pending</p>
    </Tile>
  );
}

function MetricRow({ name, s, target }: { name: "OTP" | "OTD"; s: RateSummary; target: number }) {
  const gap = gapPoints(s.rate, target);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-mono uppercase text-ink3">{name}</span>
        <span className="flex items-baseline gap-2">
          <span className="font-display font-semibold text-xl leading-none tnum">{fmtPct(s.rate)}</span>
          <span className="text-xs text-pending tnum">{s.pending} pending</span>
        </span>
      </div>
      <div className="my-1.5"><Meter rate={s.rate} target={target} /></div>
      <p className="text-xs text-ink3 tnum">
        target {fmtPct(target)} ·{" "}
        <span className={gap === null ? "" : gap >= 0 ? "text-ontime" : "text-late"}>{fmtGapPts(gap)}</span>
        {" "}· {s.late} late{s.earlyAsMiss > 0 ? ` · ${s.earlyAsMiss} early-as-miss` : ""}
      </p>
    </div>
  );
}

function ScopeCard({ title, subset, otpTarget, otdTarget, customersById }: {
  title: string;
  subset: Load[];
  otpTarget: number;
  otdTarget: number;
  customersById: Record<string, Customer>;
}) {
  const otp = summarizeMetric(subset, "otp", customersById);
  const otd = summarizeMetric(subset, "otd", customersById);
  return (
    <div className="bg-surface border border-rule rounded-lg p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="font-display font-semibold truncate">{title}</p>
        <p className="text-xs text-ink3 tnum whitespace-nowrap">{subset.length} loads</p>
      </div>
      <div className="space-y-3">
        <MetricRow name="OTP" s={otp} target={otpTarget} />
        <MetricRow name="OTD" s={otd} target={otdTarget} />
      </div>
    </div>
  );
}

function Delta({ value, decimals = 0, suffix = "", goodWhenUp }: {
  value: number | null;
  decimals?: number;
  suffix?: string;
  goodWhenUp: boolean | null;   // null = neutral coloring
}) {
  if (value === null) return <span className="text-ink3">—</span>;
  if (value === 0) return <span className="text-ink3 tnum">0{suffix}</span>;
  const up = value > 0;
  const cls = goodWhenUp === null ? "text-ink2" : up === goodWhenUp ? "text-ontime" : "text-late";
  return (
    <span className={`tnum ${cls}`}>
      {up ? "▲" : "▼"} {Math.abs(value).toFixed(decimals)}{suffix}
    </span>
  );
}

const QUICK_CHIPS: { key: NonNullable<LoadFilters["quick"]>; label: string }[] = [
  { key: "needsCf", label: "Needs CF coding" },
  { key: "missingReason", label: "Missing reason" },
  { key: "pendingActuals", label: "Pending actuals" },
];

export function ScorecardsScreen({ loads, filtered, filters, onFilters }: {
  loads: Load[];
  filtered: Load[];
  filters: LoadFilters;
  onFilters(f: LoadFilters): void;
}) {
  const { customers, customersById, reasonsById, fleet } = useData();

  const quickCounts = useMemo(() => ({
    ghost: loads.filter((l) => isGhostShutdown(l)).length,
    needsCf: loads.filter((l) => needsCfCoding(l, customersById)).length,
    missingReason: loads.filter(missingReason).length,
    pendingActuals: loads.filter(pendingActuals).length,
  }), [loads, customersById]);
  const quickCount = (k: NonNullable<LoadFilters["quick"]>) =>
    k === "ghost" ? quickCounts.ghost
      : k === "needsCf" ? quickCounts.needsCf
        : k === "missingReason" ? quickCounts.missingReason
          : quickCounts.pendingActuals;

  const scopeCustomer = filters.customerId ? customersById[filters.customerId] ?? null : null;
  const otpTarget = effectiveTarget("otp", scopeCustomer, fleet);
  const otdTarget = effectiveTarget("otd", scopeCustomer, fleet);
  const otpS = useMemo(() => summarizeMetric(filtered, "otp", customersById), [filtered, customersById]);
  const otdS = useMemo(() => summarizeMetric(filtered, "otd", customersById), [filtered, customersById]);

  const scoredOf = (list: Load[]) =>
    list.filter((l) =>
      (l.otp?.status ?? "PENDING") !== "PENDING" || (l.otd?.status ?? "PENDING") !== "PENDING",
    ).length;
  const scored = useMemo(() => scoredOf(filtered), [filtered]);

  const stopStats = useMemo(() => {
    let sum = 0, n = 0, pendingStops = 0;
    for (const l of filtered) {
      if (l.stopOnTimePct !== null && l.stopOnTimePct !== undefined) { sum += l.stopOnTimePct; n++; }
      for (const s of l.stops) if ((s.onTime?.status ?? "PENDING") === "PENDING") pendingStops++;
    }
    return { avg: n ? sum / n : null, pendingStops };
  }, [filtered]);

  const ghostInView = useMemo(() => filtered.filter((l) => isGhostShutdown(l)).length, [filtered]);
  const needsCfInView = useMemo(
    () => filtered.filter((l) => needsCfCoding(l, customersById)).length,
    [filtered, customersById],
  );
  const lateOtd = useMemo(
    () => filtered.filter((l) => l.otd?.status === "LATE"), [filtered],
  );
  const avgLateMin = useMemo(() => {
    const mins = lateOtd.map((l) => l.otd?.varianceMin ?? 0).filter((m) => m > 0);
    return mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
  }, [lateOtd]);

  const curWeek = useMemo(() => weekOf(nowIso(), fleet.timeZone), [fleet.timeZone]);
  const prevWeek = useMemo(() => {
    // Wednesday noon UTC of the prior Sun–Sat week lands inside it in every US zone.
    const { startDay } = weekDayRange(curWeek.weekYear, curWeek.weekNumber);
    const mid = new Date(dayNumberToUtcDate(startDay - 4).getTime() + 43_200_000);
    return weekOf(mid.toISOString(), fleet.timeZone);
  }, [curWeek, fleet.timeZone]);

  const thisWeekLoads = useMemo(
    () => filtered.filter((l) => l.weekYear === curWeek.weekYear && l.weekNumber === curWeek.weekNumber),
    [filtered, curWeek],
  );
  const prevWeekLoads = useMemo(
    () => filtered.filter((l) => l.weekYear === prevWeek.weekYear && l.weekNumber === prevWeek.weekNumber),
    [filtered, prevWeek],
  );
  const wow = useMemo(() => ({
    curOtp: summarizeMetric(thisWeekLoads, "otp", customersById),
    curOtd: summarizeMetric(thisWeekLoads, "otd", customersById),
    prevOtp: summarizeMetric(prevWeekLoads, "otp", customersById),
    prevOtd: summarizeMetric(prevWeekLoads, "otd", customersById),
    curScored: scoredOf(thisWeekLoads),
    prevScored: scoredOf(prevWeekLoads),
  }), [thisWeekLoads, prevWeekLoads, customersById]);
  const ratePts = (cur: number | null, prev: number | null) =>
    cur === null || prev === null ? null : (cur - prev) * 100;

  const topReasons = useMemo(() => {
    const byCode = new Map<string, number>();
    for (const l of thisWeekLoads) {
      if (l.otd?.status !== "LATE") continue;
      for (const r of l.otdReasons) byCode.set(r.reasonCode, (byCode.get(r.reasonCode) ?? 0) + 1);
    }
    return [...byCode.entries()]
      .map(([code, count]) => ({
        code, count,
        label: reasonsById[code]?.label ?? code,
        driver: reasonsById[code]?.category === "DRIVER",
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [thisWeekLoads, reasonsById]);
  const maxReasonCount = topReasons[0]?.count ?? 0;

  const filtersActive = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS), [filters],
  );

  const wowRows: {
    label: string;
    prev: ReactNode;
    cur: ReactNode;
    delta: ReactNode;
  }[] = [
    {
      label: "OTP %",
      prev: <>{fmtPct(wow.prevOtp.rate)} <span className="text-pending">· {wow.prevOtp.pending} pending</span></>,
      cur: <>{fmtPct(wow.curOtp.rate)} <span className="text-pending">· {wow.curOtp.pending} pending</span></>,
      delta: <Delta value={ratePts(wow.curOtp.rate, wow.prevOtp.rate)} decimals={1} suffix=" pts" goodWhenUp={true} />,
    },
    {
      label: "OTP late",
      prev: wow.prevOtp.late,
      cur: wow.curOtp.late,
      delta: <Delta value={wow.curOtp.late - wow.prevOtp.late} goodWhenUp={false} />,
    },
    {
      label: "OTD %",
      prev: <>{fmtPct(wow.prevOtd.rate)} <span className="text-pending">· {wow.prevOtd.pending} pending</span></>,
      cur: <>{fmtPct(wow.curOtd.rate)} <span className="text-pending">· {wow.curOtd.pending} pending</span></>,
      delta: <Delta value={ratePts(wow.curOtd.rate, wow.prevOtd.rate)} decimals={1} suffix=" pts" goodWhenUp={true} />,
    },
    {
      label: "OTD late",
      prev: wow.prevOtd.late,
      cur: wow.curOtd.late,
      delta: <Delta value={wow.curOtd.late - wow.prevOtd.late} goodWhenUp={false} />,
    },
    {
      label: "Total scored",
      prev: wow.prevScored,
      cur: wow.curScored,
      delta: <Delta value={wow.curScored - wow.prevScored} goodWhenUp={null} />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={filters.customerId === null} onClick={() => onFilters({ ...filters, customerId: null })}>
          All customers
        </Chip>
        {customers.map((c) => (
          <Chip
            key={c.id}
            active={filters.customerId === c.id}
            onClick={() => onFilters({ ...filters, customerId: filters.customerId === c.id ? null : c.id! })}
          >
            {c.name}
          </Chip>
        ))}
        <span className="h-4 w-px bg-ruleStrong mx-1" aria-hidden="true" />
        <Chip active={filters.operatingCompany === null} onClick={() => onFilters({ ...filters, operatingCompany: null })}>
          All
        </Chip>
        {OPERATING_COMPANIES.map((co) => (
          <Chip
            key={co}
            active={filters.operatingCompany === co}
            onClick={() => onFilters({ ...filters, operatingCompany: filters.operatingCompany === co ? null : co })}
          >
            {co}
          </Chip>
        ))}
        <span className="h-4 w-px bg-ruleStrong mx-1" aria-hidden="true" />
        <button
          type="button"
          title="USPS protocol: hourly customer updates until delivered"
          onClick={() => onFilters({ ...filters, quick: filters.quick === "ghost" ? null : "ghost" })}
          className={`px-2.5 py-1 rounded-full text-xs font-mono border whitespace-nowrap ${
            filters.quick === "ghost"
              ? "bg-brand text-brandInk border-brand"
              : "border-brand text-brand hover:bg-surface2"
          }`}
        >
          Ghost Shutdown ({quickCounts.ghost})
        </button>
        {QUICK_CHIPS.map((q) => (
          <Chip
            key={q.key}
            active={filters.quick === q.key}
            onClick={() => onFilters({ ...filters, quick: filters.quick === q.key ? null : q.key })}
          >
            {q.label} ({quickCount(q.key)})
          </Chip>
        ))}
        {filtersActive && (
          <button
            type="button"
            onClick={() => onFilters({ ...EMPTY_FILTERS })}
            className="px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2"
          >
            Clear filters
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No loads match the current filters" hint="Adjust or clear the filters above." />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <Tile label="Loads scored">
              <span className="font-display font-bold text-3xl leading-none tnum">{scored}</span>
              <p className="text-xs text-ink3 mt-1 tnum">of {filtered.length} in view</p>
              <p className="text-xs text-pending mt-1 tnum">{filtered.length - scored} fully pending</p>
            </Tile>
            <RateTile label="OTP" s={otpS} target={otpTarget} />
            <RateTile label="OTD" s={otdS} target={otdTarget} />
            <Tile label="All-Stop %">
              <span className="font-display font-bold text-3xl leading-none tnum">{fmtPct(stopStats.avg)}</span>
              <p className="text-xs text-ink3 mt-1">avg across graded loads</p>
              <p className="text-xs text-pending mt-1 tnum">{stopStats.pendingStops} stops pending</p>
            </Tile>
            <Tile label="Ghost Shutdown">
              <span
                className="font-display font-bold text-3xl leading-none tnum text-brand"
                title="USPS protocol: hourly customer updates until delivered"
              >
                {ghostInView}
              </span>
              <p className="text-xs text-ink3 mt-1">hourly updates until delivered</p>
            </Tile>
            <Tile label="Avg minutes late">
              <span className="font-display font-bold text-3xl leading-none tnum">
                {avgLateMin === null ? "—" : fmtDwell(avgLateMin)}
              </span>
              <p className="text-xs text-ink3 mt-1 tnum">among {lateOtd.length} late OTD loads</p>
            </Tile>
            <Tile label="Needs CF">
              <span className="font-display font-bold text-3xl leading-none tnum">{needsCfInView}</span>
              <p className="text-xs text-ink3 mt-1">USPS CF / Non-CF to-dos</p>
            </Tile>
          </div>

          <Section title="By customer">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {customers.map((c) => (
                <ScopeCard
                  key={c.id}
                  title={c.name}
                  subset={filtered.filter((l) => l.customerId === c.id)}
                  otpTarget={effectiveTarget("otp", c, fleet)}
                  otdTarget={effectiveTarget("otd", c, fleet)}
                  customersById={customersById}
                />
              ))}
            </div>
          </Section>

          <Section title="By operating company">
            <div className="grid gap-3 sm:grid-cols-2">
              {OPERATING_COMPANIES.map((co) => (
                <ScopeCard
                  key={co}
                  title={co}
                  subset={filtered.filter((l) => l.operatingCompany === co)}
                  otpTarget={effectiveTarget("otp", null, fleet)}
                  otdTarget={effectiveTarget("otd", null, fleet)}
                  customersById={customersById}
                />
              ))}
            </div>
          </Section>

          <Section
            title="Week over week"
            right={
              <span className="text-xs font-mono text-ink3">
                {weekRangeLabel(prevWeek.weekYear, prevWeek.weekNumber)} → {weekRangeLabel(curWeek.weekYear, curWeek.weekNumber)}
              </span>
            }
          >
            <div className="scroll-x">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-mono uppercase tracking-wide text-ink3 border-b border-rule">
                    <th className="py-1.5 pr-3 font-normal">Metric</th>
                    <th className="py-1.5 pr-3 font-normal">Wk {prevWeek.weekNumber}</th>
                    <th className="py-1.5 pr-3 font-normal">Wk {curWeek.weekNumber} (current)</th>
                    <th className="py-1.5 font-normal">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {wowRows.map((r) => (
                    <tr key={r.label} className="border-b border-rule last:border-0">
                      <td className="py-1.5 pr-3 text-ink2">{r.label}</td>
                      <td className="py-1.5 pr-3 tnum">{r.prev}</td>
                      <td className="py-1.5 pr-3 tnum">{r.cur}</td>
                      <td className="py-1.5">{r.delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Top OTD fail reasons this week"
            right={
              <span className="flex items-center gap-4 text-xs text-ink3">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-catDriver" aria-hidden="true" /> DRIVER category
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm bg-catOther" aria-hidden="true" /> Other
                </span>
              </span>
            }
          >
            {topReasons.length === 0 ? (
              <p className="text-sm text-ink3">
                No fail reasons entered on late OTD loads this week ({wow.curOtd.late} late · {wow.curOtd.pending} pending).
              </p>
            ) : (
              <div className="space-y-1.5">
                {topReasons.map((r) => (
                  <div key={r.code} className="flex items-center gap-2">
                    <span
                      className={`w-48 sm:w-64 shrink-0 truncate text-sm ${r.driver ? "text-catDriver" : "text-ink2"}`}
                      title={r.label}
                    >
                      {r.label}
                    </span>
                    <div className="flex-1 h-4">
                      <div
                        className={`h-4 rounded-sm ${r.driver ? "bg-catDriver" : "bg-catOther"}`}
                        style={{ width: `${(r.count / maxReasonCount) * 100}%`, minWidth: 8 }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-sm tnum">{r.count}</span>
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
