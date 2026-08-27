/**
 * Loads data access. One live subscription (recent first), filtered client-side —
 * at ~150 loads/week this is comfortably inside client aggregation (spec §10.8).
 * Every write goes through saveLoad/updateLoadFields so provenance is always stamped
 * and computed fields are never written from the client (rules reject them anyway).
 */
import {
  addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, updateDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import { nowIso } from "./format";
import { gradeLoad, isGhostShutdown, weekOf } from "./scoring";
import type {
  Customer, FleetSettings, Load, OnTimeStatus, OperatingCompany, RevisionSource,
} from "./types";
import { COMPUTED_LOAD_KEYS } from "./types";

export const LOADS_LIMIT = 1500;

export function subscribeLoads(
  onLoads: (loads: Load[]) => void,
  onError: (message: string) => void,
): () => void {
  const q = query(collection(db, "loads"), orderBy("createdAt", "desc"), limit(LOADS_LIMIT));
  return onSnapshot(
    q,
    (snap) => onLoads(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Load) }))),
    (e) => onError(String(e?.message ?? e)),
  );
}

/** Strip computed keys + id so a client write can never carry them. */
export function clientWritable(load: Partial<Load>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...load };
  delete copy.id;
  for (const k of COMPUTED_LOAD_KEYS) delete copy[k];
  return copy;
}

export interface Signer { uid: string; name: string; }

export async function createLoad(
  load: Load, signer: Signer, source: RevisionSource,
): Promise<string> {
  const data = clientWritable({
    ...load,
    createdBy: signer.uid,
    createdByName: signer.name,
    createdAt: nowIso(),
    updatedBy: signer.uid,
    updatedByName: signer.name,
    lastWriteSource: source,
  });
  const ref = await addDoc(collection(db, "loads"), data);
  return ref.id;
}

export async function updateLoad(
  id: string, fields: Partial<Load>, signer: Signer, source: RevisionSource,
): Promise<void> {
  await updateDoc(doc(db, "loads", id), {
    ...clientWritable(fields),
    updatedBy: signer.uid,
    updatedByName: signer.name,
    lastWriteSource: source,
  });
}

export async function deleteLoad(id: string): Promise<void> {
  await deleteDoc(doc(db, "loads", id));
}

/* ---------------- filtering ---------------- */

export interface LoadFilters {
  customerId: string | null;            // null = all
  operatingCompany: OperatingCompany | null;
  status: string | null;
  otp: OnTimeStatus | null;
  otd: OnTimeStatus | null;
  reasonCode: string | null;
  reasonCategory: string | null;
  driverId: string | null;
  weekKey: string | null;               // "2026_33"
  from: string | null;                  // "YYYY-MM-DD" vs firstPickupAppt (fleet tz day)
  to: string | null;
  search: string;
  quick: "ghost" | "needsCf" | "missingReason" | "pendingActuals" | null;
}

export const EMPTY_FILTERS: LoadFilters = {
  customerId: null, operatingCompany: null, status: null, otp: null, otd: null,
  reasonCode: null, reasonCategory: null, driverId: null, weekKey: null,
  from: null, to: null, search: "", quick: null,
};

/**
 * Grade locally for display so a just-saved edit is correct before the Cloud Function
 * round-trips. The server result remains canonical and overwrites via the snapshot.
 */
export function withLocalGrades(
  loads: Load[], customersById: Record<string, Customer>, fleet: FleetSettings,
): Load[] {
  return loads.map((l) => {
    const g = gradeLoad(l, customersById[l.customerId] ?? null);
    const week = g.firstPickupAppt ? weekOf(g.firstPickupAppt, fleet.timeZone) : null;
    return {
      ...l,
      stops: g.stops,
      otp: g.otp, otd: g.otd,
      stopOnTimePct: g.stopOnTimePct, transitMin: g.transitMin,
      firstPickupAppt: g.firstPickupAppt, finalDeliveryAppt: g.finalDeliveryAppt,
      weekNumber: week?.weekNumber ?? null, weekYear: week?.weekYear ?? null,
      monthKey: week?.monthKey ?? null,
    };
  });
}

export function needsCfCoding(load: Load, customersById: Record<string, Customer>): boolean {
  if (!customersById[load.customerId]?.cfCodingEnabled || load.isShuttleLeg) return false;
  const otpNeeds = load.otp?.status === "LATE" && !load.cf?.otp;
  const otdNeeds = load.otd?.status === "LATE" && !load.cf?.otd;
  return otpNeeds || otdNeeds;
}

export function missingReason(load: Load): boolean {
  const otpMissing = load.otp?.status === "LATE" && load.otpReasons.length === 0;
  const otdMissing = load.otd?.status === "LATE" && load.otdReasons.length === 0;
  return otpMissing || otdMissing;
}

export function pendingActuals(load: Load): boolean {
  return load.otp?.status === "PENDING" || load.otd?.status === "PENDING";
}

export function filterLoads(
  loads: Load[],
  f: LoadFilters,
  customersById: Record<string, Customer>,
  fleetTimeZone: string,
  reasonCategoryByCode: Record<string, string> = {},
): Load[] {
  const needle = f.search.trim().toLowerCase();
  return loads.filter((l) => {
    if (f.customerId && l.customerId !== f.customerId) return false;
    if (f.operatingCompany && l.operatingCompany !== f.operatingCompany) return false;
    if (f.status && l.status !== f.status) return false;
    if (f.otp && (l.otp?.status ?? "PENDING") !== f.otp) return false;
    if (f.otd && (l.otd?.status ?? "PENDING") !== f.otd) return false;
    if (f.reasonCode &&
      !l.otpReasons.some((r) => r.reasonCode === f.reasonCode) &&
      !l.otdReasons.some((r) => r.reasonCode === f.reasonCode)) return false;
    if (f.reasonCategory) {
      const cats = [...l.otpReasons, ...l.otdReasons]
        .map((r) => reasonCategoryByCode[r.reasonCode]);
      if (!cats.includes(f.reasonCategory)) return false;
    }
    if (f.driverId && l.primaryDriverId !== f.driverId && l.secondaryDriverId !== f.driverId) return false;
    if (f.weekKey && `${l.weekYear}_${l.weekNumber}` !== f.weekKey) return false;
    if (f.from || f.to) {
      const appt = l.firstPickupAppt;
      if (!appt) return false;
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: fleetTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(appt));
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    if (f.quick === "ghost" && !isGhostShutdown(l)) return false;
    if (f.quick === "needsCf" && !needsCfCoding(l, customersById)) return false;
    if (f.quick === "missingReason" && !missingReason(l)) return false;
    if (f.quick === "pendingActuals" && !pendingActuals(l)) return false;
    if (needle) {
      const hay = [
        l.lsNumber, l.loadNumber, l.referenceNumber,
        l.primaryDriverName, l.secondaryDriverName, l.truckNumber,
        ...l.stops.flatMap((s) => [s.city, s.locationName]),
      ].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
