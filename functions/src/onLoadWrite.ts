/**
 * Canonical grading + edit history. Two-pass by design:
 *  - a client write triggers a recompute; if computed fields changed, the function
 *    writes them (source of truth), which triggers this again;
 *  - the second pass sees computed fields already equal and writes nothing, so
 *    there is no loop. Each pass that changed anything appends one revision:
 *    the client's own diff under their identity, the recompute diff as 'system'.
 */
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { deepEqual, diffObjects, summarizeChanges } from "./diff";
import { DEFAULT_FLEET, gradeLoad, weekOf } from "./scoring";
import type { Customer, FleetSettings, Load, Revision } from "./types";

const db = () => getFirestore();

async function getCustomer(id: string): Promise<Customer | null> {
  const snap = await db().collection("customers").doc(id).get();
  return snap.exists ? (snap.data() as Customer) : null;
}
async function getFleet(): Promise<FleetSettings> {
  const snap = await db().collection("settings").doc("fleet").get();
  return snap.exists ? { ...DEFAULT_FLEET, ...(snap.data() as FleetSettings) } : DEFAULT_FLEET;
}

export const onLoadWrite = onDocumentWritten("loads/{loadId}", async (event) => {
  const beforeSnap = event.data?.before;
  const afterSnap = event.data?.after;
  const before = beforeSnap?.exists ? (beforeSnap.data() as Load) : null;
  const after = afterSnap?.exists ? (afterSnap.data() as Load) : null;
  const loadId = event.params.loadId;

  // Deletion: record it in the history's collection is gone with the doc — write an
  // auditLog-style tombstone under importBatches? No: deletes are manager-only and rare;
  // the revision subcollection survives the parent delete in Firestore, so append there.
  if (before && !after) {
    const rev: Revision = {
      at: new Date().toISOString(),
      uid: "system",
      displayName: "System",
      email: "",
      source: "system",
      summary: `Load ${before.lsNumber || loadId} deleted`,
      changes: [{ path: "(document)", before: "exists", after: "deleted" }],
    };
    await db().collection("loads").doc(loadId).collection("revisions").add(rev);
    return;
  }
  if (!after) return;

  // ---- 1. Recompute canonical results ----
  const customer = await getCustomer(after.customerId);
  const fleet = await getFleet();
  const graded = gradeLoad(after, customer);
  const week = graded.firstPickupAppt
    ? weekOf(graded.firstPickupAppt, fleet.timeZone)
    : { weekYear: null, weekNumber: null, monthKey: null };

  const computed = {
    stops: graded.stops,
    otp: graded.otp,
    otd: graded.otd,
    stopOnTimePct: graded.stopOnTimePct,
    transitMin: graded.transitMin,
    firstPickupAppt: graded.firstPickupAppt,
    finalDeliveryAppt: graded.finalDeliveryAppt,
    weekNumber: week.weekNumber,
    weekYear: week.weekYear,
    monthKey: week.monthKey,
  };

  const current = {
    stops: after.stops,
    otp: after.otp ?? null,
    otd: after.otd ?? null,
    stopOnTimePct: after.stopOnTimePct ?? null,
    transitMin: after.transitMin ?? null,
    firstPickupAppt: after.firstPickupAppt ?? null,
    finalDeliveryAppt: after.finalDeliveryAppt ?? null,
    weekNumber: after.weekNumber ?? null,
    weekYear: after.weekYear ?? null,
    monthKey: after.monthKey ?? null,
  };

  const stale = !deepEqual(
    JSON.parse(JSON.stringify(current)),
    JSON.parse(JSON.stringify(computed)),
  );
  if (stale) {
    await afterSnap!.ref.set(
      { ...JSON.parse(JSON.stringify(computed)), updatedAt: new Date().toISOString() },
      { merge: true },
    );
  }

  // ---- 2. Append one revision for THIS write event ----
  const changes = diffObjects(
    before ? (JSON.parse(JSON.stringify(before)) as Record<string, unknown>) : null,
    JSON.parse(JSON.stringify(after)) as Record<string, unknown>,
  );
  if (!changes.length) return;

  const isSystemPass =
    before !== null &&
    deepEqual(
      { u: before.updatedBy, s: before.lastWriteSource },
      { u: after.updatedBy, s: after.lastWriteSource },
    ) &&
    changes.every((c) =>
      /^(otp|otd|stopOnTimePct|transitMin|firstPickupAppt|finalDeliveryAppt|weekNumber|weekYear|monthKey|stops\[\d+\]\.(onTime|dwellMin))/.test(c.path));

  const rev: Revision = isSystemPass
    ? {
        at: new Date().toISOString(),
        uid: "system",
        displayName: "System",
        email: "",
        source: "system",
        summary: `Recomputed: ${summarizeChanges(changes)}`,
        changes,
      }
    : {
        at: new Date().toISOString(),
        uid: after.updatedBy ?? "unknown",
        displayName: after.updatedByName ?? "Unknown",
        email: "",
        source: after.lastWriteSource ?? "manual",
        summary: before === null
          ? `Load ${after.lsNumber || after.loadNumber || loadId} created`
          : summarizeChanges(changes),
        changes,
      };

  await afterSnap!.ref.collection("revisions").add({ ...rev, _seq: FieldValue.serverTimestamp() });
});
