/**
 * Excel import: workbook → headers/rows → mapped Loads.
 * Sheet times are wall-clock in the stop's own zone; every conversion funnels
 * through localInputToIso so DST resolves the same way as manual entry.
 */
import * as XLSX from "xlsx";
import { localInputToIso, parseWeightLbs, timeZoneForState } from "./format";
import type { Customer, CustomerId, Load, LoadStatus, OperatingCompany, Stop } from "./types";
import { LOAD_STATUSES } from "./types";

export const TARGET_FIELDS = [
  { key: "lsNumber", label: "LS #", required: false, aliases: ["ls #", "ls number", "ls num", "ls"] },
  { key: "loadNumber", label: "Load #", required: true, aliases: ["order number", "order #", "order id", "order no", "load number", "load #", "load id", "loadid"] },
  { key: "referenceNumber", label: "Reference #", required: false, aliases: ["reference number", "reference #", "reference", "ref conf", "ref #", "ref", "pickup number", "pu #", "pro number", "pro #", "bol #", "bol"] },
  { key: "customerName", label: "Customer", required: true, aliases: ["customer name", "customer", "bill to", "account", "client"] },
  { key: "equipmentType", label: "Equipment", required: false, aliases: ["equipment type", "equipment", "trailer type", "eq type"] },
  { key: "originCity", label: "Origin City", required: false, aliases: ["origin city", "shipper city", "pickup city", "pu city", "from city"] },
  { key: "originState", label: "Origin State", required: false, aliases: ["origin state", "shipper state", "pickup state", "pu state", "from state"] },
  { key: "originZip", label: "Origin Zip", required: false, aliases: ["origin zip", "shipper zip", "pickup zip", "pu zip", "from zip", "origin postal code"] },
  { key: "destCity", label: "Dest City", required: false, aliases: ["destination city", "dest city", "consignee city", "delivery city", "del city", "to city"] },
  { key: "destState", label: "Dest State", required: false, aliases: ["destination state", "dest state", "consignee state", "delivery state", "del state", "to state"] },
  { key: "destZip", label: "Dest Zip", required: false, aliases: ["destination zip", "dest zip", "consignee zip", "delivery zip", "del zip", "to zip", "destination postal code"] },
  { key: "pickupTime", label: "Pickup Appt", required: false, aliases: ["pickup time", "pickup appt", "pu appt", "pickup appointment", "pu appointment", "pickup date", "shipper appointment"] },
  { key: "shipperActualArrival", label: "PU Actual Arrival", required: false, aliases: ["shipper actual arrival time", "shipper actual arrival", "pickup actual arrival", "pu actual", "pickup actual", "actual pickup"] },
  { key: "shipperActualDeparture", label: "PU Actual Departure", required: false, aliases: ["shipper actual departure time", "shipper actual departure", "pickup actual departure", "pu actual departure", "actual pickup departure"] },
  { key: "deliveryTime", label: "Delivery Appt", required: false, aliases: ["delivery time", "delivery appt", "del appt", "del 1 appt", "delivery appointment", "delivery date", "consignee appointment"] },
  { key: "destActualArrival", label: "DEL Actual Arrival", required: false, aliases: ["consignee actual arrival time", "consignee actual arrival", "destination actual arrival", "delivery actual arrival", "del actual", "del 1 actual", "delivery actual", "actual delivery"] },
  { key: "destActualDeparture", label: "DEL Actual Departure", required: false, aliases: ["consignee actual departure time", "consignee actual departure", "destination actual departure", "delivery actual departure", "del actual departure", "actual delivery departure"] },
  { key: "status", label: "Status", required: false, aliases: ["load status", "order status", "trip status", "status"] },
  { key: "shipperName", label: "Shipper Name", required: false, aliases: ["shipper name", "shipper", "origin name", "pickup location", "origin location"] },
  { key: "shipperAddress", label: "Shipper Address", required: false, aliases: ["shipper address", "origin address", "pickup address", "pu address"] },
  { key: "consigneeName", label: "Consignee Name", required: false, aliases: ["consignee name", "consignee", "destination name", "delivery location", "dest name", "receiver"] },
  { key: "consigneeAddress", label: "Consignee Address", required: false, aliases: ["consignee address", "destination address", "delivery address", "del address", "dest address"] },
  { key: "pieces", label: "Pieces", required: false, aliases: ["pieces", "piece count", "pcs", "units", "qty", "quantity"] },
  { key: "weight", label: "Weight", required: false, aliases: ["weight lbs", "total weight", "weight", "wt"] },
  { key: "billingMiles", label: "Billing Miles", required: false, aliases: ["billing miles", "billed miles", "lane miles", "miles units", "miles", "mileage", "distance"] },
  { key: "commodity", label: "Commodity", required: false, aliases: ["commodity", "product", "freight description", "description"] },
  { key: "primaryDriver", label: "Primary Driver", required: false, aliases: ["primary driver 1", "primary driver", "driver name", "driver 1", "driver"] },
  { key: "secondaryDriver", label: "Secondary Driver", required: false, aliases: ["secondary driver 1", "secondary driver", "co driver", "codriver", "team driver", "driver 2"] },
  { key: "truckNumber", label: "Truck #", required: false, aliases: ["truck number", "truck #", "truck 1", "truck", "unit number", "unit #", "unit", "tractor"] },
  { key: "operatingCompany", label: "Op. Company", required: false, aliases: ["operating company", "op co", "opco", "company", "division", "carrier"] },
] as const;

export type TargetField = (typeof TARGET_FIELDS)[number]["key"];

export async function parseWorkbook(
  file: File,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("The workbook has no sheets.");
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1, raw: true, defval: null,
  });
  // Header row = the row (within the first 15) with the most text-looking cells.
  let headerIdx = 0, best = -1;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const score = (aoa[i] ?? []).filter(
      (c) => typeof c === "string" && c.trim().length >= 2 && !/^\d+(\.\d+)?$/.test(c.trim()),
    ).length;
    if (score > best) { best = score; headerIdx = i; }
  }
  if (best < 2) throw new Error("Could not find a header row on the first sheet.");
  const seen = new Map<string, number>();
  const headers = (aoa[headerIdx] ?? []).map((c, i) => {
    let h = c === null || c === undefined ? "" : String(c).trim();
    if (!h) h = `Column ${i + 1}`;
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n ? `${h} (${i + 1})` : h;
  });
  const rows: Record<string, unknown>[] = [];
  for (const raw of aoa.slice(headerIdx + 1)) {
    if (!raw?.some((c) => c !== null && c !== undefined && String(c).trim() !== "")) continue;
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => { rec[h] = raw[i] ?? null; });
    rows.push(rec);
  }
  return { headers, rows };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function autoMap(headers: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const used = new Set<string>();
  const hs = headers.map((h) => ({ h, n: norm(h), c: norm(h).replace(/ /g, "") }));
  // Pass 1: exact / compact-exact matches win regardless of field order.
  for (const f of TARGET_FIELDS) {
    out[f.key] = null;
    for (const a of f.aliases) {
      const na = norm(a), ca = na.replace(/ /g, "");
      const hit = hs.find((x) => !used.has(x.h) && x.n && (x.n === na || x.c === ca));
      if (hit) { out[f.key] = hit.h; used.add(hit.h); break; }
    }
  }
  // Pass 2: fuzzy (prefix / contains) for whatever is still unmapped.
  for (const f of TARGET_FIELDS) {
    if (out[f.key]) continue;
    let bestH: string | null = null, bestScore = 0;
    for (const { h, n } of hs) {
      if (used.has(h) || !n) continue;
      for (const a of f.aliases) {
        const na = norm(a);
        let s = 0;
        if (n.startsWith(`${na} `) || n.endsWith(` ${na}`)) s = 200 + na.length;
        else if (na.length >= 4 && n.includes(na)) s = 100 + na.length;
        if (s > bestScore) { bestScore = s; bestH = h; }
      }
    }
    if (bestH && bestScore >= 100) { out[f.key] = bestH; used.add(bestH); }
  }
  return out;
}

/* ---------------- cell coercion ---------------- */

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toLocaleString();
  return String(v).trim();
}

function zipStr(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v)).padStart(5, "0");
  const s = cellStr(v);
  return /^\d{3,4}$/.test(s) ? s.padStart(5, "0") : s;
}

function wall(y: number, mo: number, d: number, h: number, mi: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
}

function wallFromLocal(d: Date): string | null {
  return wall(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes());
}

/** Excel serial → wall time via the contract formula: (n − 25569) × 86400s UTC. */
function wallFromSerial(v: number): string | null {
  if (!Number.isFinite(v) || v < 20000 || v > 80000) return null;
  const d = new Date(Math.round((v - 25569) * 86400 * 1000));
  return wall(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

function wallFromText(t: string): string | null {
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) return wall(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? "0"), Number(m[5] ?? "0"));
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?)?/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    let h = Number(m[4] ?? "0");
    const ap = m[6]?.toUpperCase();
    if (ap === "P" && h < 12) h += 12;
    if (ap === "A" && h === 12) h = 0;
    return wall(y, Number(m[1]), Number(m[2]), h, Number(m[5] ?? "0"));
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : wallFromLocal(d);
}

function parseCellDate(v: unknown, timeZone: string): { iso: string | null; bad: boolean } {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return { iso: null, bad: false };
  const w = v instanceof Date ? wallFromLocal(v)
    : typeof v === "number" ? wallFromSerial(v)
    : typeof v === "string" ? wallFromText(v.trim())
    : null;
  const iso = w ? localInputToIso(w, timeZone) : null;
  return { iso, bad: iso === null };
}

/* ---------------- rows → loads ---------------- */

export function rowsToLoads(
  rows: Record<string, unknown>[],
  mapping: Record<string, string | null>,
  ctx: { customers: Customer[]; nowIso(): string },
): { loads: Load[]; problems: string[] } {
  const loads: Load[] = [];
  const problems: string[] = [];
  const byName = new Map<string, Customer>();
  for (const c of ctx.customers) {
    byName.set(norm(c.name), c);
    for (const a of c.aliases ?? []) byName.set(norm(a), c);
  }
  const seenKey = new Map<string, number>();

  rows.forEach((row, i) => {
    const rowNo = i + 1;
    const get = (f: TargetField): unknown => {
      const h = mapping[f];
      return h ? row[h] ?? null : null;
    };
    const s = (f: TargetField) => cellStr(get(f));

    const custRaw = s("customerName");
    const cust = custRaw ? byName.get(norm(custRaw)) ?? null : null;
    if (!cust) {
      problems.push(`Row ${rowNo}: customer "${custRaw || "(blank)"}" not recognized — row skipped`);
      return;
    }
    const loadNumber = s("loadNumber");
    if (!loadNumber) {
      problems.push(`Row ${rowNo}: no load number — row skipped`);
      return;
    }
    const key = `${cust.id}::${loadNumber.toUpperCase()}`;
    const dupOf = seenKey.get(key);
    if (dupOf !== undefined) {
      problems.push(`Row ${rowNo}: duplicate of row ${dupOf} (load ${loadNumber}) — row skipped`);
      return;
    }
    seenKey.set(key, rowNo);

    const date = (f: TargetField, tz: string, label: string): string | null => {
      const r = parseCellDate(get(f), tz);
      if (r.bad) problems.push(`Row ${rowNo}: unreadable ${label} "${s(f)}" — left blank`);
      return r.iso;
    };

    const puState = s("originState").toUpperCase();
    const puTz = timeZoneForState(puState);
    const delState = s("destState").toUpperCase();
    const delTz = timeZoneForState(delState);

    const pickup: Stop = {
      seq: 1, type: "PICKUP",
      locationName: s("shipperName"), address: s("shipperAddress"),
      city: s("originCity"), state: puState, zip: zipStr(get("originZip")), timeZone: puTz,
      appt: date("pickupTime", puTz, "pickup appt"), apptEnd: null,
      actualArrival: date("shipperActualArrival", puTz, "PU actual arrival"),
      actualDeparture: date("shipperActualDeparture", puTz, "PU actual departure"),
    };
    const delivery: Stop = {
      seq: 2, type: "DELIVERY",
      locationName: s("consigneeName"), address: s("consigneeAddress"),
      city: s("destCity"), state: delState, zip: zipStr(get("destZip")), timeZone: delTz,
      appt: date("deliveryTime", delTz, "delivery appt"), apptEnd: null,
      actualArrival: date("destActualArrival", delTz, "DEL actual arrival"),
      actualDeparture: date("destActualDeparture", delTz, "DEL actual departure"),
    };

    const statusRaw = s("status");
    const matchedStatus = LOAD_STATUSES.find((x) => x.toLowerCase() === statusRaw.toLowerCase()) ?? null;
    if (statusRaw && !matchedStatus) {
      problems.push(`Row ${rowNo}: status "${statusRaw}" not recognized — defaulted`);
    }
    const status: LoadStatus = matchedStatus ?? (delivery.actualArrival ? "Delivered" : "Tendered");
    const ocRaw = s("operatingCompany").toUpperCase();
    const operatingCompany: OperatingCompany = ocRaw.includes("AJG") ? "AJG" : "GH";
    const pieces = parseWeightLbs(get("pieces"));

    loads.push({
      lsNumber: s("lsNumber") || loadNumber,
      loadNumber,
      referenceNumber: s("referenceNumber"),
      customerId: cust.id as CustomerId,
      operatingCompany,
      equipmentType: s("equipmentType"),
      status,
      pieces: pieces === null ? null : Math.round(pieces),
      weightLbs: parseWeightLbs(get("weight")),
      billingMiles: parseWeightLbs(get("billingMiles")),
      commodity: s("commodity"),
      stops: [pickup, delivery],
      primaryDriverId: null,
      secondaryDriverId: null,
      primaryDriverName: s("primaryDriver"),
      secondaryDriverName: s("secondaryDriver"),
      truckNumber: s("truckNumber"),
      runType: "",
      tripNumber: "",
      isShuttleLeg: false,
      otpReasons: [],
      otdReasons: [],
      cf: { otp: null, otd: null },
    });
  });

  return { loads, problems };
}
