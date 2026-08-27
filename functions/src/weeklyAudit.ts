/**
 * Weekly audit snapshot generator. The client renders the same math live;
 * this callable persists an immutable snapshot to weeklyAudits and returns it.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import type { Query } from "firebase-admin/firestore";
import { SIGN_IN_DOMAIN } from "./identity";
import {
  DEFAULT_FLEET, dayNumberToUtcDate, effectiveTarget, gapPoints,
  summarizeMetric, weekDayRange, weekRangeLabel,
} from "./scoring";
import type {
  AuditFailEntry, AuditFlaggedDriver, AuditMetricRow, AuditReasonIndexRow,
  AuditReasonRow, AuditWorstPerformer, CfBreakdownRow, Customer, CustomerId,
  Driver, FailReason, FleetSettings, Load, OperatingCompany, ReasonCategory,
  ReasonEntry, WeeklyAudit,
} from "./types";
import { CUSTOMER_IDS, OPERATING_COMPANIES } from "./types";

const db = () => getFirestore();

function prevWeekOf(weekYear: number, weekNumber: number): { weekYear: number; weekNumber: number } {
  if (weekNumber > 1) return { weekYear, weekNumber: weekNumber - 1 };
  const prevYear = weekYear - 1;
  const prevStart = weekDayRange(weekYear, 1).startDay - 7;
  const prevYearWeek1 = weekDayRange(prevYear, 1).startDay;
  return { weekYear: prevYear, weekNumber: Math.floor((prevStart - prevYearWeek1) / 7) + 1 };
}

function scoped(q: Query, customerId: CustomerId | null, operatingCompany: OperatingCompany | null): Query {
  if (customerId) q = q.where("customerId", "==", customerId);
  if (operatingCompany) q = q.where("operatingCompany", "==", operatingCompany);
  return q;
}

interface LoadRow { id: string; load: Load }

async function fetchLoads(q: Query): Promise<LoadRow[]> {
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, load: d.data() as Load }));
}

type ReasonMeta = { label: string; category: ReasonCategory };

export const generateWeeklyAudit = onCall(async (request) => {
  const email = (request.auth?.token?.email ?? "").toLowerCase();
  if (!email.endsWith(`@${SIGN_IN_DOMAIN}`)) {
    throw new HttpsError("permission-denied", `Requires an @${SIGN_IN_DOMAIN} account.`);
  }
  const data = (request.data ?? {}) as {
    weekYear?: unknown; weekNumber?: unknown; customerId?: unknown; operatingCompany?: unknown;
  };
  const weekYear = data.weekYear;
  const weekNumber = data.weekNumber;
  if (!Number.isInteger(weekYear) || !Number.isInteger(weekNumber)) {
    throw new HttpsError("invalid-argument", "weekYear and weekNumber must be integers.");
  }
  const wy = weekYear as number;
  const wn = weekNumber as number;
  const customerId: CustomerId | null =
    typeof data.customerId === "string" && (CUSTOMER_IDS as string[]).includes(data.customerId)
      ? (data.customerId as CustomerId) : null;
  if (data.customerId != null && customerId === null) {
    throw new HttpsError("invalid-argument", `Unknown customerId: ${String(data.customerId)}`);
  }
  const operatingCompany: OperatingCompany | null =
    typeof data.operatingCompany === "string" &&
    (OPERATING_COMPANIES as string[]).includes(data.operatingCompany)
      ? (data.operatingCompany as OperatingCompany) : null;
  if (data.operatingCompany != null && operatingCompany === null) {
    throw new HttpsError("invalid-argument", `Unknown operatingCompany: ${String(data.operatingCompany)}`);
  }

  const prev = prevWeekOf(wy, wn);
  const weekQuery = (y: number, n: number) => scoped(
    db().collection("loads").where("weekYear", "==", y).where("weekNumber", "==", n),
    customerId, operatingCompany,
  );

  const [rows, prevRows, customersSnap, reasonsSnap, fleetSnap] = await Promise.all([
    fetchLoads(weekQuery(wy, wn)),
    fetchLoads(weekQuery(prev.weekYear, prev.weekNumber)),
    db().collection("customers").get(),
    db().collection("failReasons").get(),
    db().collection("settings").doc("fleet").get(),
  ]);
  const loads = rows.map((r) => r.load);
  const prevLoads = prevRows.map((r) => r.load);
  const customersById: Record<string, Customer> = {};
  for (const d of customersSnap.docs) customersById[d.id] = d.data() as Customer;
  const reasons: Record<string, ReasonMeta> = {};
  for (const d of reasonsSnap.docs) {
    const r = d.data() as FailReason;
    reasons[d.id] = { label: r.label, category: r.category };
  }
  const reasonMeta = (code: string): ReasonMeta =>
    reasons[code] ?? { label: code, category: "EXTERNAL" };
  const fleet: FleetSettings = fleetSnap.exists
    ? { ...DEFAULT_FLEET, ...(fleetSnap.data() as FleetSettings) }
    : DEFAULT_FLEET;
  const scopeCustomer = customerId ? customersById[customerId] ?? null : null;

  // ---- 01 Scorecard ----
  const metricRow = (ls: Load[], metric: "otp" | "otd"): AuditMetricRow => {
    const s = summarizeMetric(ls, metric, customersById);
    const target = effectiveTarget(metric, scopeCustomer, fleet);
    // late = every miss in the denominator (LATE + EARLY-as-miss), so onTime + late = denominator.
    return { onTime: s.onTime, late: s.denominator - s.onTime, rate: s.rate, target, gapPts: gapPoints(s.rate, target) };
  };
  const status = (l: Load, m: "otp" | "otd") => l[m]?.status ?? "PENDING";
  // "Fully scored" = both metrics graded, so fullyScored + eitherPending partitions
  // the week's loads exactly (the client audit uses the identical rule).
  const scoredCount = (ls: Load[]) =>
    ls.filter((l) => status(l, "otp") !== "PENDING" && status(l, "otd") !== "PENDING").length;
  const pendingCount = (ls: Load[]) =>
    ls.filter((l) => status(l, "otp") === "PENDING" || status(l, "otd") === "PENDING").length;
  const pending = pendingCount(loads);

  const prevOtp = summarizeMetric(prevLoads, "otp", customersById);
  const prevOtd = summarizeMetric(prevLoads, "otd", customersById);
  const wowPrev = prevLoads.length
    ? {
        otpPct: prevOtp.rate, otpLate: prevOtp.denominator - prevOtp.onTime,
        otdPct: prevOtd.rate, otdLate: prevOtd.denominator - prevOtd.onTime,
        totalScored: scoredCount(prevLoads),
        pending: pendingCount(prevLoads),
      }
    : null;

  const shuttleExcluded = { otp: 0, otd: 0 };
  let cfOtp: CfBreakdownRow | null = null;
  let cfOtd: CfBreakdownRow | null = null;
  if (!customerId || customerId === "usps") {
    const usps = loads.filter((l) => l.customerId === "usps");
    const cfRow = (metric: "otp" | "otd"): CfBreakdownRow => {
      const late = usps.filter((l) => status(l, metric) === "LATE");
      shuttleExcluded[metric] = late.filter((l) => l.isShuttleLeg).length;
      const counted = late.filter((l) => !l.isShuttleLeg);
      const code = (l: Load) => l.cf?.[metric] ?? null;
      return {
        lateTotal: counted.length,
        cf: counted.filter((l) => code(l) === "CF").length,
        nonCf: counted.filter((l) => code(l) === "NON_CF").length,
        noFlag: counted.filter((l) => code(l) === null).length,
        cfChallenge: counted.filter((l) => code(l) === "CF_CHALLENGE").length,
      };
    };
    cfOtp = cfRow("otp");
    cfOtd = cfRow("otd");
  }

  // ---- 02 Top fail reasons ----
  const reasonRows = (metric: "otp" | "otd"): AuditReasonRow[] => {
    const counts = new Map<string, number>();
    for (const l of loads) {
      if (status(l, metric) !== "LATE") continue;
      for (const r of (metric === "otp" ? l.otpReasons : l.otdReasons) ?? []) {
        counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
      }
    }
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const out: AuditReasonRow[] = [];
    sorted.forEach(([codeKey, count], i) => {
      const rank = i > 0 && sorted[i - 1][1] === count ? out[i - 1].rank : i + 1;
      const meta = reasonMeta(codeKey);
      out.push({ rank, label: meta.label, category: meta.category, count });
    });
    return out;
  };

  // ---- 03 Drivers flagged (3+ reason entries across OTP+OTD; team credited alike) ----
  interface FlagAcc {
    driverId: string; driverName: string; teamNames: Set<string>;
    failCount: number; otpFails: AuditFailEntry[]; otdFails: AuditFailEntry[];
  }
  const flagAccs = (ls: Load[]): Map<string, FlagAcc> => {
    const map = new Map<string, FlagAcc>();
    for (const l of ls) {
      const team: [string, string][] = [];
      if (l.primaryDriverId) team.push([l.primaryDriverId, l.primaryDriverName || "Unknown"]);
      if (l.secondaryDriverId) team.push([l.secondaryDriverId, l.secondaryDriverName || "Unknown"]);
      if (!team.length) continue;
      const per = (metric: "otp" | "otd", entries: ReasonEntry[]) => {
        if (status(l, metric) !== "LATE") return;
        const fails: AuditFailEntry[] = entries.map((r) => {
          const meta = reasonMeta(r.reasonCode);
          return { lsNumber: l.lsNumber, reasonLabel: meta.label, category: meta.category, note: r.note ?? "" };
        });
        for (const [id, name] of team) {
          const acc = map.get(id) ??
            { driverId: id, driverName: name, teamNames: new Set<string>(), failCount: 0, otpFails: [], otdFails: [] };
          acc.driverName = name;
          for (const [oid, oname] of team) if (oid !== id) acc.teamNames.add(oname);
          (metric === "otp" ? acc.otpFails : acc.otdFails).push(...fails);
          acc.failCount += fails.length;
          map.set(id, acc);
        }
      };
      per("otp", l.otpReasons ?? []);
      per("otd", l.otdReasons ?? []);
    }
    return map;
  };
  const weekAccs = flagAccs(loads);
  const prevAccs = flagAccs(prevLoads);
  const flaggedSorted = [...weekAccs.values()]
    .filter((a) => a.failCount >= 3)
    .sort((a, b) => b.failCount - a.failCount || a.driverName.localeCompare(b.driverName));

  const flaggedDrivers: AuditFlaggedDriver[] = await Promise.all(flaggedSorted.map(async (acc) => {
    const [driverSnap, prevFlagSnap] = await Promise.all([
      db().collection("drivers").doc(acc.driverId).get(),
      db().collection("driverFlags").doc(`${prev.weekYear}_${prev.weekNumber}_${acc.driverId}`).get(),
    ]);
    const allTime = driverSnap.exists ? (driverSnap.data() as Driver).allTime : undefined;
    const repeat = prevFlagSnap.exists || (prevAccs.get(acc.driverId)?.failCount ?? 0) >= 3;
    return {
      driverId: acc.driverId,
      driverName: acc.driverName,
      teamNames: [...acc.teamNames],
      failCount: acc.failCount,
      allTime: { otpPct: allTime?.otpPct ?? null, otdPct: allTime?.otdPct ?? null, loads: allTime?.loads ?? 0 },
      otpFails: acc.otpFails,
      otdFails: acc.otdFails,
      repeatFromPrevWeek: repeat,
      proposedStep: repeat ? "STEP_2_WRITE_UP" : "STEP_1_CALL",
    };
  }));
  const flaggedById = new Map(flaggedDrivers.map((f) => [f.driverId, f]));

  // ---- 04 Worst performers MTD (month of the week's Sunday) ----
  const sunday = dayNumberToUtcDate(weekDayRange(wy, wn).startDay);
  const monthKey = `${sunday.getUTCFullYear()}-${String(sunday.getUTCMonth() + 1).padStart(2, "0")}`;
  const mtdRows = await fetchLoads(
    scoped(db().collection("loads").where("monthKey", "==", monthKey), customerId, operatingCompany),
  );
  interface Perf { driverId: string; driverName: string; loadsMtd: number; otpFails: number; otdFails: number }
  const perf = new Map<string, Perf>();
  for (const { load: l } of mtdRows) {
    const team: [string, string][] = [];
    if (l.primaryDriverId) team.push([l.primaryDriverId, l.primaryDriverName || "Unknown"]);
    if (l.secondaryDriverId) team.push([l.secondaryDriverId, l.secondaryDriverName || "Unknown"]);
    for (const [id, name] of team) {
      const p = perf.get(id) ?? { driverId: id, driverName: name, loadsMtd: 0, otpFails: 0, otdFails: 0 };
      p.driverName = name;
      p.loadsMtd++;
      if (status(l, "otp") === "LATE") p.otpFails++;
      if (status(l, "otd") === "LATE") p.otdFails++;
      perf.set(id, p);
    }
  }
  const worstPerformersMtd: AuditWorstPerformer[] = [...perf.values()]
    .filter((p) => p.loadsMtd >= 3 && p.otpFails + p.otdFails > 0)
    .sort((a, b) =>
      (b.otpFails + b.otdFails) - (a.otpFails + a.otdFails) || a.driverName.localeCompare(b.driverName))
    .slice(0, 10)
    .map((p) => {
      const f = flaggedById.get(p.driverId);
      const alert = f
        ? f.repeatFromPrevWeek
          ? `Monitoring — Step 1 Call/Action | Week ${wn} Repeat → Step 2`
          : "Monitoring — Step 1 Call/Action"
        : "";
      return {
        driverId: p.driverId, driverName: p.driverName, loadsMtd: p.loadsMtd,
        otpFails: p.otpFails, otdFails: p.otdFails, totalLate: p.otpFails + p.otdFails, alert,
      };
    });

  // ---- 05 Fail reason summary index ----
  const indexRows = (metric: "otp" | "otd"): AuditReasonIndexRow[] => {
    const map = new Map<string, AuditReasonIndexRow>();
    for (const l of loads) {
      if (status(l, metric) !== "LATE") continue;
      const driverNames =
        [l.primaryDriverName, l.secondaryDriverName].filter(Boolean).join(" / ") || "—";
      for (const r of (metric === "otp" ? l.otpReasons : l.otdReasons) ?? []) {
        const meta = reasonMeta(r.reasonCode);
        const row = map.get(r.reasonCode) ??
          { label: meta.label, category: meta.category, count: 0, entries: [] };
        row.count++;
        row.entries.push({ lsNumber: l.lsNumber, driverNames });
        map.set(r.reasonCode, row);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  const audit: WeeklyAudit = {
    weekYear: wy,
    weekNumber: wn,
    scope: { customerId, operatingCompany },
    rangeLabel: weekRangeLabel(wy, wn),
    generatedAt: new Date().toISOString(),
    generatedBy: request.auth?.uid ?? "unknown",
    generatedByName: (request.auth?.token?.name as string | undefined) ?? email,
    scorecard: {
      otp: metricRow(loads, "otp"),
      otd: metricRow(loads, "otd"),
      totalScored: scoredCount(loads),
      pending,
      wow: { prev: wowPrev },
      cfBreakdown: { otp: cfOtp, otd: cfOtd, shuttleExcluded },
    },
    topFailReasons: { otp: reasonRows("otp"), otd: reasonRows("otd") },
    flaggedDrivers,
    worstPerformersMtd,
    reasonIndex: { otp: indexRows("otp"), otd: indexRows("otd") },
  };

  const docId = [`${wy}_${wn}`, customerId ?? "", operatingCompany ?? ""].filter(Boolean).join("_");
  await db().collection("weeklyAudits").doc(docId).set(audit);
  return { id: docId, ...audit };
});
