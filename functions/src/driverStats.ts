/**
 * All-time individual driver stats, recomputed on every load write.
 * Primary and secondary drivers are credited the same loads; PENDING (and EARLY,
 * which DriverAllTime does not count) stays out of the percentage denominators.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";
import type { DriverAllTime, Load } from "./types";

const db = () => getFirestore();

async function recalcOne(driverId: string): Promise<void> {
  const [asPrimary, asSecondary] = await Promise.all([
    db().collection("loads").where("primaryDriverId", "==", driverId).get(),
    db().collection("loads").where("secondaryDriverId", "==", driverId).get(),
  ]);
  const byId = new Map<string, Load>();
  for (const doc of [...asPrimary.docs, ...asSecondary.docs]) {
    byId.set(doc.id, doc.data() as Load);
  }

  let otpOnTime = 0, otpLate = 0, otdOnTime = 0, otdLate = 0;
  for (const load of byId.values()) {
    const otp = load.otp?.status ?? "PENDING";
    if (otp === "ON_TIME") otpOnTime++;
    else if (otp === "LATE") otpLate++;
    const otd = load.otd?.status ?? "PENDING";
    if (otd === "ON_TIME") otdOnTime++;
    else if (otd === "LATE") otdLate++;
  }
  const allTime: DriverAllTime = {
    loads: byId.size,
    otpOnTime, otpLate, otdOnTime, otdLate,
    otpPct: otpOnTime + otpLate ? otpOnTime / (otpOnTime + otpLate) : null,
    otdPct: otdOnTime + otdLate ? otdOnTime / (otdOnTime + otdLate) : null,
  };
  await db().collection("drivers").doc(driverId).set({ allTime }, { merge: true });
}

export const recalcDriverStats = onDocumentWritten("loads/{loadId}", async (event) => {
  const before = event.data?.before?.exists ? (event.data.before.data() as Load) : null;
  const after = event.data?.after?.exists ? (event.data.after.data() as Load) : null;
  const ids = new Set<string>();
  for (const load of [before, after]) {
    if (!load) continue;
    if (load.primaryDriverId) ids.add(load.primaryDriverId);
    if (load.secondaryDriverId) ids.add(load.secondaryDriverId);
  }
  if (!ids.size) return;
  await Promise.all([...ids].map(recalcOne));
});
