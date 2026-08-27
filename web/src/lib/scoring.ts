/**
 * Pure scoring engine — no Firebase imports, no side effects.
 * Canonical results are written by Cloud Functions (onLoadWrite); the client runs the
 * same code for instant optimistic display. The copy at functions/src/scoring.ts must
 * stay byte-identical (scoring.test.ts enforces it).
 */
import type {
  Customer, FleetSettings, Load, MetricResult, OnTimeStatus, Stop, StopOnTime,
} from "./types";
import { GHOST_SHUTDOWN_CUSTOMER } from "./types";

const MIN_MS = 60_000;

export const DEFAULT_FLEET: FleetSettings = {
  targets: { otp: 0.97, otd: 0.95 },
  timeZone: "America/Chicago",
  retainTenderPdf: true,
  tenderRetentionDays: null,
  signInDomain: "ghlogisticsllc.com",
};

export const DEFAULT_CUSTOMER_RULES: Pick<
  Customer, "graceMinutes" | "earlyToleranceHours" | "earlyCountsAsMiss"
> = {
  graceMinutes: { pickup: 15, delivery: 15 },
  earlyToleranceHours: 2,
  earlyCountsAsMiss: false,
};

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function gradeStop(stop: Stop, customer: Customer | null): StopOnTime {
  const rules = customer ?? ({ ...DEFAULT_CUSTOMER_RULES } as Customer);
  const grace =
    stop.type === "PICKUP" ? rules.graceMinutes.pickup : rules.graceMinutes.delivery;
  const appt = ms(stop.appt);
  const apptEnd = ms(stop.apptEnd);
  const arrival = ms(stop.actualArrival);

  if (appt === null || arrival === null) {
    // A blank appointment or actual is PENDING — never a miss. (The old sheet's LET()
    // returned FALSE here, counting unkeyed loads as late and understating every customer.)
    return { status: "PENDING", varianceMin: null, deadline: null };
  }
  const deadlineMs = (apptEnd ?? appt) + grace * MIN_MS;
  const varianceMin = Math.round((arrival - appt) / MIN_MS);
  const earlyCutoff = appt - rules.earlyToleranceHours * 60 * MIN_MS;

  let status: OnTimeStatus;
  if (arrival < earlyCutoff) status = "EARLY";
  else if (arrival <= deadlineMs) status = "ON_TIME";
  else status = "LATE";

  return { status, varianceMin, deadline: new Date(deadlineMs).toISOString() };
}

export function dwellMinutes(stop: Stop): number | null {
  const a = ms(stop.actualArrival);
  const d = ms(stop.actualDeparture);
  if (a === null || d === null) return null;
  return Math.round((d - a) / MIN_MS);
}

export interface GradedLoad {
  stops: Stop[];                 // with onTime + dwellMin filled
  otp: MetricResult;             // first PICKUP stop
  otd: MetricResult;             // final DELIVERY stop
  stopOnTimePct: number | null;  // across every graded stop
  transitMin: number | null;
  firstPickupAppt: string | null;
  finalDeliveryAppt: string | null;
}

export function gradeLoad(load: Load, customer: Customer | null): GradedLoad {
  const sorted = [...load.stops].sort((a, b) => a.seq - b.seq);
  const graded = sorted.map((s) => ({
    ...s,
    onTime: gradeStop(s, customer),
    dwellMin: dwellMinutes(s),
  }));

  const pickups = graded.filter((s) => s.type === "PICKUP");
  const deliveries = graded.filter((s) => s.type === "DELIVERY");
  const first = pickups[0] ?? null;
  const last = deliveries.length ? deliveries[deliveries.length - 1] : null;

  const empty: MetricResult = { status: "PENDING", varianceMin: null, deadline: null };
  const otp: MetricResult = first?.onTime ?? empty;
  const otd: MetricResult = last?.onTime ?? empty;

  const gradedStops = graded.filter((s) => s.onTime && s.onTime.status !== "PENDING");
  const countsAsMiss = (st: OnTimeStatus) =>
    st === "LATE" || (st === "EARLY" && !!customer?.earlyCountsAsMiss);
  const denom = gradedStops.filter(
    (s) => s.onTime!.status === "ON_TIME" || countsAsMiss(s.onTime!.status),
  );
  const on = denom.filter((s) => s.onTime!.status === "ON_TIME").length;
  const stopOnTimePct = denom.length ? on / denom.length : null;

  const dep = ms(first?.actualDeparture ?? null);
  const arr = ms(last?.actualArrival ?? null);
  const transitMin = dep !== null && arr !== null ? Math.round((arr - dep) / MIN_MS) : null;

  return {
    stops: graded,
    otp,
    otd,
    stopOnTimePct,
    transitMin,
    firstPickupAppt: first?.appt ?? null,
    finalDeliveryAppt: last?.appt ?? null,
  };
}

/** Effective target for a metric: customer override, else fleet default. */
export function effectiveTarget(
  metric: "otp" | "otd", customer: Customer | null, fleet: FleetSettings,
): number {
  const t = customer?.targets?.[metric];
  return t ?? fleet.targets[metric];
}

export interface RateSummary {
  onTime: number;
  late: number;
  early: number;          // EARLY occurrences (miss only when earlyCountsAsMiss)
  earlyAsMiss: number;    // EARLY that counted into the denominator as misses
  pending: number;
  denominator: number;
  rate: number | null;    // 0..1; null when denominator is 0
}

/**
 * PENDING is excluded from the denominator and reported as its own count.
 * Never display `rate` without `pending` beside it.
 */
export function summarizeMetric(
  loads: Load[],
  metric: "otp" | "otd",
  customersById: Record<string, Customer>,
): RateSummary {
  let onTime = 0, late = 0, early = 0, earlyAsMiss = 0, pending = 0;
  for (const load of loads) {
    const st = load[metric]?.status ?? "PENDING";
    if (st === "PENDING") { pending++; continue; }
    if (st === "ON_TIME") { onTime++; continue; }
    if (st === "LATE") { late++; continue; }
    // EARLY
    early++;
    if (customersById[load.customerId]?.earlyCountsAsMiss) earlyAsMiss++;
  }
  const denominator = onTime + late + earlyAsMiss;
  return {
    onTime, late, early, earlyAsMiss, pending, denominator,
    rate: denominator ? onTime / denominator : null,
  };
}

/** Signed gap in percentage points, one-decimal precision left to the renderer. */
export function gapPoints(rate: number | null, target: number): number | null {
  return rate === null ? null : (rate - target) * 100;
}

/**
 * USPS Ghost Shutdown: a USPS load that is late on delivery — a late arrival keyed,
 * OR still undelivered past its final delivery appointment — and not yet
 * Delivered/Cancelled. Protocol: hourly customer updates until delivered; the UI
 * surfaces the queue.
 */
export function isGhostShutdown(load: Load, nowIso?: string): boolean {
  if (load.customerId !== GHOST_SHUTDOWN_CUSTOMER) return false;
  if (load.status === "Delivered" || load.status === "Cancelled") return false;
  if ((load.otd?.status ?? "PENDING") === "LATE") return true;
  // Still rolling past the appointment: overdue counts even before an actual is keyed.
  const appt = load.finalDeliveryAppt ?? null;
  const now = nowIso ?? new Date().toISOString();
  if (!appt || appt >= now) return false;
  const finals = load.stops.filter((s) => s.type === "DELIVERY");
  const arrived = finals.length ? finals[finals.length - 1].actualArrival : null;
  return !arrived;
}

/* ------------------------------------------------------------------ */
/* Weeks: Sunday–Saturday; week 1 is the Sun–Sat week containing Jan 1 */
/* (matches the audit: Week 33 = Aug 9–15, 2026). NOT ISO weeks.       */
/* ------------------------------------------------------------------ */

/** Y/M/D of an instant as observed in `timeZone`. */
export function zonedYmd(
  iso: string, timeZone: string,
): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso)); // "2026-08-09"
  const [y, m, d] = parts.split("-").map(Number);
  return { y, m, d };
}

/** Days since epoch for a calendar date (UTC-noon anchor sidesteps DST). */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d, 12) / 86_400_000);
}
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0 = Sunday
}
/** Day number of the Sunday on or before Jan 1 of `year` (start of week 1). */
function week1Start(year: number): number {
  return dayNumber(year, 1, 1) - dayOfWeek(year, 1, 1);
}

export function weekOf(
  iso: string, fleetTimeZone: string,
): { weekYear: number; weekNumber: number; monthKey: string } {
  const { y, m, d } = zonedYmd(iso, fleetTimeZone);
  const dn = dayNumber(y, m, d);
  let weekYear = y;
  if (dn >= week1Start(y + 1)) weekYear = y + 1;
  const weekNumber = Math.floor((dn - week1Start(weekYear)) / 7) + 1;
  const monthKey = `${y}-${String(m).padStart(2, "0")}`;
  return { weekYear, weekNumber, monthKey };
}

/** Inclusive [start, end] instants (UTC ms) of a Sun–Sat week, in day numbers. */
export function weekDayRange(
  weekYear: number, weekNumber: number,
): { startDay: number; endDay: number } {
  const start = week1Start(weekYear) + (weekNumber - 1) * 7;
  return { startDay: start, endDay: start + 6 };
}

export function dayNumberToUtcDate(dn: number): Date {
  return new Date(dn * 86_400_000);
}

/** "Aug 9–15, 2026" style label for a week. */
export function weekRangeLabel(weekYear: number, weekNumber: number): string {
  const { startDay, endDay } = weekDayRange(weekYear, weekNumber);
  const s = dayNumberToUtcDate(startDay);
  const e = dayNumberToUtcDate(endDay);
  const mo = (dt: Date) => dt.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const sm = mo(s), em = mo(e);
  const year = e.getUTCFullYear();
  return sm === em
    ? `${sm} ${s.getUTCDate()}–${e.getUTCDate()}, ${year}`
    : `${sm} ${s.getUTCDate()}–${em} ${e.getUTCDate()}, ${year}`;
}
