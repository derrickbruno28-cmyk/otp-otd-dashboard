/** CSV export of the filtered view — sheet-compatible (one row per load, matching the
 *  original OTD sheet headers) or flat (one row per stop). */
import { fmtDwell, isoToLocalInput } from "./format";
import type { Customer, Load } from "./types";

function esc(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

function local(iso: string | null | undefined, tz: string): string {
  return iso ? isoToLocalInput(iso, tz).replace("T", " ") : "";
}

/** One row per load — the original sheet's shape, plus the app's identifiers. */
export function loadsToSheetCsv(
  loads: Load[], customersById: Record<string, Customer>,
): string {
  const header = [
    "LS Number", "Load Number", "Reference Number", "Customer Name", "Operating Company",
    "Equipment Type", "Origin - City", "Origin - State", "Origin - Zip",
    "Destination - City", "Destination - State", "Destination - Zip",
    "Pickup Time", "Shipper Actual Arrival Time", "Shipper Actual Departure Time",
    "Delivery Time", "Destination Actual Arrival Time", "Destination Actual Departure Time",
    "Order Status", "Shipper Location Name", "Shipper Street Address",
    "Consignee Location Name", "Consignee Street Address",
    "Cases/Piece Count", "Weight (lbs)", "Billing Distance", "Commodity",
    "On Time Pickup", "On Time Delivery", "OTP Variance (min)", "OTD Variance (min)",
    "OTP Reasons", "OTD Reasons", "CF (OTP)", "CF (OTD)",
    "Primary Driver", "Secondary Driver", "Truck", "Stops", "Week",
  ];
  const rows: unknown[][] = [header];
  for (const l of loads) {
    const pickups = l.stops.filter((s) => s.type === "PICKUP");
    const deliveries = l.stops.filter((s) => s.type === "DELIVERY");
    const pu = pickups[0];
    const del = deliveries[deliveries.length - 1];
    rows.push([
      l.lsNumber, l.loadNumber, l.referenceNumber,
      customersById[l.customerId]?.name ?? l.customerId, l.operatingCompany,
      l.equipmentType,
      pu?.city ?? "", pu?.state ?? "", pu?.zip ?? "",
      del?.city ?? "", del?.state ?? "", del?.zip ?? "",
      local(pu?.appt, pu?.timeZone ?? "America/Chicago"),
      local(pu?.actualArrival, pu?.timeZone ?? "America/Chicago"),
      local(pu?.actualDeparture, pu?.timeZone ?? "America/Chicago"),
      local(del?.appt, del?.timeZone ?? "America/Chicago"),
      local(del?.actualArrival, del?.timeZone ?? "America/Chicago"),
      local(del?.actualDeparture, del?.timeZone ?? "America/Chicago"),
      l.status,
      pu?.locationName ?? "", pu?.address ?? "",
      del?.locationName ?? "", del?.address ?? "",
      l.pieces ?? "", l.weightLbs ?? "", l.billingMiles ?? "", l.commodity,
      l.otp?.status ?? "PENDING", l.otd?.status ?? "PENDING",
      l.otp?.varianceMin ?? "", l.otd?.varianceMin ?? "",
      l.otpReasons.map((r) => r.reasonCode).join("; "),
      l.otdReasons.map((r) => r.reasonCode).join("; "),
      l.cf?.otp ?? "", l.cf?.otd ?? "",
      l.primaryDriverName, l.secondaryDriverName, l.truckNumber,
      l.stops.length, l.weekYear && l.weekNumber ? `${l.weekYear} W${l.weekNumber}` : "",
    ]);
  }
  return rowsToCsv(rows);
}

/** One row per stop. */
export function loadsToStopCsv(loads: Load[]): string {
  const header = [
    "LS Number", "Load Number", "Customer", "Operating Company", "Stop #", "Type",
    "Location", "Address", "City", "State", "Zip", "Time Zone",
    "Appointment", "Window Close", "Actual Arrival", "Actual Departure",
    "On Time", "Variance (min)", "Dwell",
  ];
  const rows: unknown[][] = [header];
  for (const l of loads) {
    for (const s of l.stops) {
      rows.push([
        l.lsNumber, l.loadNumber, l.customerId, l.operatingCompany, s.seq, s.type,
        s.locationName, s.address, s.city, s.state, s.zip, s.timeZone,
        local(s.appt, s.timeZone), local(s.apptEnd, s.timeZone),
        local(s.actualArrival, s.timeZone), local(s.actualDeparture, s.timeZone),
        s.onTime?.status ?? "PENDING", s.onTime?.varianceMin ?? "", fmtDwell(s.dwellMin),
      ]);
    }
  }
  return rowsToCsv(rows);
}

export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
