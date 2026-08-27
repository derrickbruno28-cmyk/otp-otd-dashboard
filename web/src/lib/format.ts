/**
 * Formatting + timezone helpers. No Firebase imports.
 * Assumption (spec §10.1): appointment instants are stored UTC; each stop displays in its
 * own IANA zone, defaulted from the stop's state below and editable on the stop.
 */

export const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

export function timeZoneForState(state: string): string {
  return STATE_TIMEZONES[state.toUpperCase().trim()] ?? "America/Chicago";
}

function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset (ms) of `timeZone` from UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/** ISO instant → "YYYY-MM-DDTHH:mm" wall time in `timeZone` (for <input type="datetime-local">). */
export function isoToLocalInput(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const p = partsInZone(new Date(t), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** "YYYY-MM-DDTHH:mm" wall time in `timeZone` → ISO instant (two-pass offset resolve). */
export function localInputToIso(local: string, timeZone: string): string | null {
  if (!local) return null;
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let off = zoneOffsetMs(new Date(guess), timeZone);
  off = zoneOffsetMs(new Date(guess - off), timeZone); // second pass settles DST edges
  return new Date(guess - off).toISOString();
}

const TZ_ABBR: Record<string, string> = {
  "America/New_York": "ET", "America/Chicago": "CT", "America/Denver": "MT",
  "America/Phoenix": "MST", "America/Los_Angeles": "PT", "America/Anchorage": "AKT",
  "Pacific/Honolulu": "HST", "America/Boise": "MT", "America/Detroit": "ET",
  "America/Indiana/Indianapolis": "ET",
};
export function tzAbbr(timeZone: string): string {
  return TZ_ABBR[timeZone] ?? timeZone.split("/").pop()!.replace(/_/g, " ");
}

/** "08/09 14:30 CT" — the standard stamp used in tables. */
export function fmtDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const p = partsInZone(new Date(t), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(p.month)}/${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${tzAbbr(timeZone)}`;
}

export function fmtDate(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone, month: "short", day: "numeric", year: "numeric",
  }).format(new Date(iso));
}

/** "81.9%" (one decimal) or "—". Always render pendingCount beside it. */
export function fmtPct(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}

/** "−15.1 pts" / "+2.0 pts" with a true minus sign. */
export function fmtGapPts(gap: number | null | undefined): string {
  if (gap === null || gap === undefined) return "—";
  const sign = gap < 0 ? "−" : "+";
  return `${sign}${Math.abs(gap).toFixed(1)} pts`;
}

/** Signed minutes: "+47m", "−12m", "1h 14m late". */
export function fmtVariance(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  const sign = min < 0 ? "−" : "+";
  const a = Math.abs(min);
  return a >= 60 ? `${sign}${Math.floor(a / 60)}h ${a % 60}m` : `${sign}${a}m`;
}

export function fmtDwell(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  const a = Math.abs(min);
  return a >= 60 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${a}m`;
}

export function parseWeightLbs(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const m = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 8)}`;
}
