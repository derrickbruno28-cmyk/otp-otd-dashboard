/**
 * Weekly driver flagging per SOP GHL-OPS-003. The system PROPOSES a step;
 * a manager confirms in the UI. This module never writes drivers.reviewState.
 */
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { SIGN_IN_DOMAIN } from "./identity";
import { DEFAULT_FLEET, weekDayRange, weekOf } from "./scoring";
import type { DriverFlag, FailReason, FleetSettings, Load, ReasonEntry } from "./types";

const db = () => getFirestore();

/** Previous Sun–Sat week; the year boundary resolved via weekDayRange math. */
function prevWeekOf(weekYear: number, weekNumber: number): { weekYear: number; weekNumber: number } {
  if (weekNumber > 1) return { weekYear, weekNumber: weekNumber - 1 };
  const prevYear = weekYear - 1;
  const prevStart = weekDayRange(weekYear, 1).startDay - 7;
  const prevYearWeek1 = weekDayRange(prevYear, 1).startDay;
  return { weekYear: prevYear, weekNumber: Math.floor((prevStart - prevYearWeek1) / 7) + 1 };
}

async function reasonLabels(): Promise<Record<string, string>> {
  const snap = await db().collection("failReasons").get();
  const out: Record<string, string> = {};
  for (const doc of snap.docs) out[doc.id] = (doc.data() as FailReason).label;
  return out;
}

interface WeekFail { lsNumber: string; loadId: string; reasons: string[] }
interface Acc {
  driverId: string; driverName: string; failCount: number;
  otpFails: WeekFail[]; otdFails: WeekFail[];
}

async function evaluateWeek(
  weekYear: number, weekNumber: number,
): Promise<{ flagged: number; driverIds: string[] }> {
  const [snap, labels] = await Promise.all([
    db().collection("loads")
      .where("weekYear", "==", weekYear)
      .where("weekNumber", "==", weekNumber)
      .get(),
    reasonLabels(),
  ]);

  const accs = new Map<string, Acc>();
  for (const doc of snap.docs) {
    const load = doc.data() as Load;
    const team: [string, string][] = [];
    if (load.primaryDriverId) team.push([load.primaryDriverId, load.primaryDriverName || "Unknown"]);
    if (load.secondaryDriverId) team.push([load.secondaryDriverId, load.secondaryDriverName || "Unknown"]);
    if (!team.length) continue;

    const perMetric = (metric: "otp" | "otd", reasons: ReasonEntry[]) => {
      if ((load[metric]?.status ?? "PENDING") !== "LATE") return;
      const fail: WeekFail = {
        lsNumber: load.lsNumber,
        loadId: doc.id,
        reasons: reasons.map((r) => labels[r.reasonCode] ?? r.reasonCode),
      };
      for (const [id, name] of team) {
        const acc = accs.get(id) ??
          { driverId: id, driverName: name, failCount: 0, otpFails: [], otdFails: [] };
        acc.driverName = name;
        (metric === "otp" ? acc.otpFails : acc.otdFails).push(fail);
        acc.failCount += reasons.length;
        accs.set(id, acc);
      }
    };
    perMetric("otp", load.otpReasons ?? []);
    perMetric("otd", load.otdReasons ?? []);
  }

  const prev = prevWeekOf(weekYear, weekNumber);
  const flagged = [...accs.values()].filter((a) => a.failCount >= 3);

  await Promise.all(flagged.map(async (acc) => {
    const ref = db().collection("driverFlags").doc(`${weekYear}_${weekNumber}_${acc.driverId}`);
    const [existingSnap, prevSnap] = await Promise.all([
      ref.get(),
      db().collection("driverFlags").doc(`${prev.weekYear}_${prev.weekNumber}_${acc.driverId}`).get(),
    ]);
    const existing = existingSnap.exists ? (existingSnap.data() as DriverFlag) : null;
    const flag: DriverFlag = {
      weekYear, weekNumber,
      driverId: acc.driverId,
      driverName: acc.driverName,
      failCount: acc.failCount,
      otpFails: acc.otpFails,
      otdFails: acc.otdFails,
      proposedStep: prevSnap.exists ? "STEP_2_WRITE_UP" : "STEP_1_CALL",
      confirmedStep: existing?.confirmedStep ?? null,
      confirmedBy: existing?.confirmedBy ?? null,
      confirmedByName: existing?.confirmedByName ?? null,
      confirmedAt: existing?.confirmedAt ?? null,
    };
    await ref.set(flag, { merge: true });
  }));

  return { flagged: flagged.length, driverIds: flagged.map((a) => a.driverId) };
}

export const evaluateDriverFlags = onCall(async (request) => {
  const email = (request.auth?.token?.email ?? "").toLowerCase();
  if (!email.endsWith(`@${SIGN_IN_DOMAIN}`)) {
    throw new HttpsError("permission-denied", `Requires an @${SIGN_IN_DOMAIN} account.`);
  }
  const { weekYear, weekNumber } = (request.data ?? {}) as { weekYear?: unknown; weekNumber?: unknown };
  if (!Number.isInteger(weekYear) || !Number.isInteger(weekNumber)) {
    throw new HttpsError("invalid-argument", "weekYear and weekNumber must be integers.");
  }
  const result = await evaluateWeek(weekYear as number, weekNumber as number);
  return { weekYear, weekNumber, ...result };
});

export const evaluateDriverFlagsScheduled = onSchedule(
  { schedule: "every monday 09:00", timeZone: "America/Chicago" },
  async () => {
    const fleetSnap = await db().collection("settings").doc("fleet").get();
    const fleet: FleetSettings = fleetSnap.exists
      ? { ...DEFAULT_FLEET, ...(fleetSnap.data() as FleetSettings) }
      : DEFAULT_FLEET;
    const current = weekOf(new Date().toISOString(), fleet.timeZone);
    const prev = prevWeekOf(current.weekYear, current.weekNumber);
    await evaluateWeek(prev.weekYear, prev.weekNumber);
  },
);
