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

  // Deletion tombstone: the revisions subcollection survives the parent delete,
  // so the history stays answerable even for removed loads.
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
    await db().collection("loads").doc(loadId).collection("revisions")
      .doc(`${event.id}_del`).set(rev);
    return;
  }
  if (!after) return;

  // ---- 1. Recompute canonical results ----
  // Transactional against the FRESH document: v2 triggers carry no cross-event
  // ordering guarantee, so grading this event's snapshot and merging it back could
  // revert an actual keyed between the trigger and the write. The transaction
  // re-reads, grades the latest data, and retries on contention.
  const customer = await getCustomer(after.customerId);
  const fleet = await getFleet();
  await db().runTransaction(async (tx) => {
    const fresh = await tx.get(afterSnap!.ref);
    if (!fresh.exists) return;
    const cur = fresh.data() as Load;
    const graded = gradeLoad(cur, customer);
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
      stops: cur.stops,
      otp: cur.otp ?? null,
      otd: cur.otd ?? null,
      stopOnTimePct: cur.stopOnTimePct ?? null,
      transitMin: cur.transitMin ?? null,
      firstPickupAppt: cur.firstPickupAppt ?? null,
      finalDeliveryAppt: cur.finalDeliveryAppt ?? null,
      weekNumber: cur.weekNumber ?? null,
      weekYear: cur.weekYear ?? null,
      monthKey: cur.monthKey ?? null,
    };
    const stale = !deepEqual(
      JSON.parse(JSON.stringify(current)),
      JSON.parse(JSON.stringify(computed)),
    );
    if (stale) {
      tx.set(
        afterSnap!.ref,
        { ...JSON.parse(JSON.stringify(computed)), updatedAt: new Date().toISOString() },
        { merge: true },
      );
    }
  });

  // ---- 2. Append one revision for THIS write event ----
  const allChanges = diffObjects(
    before ? (JSON.parse(JSON.stringify(before)) as Record<string, unknown>) : null,
    JSON.parse(JSON.stringify(after)) as Record<string, unknown>,
  );
  if (!allChanges.length) return;

  // "otp" must not swallow "otpReasons": require end-of-path or a separator.
  const COMPUTED_PATH =
    /^((otp|otd|stopOnTimePct|transitMin|firstPickupAppt|finalDeliveryAppt|weekNumber|weekYear|monthKey)($|[.[])|stops\[\d+\]\.(onTime|dwellMin)($|[.[]))/;
  const isSystemPass =
    before !== null &&
    deepEqual(
      { u: before.updatedBy, s: before.lastWriteSource },
      { u: after.updatedBy, s: after.lastWriteSource },
    ) &&
    allChanges.every((c) => COMPUTED_PATH.test(c.path));
  // A person's revision shows only what they actually changed — grading echoes are
  // the recompute's story, not theirs.
  const changes = isSystemPass ? allChanges : allChanges.filter((c) => !COMPUTED_PATH.test(c.path));
  if (!changes.length) return;

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

  // Keyed by the CloudEvent id: at-least-once delivery retries overwrite the same
  // revision instead of duplicating it.
  await afterSnap!.ref.collection("revisions")
    .doc(event.id.replace(/[/]/g, "_"))
    .set({ ...rev, _seq: FieldValue.serverTimestamp() });
});
