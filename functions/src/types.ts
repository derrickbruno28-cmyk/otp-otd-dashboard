/**
 * Domain types — the contract for the whole app.
 * The copy at functions/src/types.ts must stay byte-identical (scoring.test.ts enforces it).
 *
 * All instants are ISO-8601 UTC strings ("2026-08-09T14:30:00.000Z").
 * Wall-clock display happens in each stop's IANA time zone.
 */

export type Role = "viewer" | "ops" | "manager" | "admin";
export type CustomerId = "aeronet" | "source-one" | "usps" | "milwaukee-tool";
export type OperatingCompany = "AJG" | "GH";
export type StopType = "PICKUP" | "DELIVERY";
export type OnTimeStatus = "PENDING" | "EARLY" | "ON_TIME" | "LATE";
export type CfCode = "CF" | "NON_CF" | "CF_CHALLENGE";
export type RevisionSource = "manual" | "tender" | "import" | "system";
export type ReasonCategory =
  | "DRIVER" | "SHIPPER" | "DISPATCH" | "BROKERAGE"
  | "MECHANICAL" | "EXTERNAL" | "PLANNING" | "COMPLIANCE";

export const LOAD_STATUSES = [
  "Tendered", "Dispatched", "At Shipper", "In Transit",
  "At Consignee", "Delivered", "Cancelled",
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

export const CUSTOMER_IDS: CustomerId[] = ["aeronet", "source-one", "usps", "milwaukee-tool"];
export const OPERATING_COMPANIES: OperatingCompany[] = ["AJG", "GH"];

export interface ReasonEntry {
  reasonCode: string;      // failReasons doc id — always chosen from the taxonomy, never typed
  note: string;            // free text
  enteredBy: string;       // uid
  enteredByName: string;
  enteredAt: string;       // ISO
}

/** Computed per-metric result. Function-write-only on the load document. */
export interface MetricResult {
  status: OnTimeStatus;
  varianceMin: number | null;  // signed; negative = early
  deadline: string | null;     // ISO — (apptEnd ?? appt) + grace
}

export interface StopOnTime extends MetricResult {}

export interface Stop {
  seq: number;               // 1-based
  type: StopType;
  locationName: string;
  address: string;
  city: string;
  state: string;             // 2-letter
  zip: string;               // string — leading zeros preserved
  timeZone: string;          // IANA, defaulted from state
  appt: string | null;       // ISO
  apptEnd: string | null;    // ISO — window close; normally null
  actualArrival: string | null;   // ISO — grades this stop
  actualDeparture: string | null; // ISO — drives dwell
  /** Computed (server canonical; client recomputes locally for instant display). */
  onTime?: StopOnTime;
  dwellMin?: number | null;
}

export interface Load {
  id?: string;               // Firestore doc id (not stored in the doc)
  lsNumber: string;          // ONE per load — the identifier every report quotes
  loadNumber: string;        // dedupe key with customerId
  referenceNumber: string;   // customer's reference / pickup number
  customerId: CustomerId;
  operatingCompany: OperatingCompany;
  equipmentType: string;
  status: LoadStatus;
  pieces: number | null;
  weightLbs: number | null;
  billingMiles: number | null;
  commodity: string;
  stops: Stop[];             // min 2, ordered by seq

  primaryDriverId: string | null;
  secondaryDriverId: string | null;
  primaryDriverName: string;    // denormalized for display/reports
  secondaryDriverName: string;

  truckNumber: string;
  runType: string;
  tripNumber: string;
  isShuttleLeg: boolean;     // excluded from CF breakdown; still scored on the metric earned

  /** Manual miss attribution — client-writable, per metric. */
  otpReasons: ReasonEntry[];
  otdReasons: ReasonEntry[];

  /** CF determination — USPS only (customer.cfCodingEnabled). null = not yet coded (a to-do). */
  cf: { otp: CfCode | null; otd: CfCode | null };

  /** ---- Computed. Function-write-only; firestore.rules reject client writes. ---- */
  otp?: MetricResult;
  otd?: MetricResult;
  stopOnTimePct?: number | null;   // 0..1 across every graded stop
  transitMin?: number | null;
  firstPickupAppt?: string | null;
  finalDeliveryAppt?: string | null;
  weekNumber?: number | null;      // Sun–Sat weeks; week 1 contains Jan 1 (fleet tz)
  weekYear?: number | null;
  monthKey?: string | null;        // "2026-08" in fleet tz

  /** Provenance. */
  createdBy?: string;
  createdByName?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedByName?: string;
  updatedAt?: string;
  lastWriteSource?: RevisionSource; // set by the client on each save; 'system' for recomputes
  batchId?: string | null;
  tenderId?: string | null;
}

export interface Customer {
  id?: CustomerId | string;
  name: string;
  aliases: string[];
  /** null inherits the fleet default. */
  targets: { otp: number | null; otd: number | null };
  graceMinutes: { pickup: number; delivery: number };
  earlyToleranceHours: number;     // arrive earlier than appt - this => EARLY
  earlyCountsAsMiss: boolean;
  cfCodingEnabled: boolean;        // USPS only
  active: boolean;
  sortOrder: number;
}

export interface FleetSettings {
  targets: { otp: number; otd: number };   // fleet default 0.97 / 0.95
  timeZone: string;                        // fleet HQ zone for week/month bucketing
  retainTenderPdf: boolean;
  tenderRetentionDays: number | null;
  signInDomain: string;                    // ghlogisticsllc.com
}

export interface FailReason {
  id?: string;              // code, e.g. "driver-made-multiple-stops"
  label: string;            // verbatim, e.g. "Driver – Made Multiple Stops"
  category: ReasonCategory; // DRIVER drives the coaching flag (the audit's gold/bold rule)
  appliesTo: "OTP" | "OTD" | "BOTH";
  active: boolean;
  sortOrder: number;
}

export interface DriverAllTime {
  loads: number;
  otpOnTime: number; otpLate: number;
  otdOnTime: number; otdLate: number;
  otpPct: number | null; otdPct: number | null;
}

export type ReviewState = "NONE" | "STEP_1_CALL" | "STEP_2_WRITE_UP";

export interface Driver {
  id?: string;
  name: string;
  operatingCompany: OperatingCompany;
  active: boolean;
  allTime?: DriverAllTime;
  reviewState: ReviewState;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string;
}

export interface AppUser {
  id?: string;              // uid
  displayName: string;
  email: string;
  photoURL: string;
  role: Role;
  lastSignInAt: string;
}

export interface RevisionChange { path: string; before: unknown; after: unknown; }

export interface Revision {
  id?: string;
  at: string;
  uid: string;
  displayName: string;
  email: string;
  source: RevisionSource;
  summary: string;
  changes: RevisionChange[];
}

export interface FieldExtraction<T> {
  value: T | null;          // null = not found; NEVER guessed
  confidence: "high" | "low";
  sourceText: string | null; // verbatim text the model read
  labelRead: string | null;  // which label it was under (Load #, Order #, Pro #, PU #, Ref #, BOL #…)
}

export interface TenderParsedStop {
  type: FieldExtraction<StopType>;
  locationName: FieldExtraction<string>;
  address: FieldExtraction<string>;
  city: FieldExtraction<string>;
  state: FieldExtraction<string>;
  zip: FieldExtraction<string>;
  appt: FieldExtraction<string>;     // ISO or raw string as printed
  apptEnd: FieldExtraction<string>;
}

export interface TenderParse {
  loadNumber: FieldExtraction<string>;
  referenceNumber: FieldExtraction<string>;
  customerName: FieldExtraction<string>;
  equipmentType: FieldExtraction<string>;
  pieces: FieldExtraction<number>;
  weightLbs: FieldExtraction<number>;
  billingMiles: FieldExtraction<number>;
  commodity: FieldExtraction<string>;
  stops: TenderParsedStop[];         // printed order — a 4-stop tender produces 4 stops
}

export type TenderStatus = "uploaded" | "parsing" | "parsed" | "error" | "confirmed" | "discarded";

export interface Tender {
  id?: string;
  fileName: string;
  storagePath: string | null;  // null once stripped (retainTenderPdf off)
  sha256: string | null;
  sizeBytes: number;
  status: TenderStatus;
  parsed: TenderParse | null;
  error: string | null;
  loadId: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
}

export interface ImportBatch {
  id?: string;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  rowCount: number;
  createdLoadIds: string[];
  updatedLoads: { id: string; previousData: Record<string, unknown> }[];
  rolledBackAt: string | null;
}

export interface DriverFlag {
  id?: string;               // `${weekYear}_${weekNumber}_${driverId}`
  weekYear: number;
  weekNumber: number;
  driverId: string;
  driverName: string;
  failCount: number;         // reason entries across OTP + OTD that week
  otpFails: { lsNumber: string; loadId: string; reasons: string[] }[];
  otdFails: { lsNumber: string; loadId: string; reasons: string[] }[];
  proposedStep: ReviewState;    // proposed by the system
  confirmedStep: ReviewState | null;  // a manager confirms; never automatic
  confirmedBy: string | null;
  confirmedByName: string | null;
  confirmedAt: string | null;
}

/** Snapshot stored by generateWeeklyAudit. */
export interface WeeklyAudit {
  id?: string;
  weekYear: number;
  weekNumber: number;
  scope: { customerId: CustomerId | null; operatingCompany: OperatingCompany | null };
  rangeLabel: string;            // "Aug 9–15, 2026"
  generatedAt: string;
  generatedBy: string;
  generatedByName: string;
  scorecard: {
    otp: AuditMetricRow; otd: AuditMetricRow;
    totalScored: number; pending: number;
    wow: { prev: { otpPct: number | null; otpLate: number; otdPct: number | null; otdLate: number; totalScored: number; pending: number } | null };
    cfBreakdown: {
      otp: CfBreakdownRow | null; otd: CfBreakdownRow | null;  // null when scope excludes USPS
      shuttleExcluded: { otp: number; otd: number };
    };
  };
  topFailReasons: { otp: AuditReasonRow[]; otd: AuditReasonRow[] };
  flaggedDrivers: AuditFlaggedDriver[];
  worstPerformersMtd: AuditWorstPerformer[];
  reasonIndex: { otp: AuditReasonIndexRow[]; otd: AuditReasonIndexRow[] };
}

export interface AuditMetricRow {
  onTime: number; late: number; rate: number | null;
  target: number; gapPts: number | null;
}
export interface CfBreakdownRow {
  lateTotal: number; cf: number; nonCf: number; noFlag: number; cfChallenge: number;
}
export interface AuditReasonRow {
  rank: number; label: string; category: ReasonCategory; count: number;
}
export interface AuditFlaggedDriver {
  driverId: string; driverName: string; teamNames: string[];
  failCount: number;
  allTime: { otpPct: number | null; otdPct: number | null; loads: number };
  otpFails: AuditFailEntry[]; otdFails: AuditFailEntry[];
  repeatFromPrevWeek: boolean;
  proposedStep: ReviewState;
}
export interface AuditFailEntry {
  lsNumber: string; reasonLabel: string; category: ReasonCategory; note: string;
}
export interface AuditWorstPerformer {
  driverId: string; driverName: string;
  loadsMtd: number; otpFails: number; otdFails: number; totalLate: number;
  alert: string;
}
export interface AuditReasonIndexRow {
  label: string; category: ReasonCategory; count: number;
  entries: { lsNumber: string; driverNames: string }[];
}

/** Load fields only Cloud Functions may write — mirrored in firestore.rules. */
export const COMPUTED_LOAD_KEYS = [
  "otp", "otd", "stopOnTimePct", "transitMin",
  "firstPickupAppt", "finalDeliveryAppt",
  "weekNumber", "weekYear", "monthKey", "updatedAt",
] as const;

/** USPS Ghost Shutdown: late on delivery and not yet delivered → hourly customer updates. */
export const GHOST_SHUTDOWN_CUSTOMER: CustomerId = "usps";
