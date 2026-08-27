# Route Performance Tracker — Build Spec

Asset Operations OTP/OTD tracker for AeroNet, Source One, USPS, and Milwaukee Tool.
Backend: Firebase. Status: spec approved for build, not yet implemented.

---

## 1. What this app is for

Operations logs the **actual** pickup and delivery events against the **scheduled**
appointments on the load tender, so we can state — per customer, per lane, per week —
whether we hit the appointment.

Two numbers drive everything:

- **OTP (On Time Pickup)** — did the truck arrive at the shipper by the pickup appointment?
- **OTD (On Time Delivery)** — did the truck arrive at the consignee by the delivery appointment?

Everything else in the app exists to get those two numbers entered fast and keep them honest.

---

## 2. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Backend | Firebase (Firestore + Auth + Functions + Hosting + Storage) | Stated requirement |
| Existing Postgres/Render app | Retired after cutover; new build is fresh | See §3 |
| **Stops** | **Multi-stop supported.** Normal load is one pickup + one delivery; the model does not assume it | Confirmed |
| **Appointment windows** | **Straight appointment times in normal operation.** `apptEnd` exists on every stop, stays empty, and is enterable when a window shows up | Confirmed |
| **Identifiers** | **Load Number** and **Reference Number** are separate adjacent columns; **LS Number** is per stop | Confirmed |
| OTP graded on | **Arrival at the shipper** vs pickup appointment | Standard; does not penalize the driver for the shipper's dock dwell |
| Departure times | Still captured, drive the dwell metric | Needed for detention conversations |
| Grace window | Per customer, configurable, **default 15 min** | USPS SLAs differ from a manufacturer's |
| Blank actuals | Count as **PENDING**, excluded from the percentage | Current sheet counts them as misses |
| Tender autofill | Drag-and-drop **PDF** | Stated requirement |
| Service Type column | Dropped | Stated requirement |

---

## 3. Why a fresh build rather than merging the existing dashboard

The current app tracks **assets** — `truck_num`, `primary_driver`, `secondary_driver`,
`run_type`, `del1/del2`. The new sheet tracks **orders** — customer, shipper/consignee
names and street addresses, pieces, weight, commodity, billing distance. There is no
customer column in the old schema and no truck/driver column in the new sheet, so a
merge today means hand-reconciling historical rows that nobody can reconcile reliably.

The build is therefore a fresh Firestore app, **but the load document carries the asset
fields (`truckNumber`, `primaryDriver`, `secondaryDriver`, `runType`, `tripNumber`) from
day one as optional**. That turns the eventual unification into a data migration instead
of a rewrite. Keep Render running read-only until the new app is trusted, then retire it.

Note that the old `del1/del2` columns were the previous attempt at multi-stop. This model
replaces them with a proper stops array, which is the other reason not to inherit that schema.

---

## 4. Data model

A **load** holds the commercial and freight facts. A **stop** holds an appointment and what
actually happened there. Every load has at least two stops.

### 4.1 Load

`Filled by` legend: **T** = tender autofill, **M** = manual entry by ops, **C** = computed server-side.

| Sheet column | App field | Type | Filled by |
|---|---|---|---|
| Order Number | `loadNumber` | string — **the load number** | T |
| *(new)* | `referenceNumber` | string — reference / pickup number, sits next to load number | T/M |
| Customer Name | `customerId` | enum: aeronet / source-one / usps / milwaukee-tool | T/M |
| Equipment Type | `equipmentType` | enum | T |
| Order Status | `status` | enum: Tendered / Dispatched / At Shipper / In Transit / At Consignee / Delivered / Cancelled | M |
| Cases/Piece Count | `pieces` | integer | T |
| Weight | `weightLbs` | number — parse `"8250.000lbs"` to `8250` | T |
| Billing Distance | `billingMiles` | number | T |
| Commodity | `commodity` | string | T |
| Service Type | *dropped* | — | — |
| — | `stops[]` | array of Stop, min length 2 | — |
| — | `otp`, `otd` | computed blocks, §5 | C |
| — | `firstPickupAppt`, `finalDeliveryAppt` | timestamps, denormalized for sorting and querying | C |
| — | `stopOnTimePct` | number — every graded stop, not just the bookends | C |
| — | `transitMin` | number | C |
| — | `truckNumber`, `primaryDriver`, `secondaryDriver`, `runType`, `tripNumber` | optional, for the eventual asset-side merge | M |
| — | `createdBy`, `updatedBy`, `batchId`, `tenderId` | provenance | C |

### 4.2 Stop

| Sheet column | App field | Type | Filled by |
|---|---|---|---|
| *(new)* | `lsNumber` | string — **load stop number, one per stop** | M |
| — | `seq` | integer, 1-based, defines stop order | T/M |
| — | `type` | `PICKUP` \| `DELIVERY` | T/M |
| Shipper / Consignee Location Name | `locationName` | string | T |
| Shipper / Consignee Street Address | `address` | string | T |
| Origin / Destination - City | `city` | string | T |
| Origin / Destination - State | `state` | string(2) | T |
| Origin / Destination - Zip | `zip` | string — **keep as string, leading zeros** | T |
| Pickup Time / Delivery Time | `appt` | timestamp | T |
| *(new, normally empty)* | `apptEnd` | timestamp — window close, enterable when a customer gives one | T/M |
| Shipper / Destination Actual Arrival Time | `actualArrival` | timestamp — **grades this stop** | M |
| Shipper / Destination Actual Departure Time | `actualDeparture` | timestamp — drives dwell | M |
| — | `onTime` | `{ status, varianceMin, deadline }` | C |
| — | `dwellMin` | number | C |
| — | `reasonCode`, `notes` | miss attribution | M |

`reasonCode` enum: `SHIPPER_DELAY`, `CONSIGNEE_DELAY`, `TRAFFIC_WEATHER`, `MECHANICAL`,
`DRIVER_LATE`, `DISPATCH_PLANNING`, `CUSTOMER_RESCHEDULE`, `APPT_ERROR`,
`PRIOR_STOP_DETENTION`, `OTHER`.

### 4.3 Identifier rules

- **`loadNumber`** is the business identifier and the dedupe key. Imports and re-imports
  match on `(customerId, loadNumber)` — safe whether or not load numbers are unique across
  customers. A second row with the same pair updates rather than duplicates; a same
  `loadNumber` arriving under a *different* customer is flagged for review, never merged.
- **`referenceNumber`** is the customer's number (reference / pickup number). Not unique,
  not a key, but fully searchable and displayed in the column immediately right of load number.
- **`lsNumber`** lives on the stop, because that is what a load stop number identifies. On a
  standard two-stop load that is two LS fields; on a five-stop run, five.

---

## 5. Scoring rules

### 5.1 Per stop

```
grace     = customer.graceMinutes[stop.type]     (default 15, pickup and delivery separate)
deadline  = (stop.apptEnd ?? stop.appt) + grace

stop.onTime.status =
  PENDING   if stop.appt or stop.actualArrival is missing
  EARLY     if stop.actualArrival < stop.appt - customer.earlyToleranceHours
  ON_TIME   if stop.actualArrival <= deadline
  LATE      otherwise

stop.onTime.varianceMin = actualArrival - appt, signed (negative = early)
stop.dwellMin           = actualDeparture - actualArrival
```

`apptEnd` is normally empty, so `deadline` is normally just `appt + grace`. When a customer
does give a window, entering the close time is the only change needed — no different code path.

### 5.2 Per load

```
otp        = first  stop where type == PICKUP    (by seq)
otd        = final  stop where type == DELIVERY  (by seq)
transitMin = otd.actualArrival - otp.actualDeparture

stopOnTimePct = count(stops ON_TIME) / count(stops ON_TIME + LATE + EARLY-if-counted)
```

**Why `stopOnTimePct` exists.** On a multi-stop run a load can hit its first pickup and its
final delivery while missing two stops in the middle, and OTP/OTD alone would score it clean.
The scorecard shows OTP, OTD, and All-Stop side by side. OTP and OTD stay the headline
numbers because that is what the customer measures.

### 5.3 Percentages

```
OTP% = count(ON_TIME) / count(ON_TIME + LATE + EARLY-if-counted)
```

`PENDING` loads are **excluded from the denominator and displayed as their own count**
next to every percentage. A percentage shown without its pending count is not allowed
anywhere in the UI — otherwise the number improves by leaving fields blank.

`EARLY` counts as a miss only when `customer.earlyCountsAsMiss` is true (default false).

**This is the fix to the current sheet.** The existing `LET()` formula returns `FALSE`
on a blank actual, so unkeyed loads read as misses.

---

## 6. Screens

All four customers live on **one page**. Filtering is a chip row, not a page change.

1. **Loads** (default) — full-width table, sticky header, horizontal scroll inside its own
   container. Filter chips: All / AeroNet / Source One / USPS / Milwaukee Tool. Plus date
   range, status, OTP/OTD outcome, and a search box matching load # / reference # / LS # /
   city / consignee.
   - **Load view** (default): one row per load. Load Number and Reference Number are adjacent
     columns. Shows first pickup and final delivery inline, with a stop count badge
     (`2 stops`, `5 stops`); the row expands to the full stop list.
   - **Stop view** (toggle): one row per stop, which is how ops actually keys actuals — LS
     number, appointment, arrival, departure, on-time result, reason code. This is the daily
     data-entry surface and it must be fast.
   - Inline edit on `actualArrival` / `actualDeparture` in both views — two clicks, not a
     modal round trip. Tab between time fields, Enter saves, Esc cancels.
   - Column show/hide, saved views.
2. **KPI header** — Loads, OTP%, OTD%, All-Stop%, Pending, Avg minutes late, Worst lane.
   Recomputes with the active filter. Per-customer scorecard cards below.
3. **Add Load** — slide-over drawer. Opens with one pickup and one delivery stop;
   **Add stop** appends more, stops reorder by drag, `seq` renumbers automatically.
4. **Tender drop zone** — drag a PDF anywhere on the page; parse; land in a **review panel**
   with every autofilled field badged until confirmed; save creates the load and links the PDF.
   The parser returns the full stop list, so a multi-stop tender arrives as a multi-stop load.
5. **Excel/CSV import** — port the existing column-mapper UX from `public/index.html`
   (it works well), remapped to this schema. A flat sheet row becomes a load with two stops.
   Batch ID + undo.
6. **Customer settings** (admin only) — grace windows, early tolerance, early-counts-as-miss,
   name aliases used to match tender text to a customer.
7. **Reports** — CSV export of the filtered view, in two shapes: *sheet-compatible*
   (one row per load, first pickup + final delivery, matching the current spreadsheet) and
   *flat* (one row per stop). Weekly and monthly rollup per customer.
8. **Audit trail** — who set each actual time and when. These numbers go to customers;
   they need provenance.

---

## 7. Firebase architecture

**Stack:** Vite + React + TypeScript + Tailwind on Firebase Hosting.

### Firestore

| Collection | Contents |
|---|---|
| `loads/{loadId}` | §4.1, with `stops[]` as an embedded array |
| `customers/{customerId}` | `name`, `aliases[]`, `graceMinutes{pickup,delivery}`, `earlyToleranceHours`, `earlyCountsAsMiss`, `active` |
| `users/{uid}` | `role`, `displayName`, `email` |
| `tenders/{tenderId}` | `storagePath`, `status`, `parsedFields`, `confidence`, `loadId`, `uploadedBy` |
| `importBatches/{batchId}` | `rowCount`, `createdAt`, `rolledBackAt` |
| `auditLog/{entryId}` | `loadId`, `stopSeq`, `field`, `before`, `after`, `uid`, `at` |
| `rollups/{customerId}_{period}` | Precomputed weekly/monthly aggregates |

**Stops are an embedded array, not a subcollection** — a load is always read and written as a
unit, and even a twenty-stop load is nowhere near the 1MB document limit. The cost is that you
cannot query across stops directly, which is why `otp`, `otd`, `firstPickupAppt`,
`finalDeliveryAppt`, and `stopOnTimePct` are denormalized onto the load document: those are
what the dashboard filters and sorts on. Stop view filters client-side within the loaded page.

**Composite indexes:** `(customerId, firstPickupAppt desc)`,
`(customerId, otp.status, firstPickupAppt)`, `(status, firstPickupAppt desc)`,
`(customerId, loadNumber)`.

### Auth and rules

Google sign-in + email/password. Roles via custom claims: `admin` / `ops` / `viewer`.
No unauthenticated read or write, anywhere. `ops` writes loads; only `admin` writes
`customers`; `auditLog` and every computed field are function-write-only — a client that
can type its own OTP result can type its way to 100%.

### Cloud Functions (Node 20, TypeScript, v2)

| Function | Trigger | Job |
|---|---|---|
| `onLoadWrite` | Firestore write on `loads/{id}` | Grade every stop, then roll up `otp`, `otd`, `stopOnTimePct`, `transitMin`, `firstPickupAppt`, `finalDeliveryAppt` |
| `writeAudit` | Firestore write on `loads/{id}` | Diff per stop and append to `auditLog` |
| `parseTender` | Storage finalize on `tenders/**` | PDF to structured load + stops (§8) |
| `rollupDaily` | Scheduled | Per-customer aggregates into `rollups` |

Cloud Functions and Secret Manager require the **Blaze** plan.

---

## 8. Tender PDF extraction

Cloud Function, Anthropic TypeScript SDK (`@anthropic-ai/sdk`), model **`claude-opus-5`**.
Send the PDF straight through as a base64 `document` content block — no local OCR step —
and constrain the response with `output_config.format` against a JSON Schema matching §4.

```ts
const res = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: { format: { type: "json_schema", schema: TENDER_SCHEMA } },
  messages: [{ role: "user", content: [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
    { type: "text", text: EXTRACTION_PROMPT },
  ]}],
});
```

Rules:

- The schema's `stops` is an **array**, ordered as printed on the tender. A tender with four
  stops produces four stops. Do not collapse to origin/destination.
- Load number and reference number are **separate schema fields**. Tenders label these
  inconsistently (Load #, Order #, Pro #, PU #, Ref #, BOL #) — the extraction prompt lists
  the aliases per customer and requires the model to say which label it read for each.
- API key from **Secret Manager** (`defineSecret("ANTHROPIC_API_KEY")`). Never in the client bundle.
- The schema requires a `confidence` (`high`/`low`) and a verbatim `sourceText` per extracted
  field, so the review panel can show what the model read.
- **Never auto-save a parsed tender.** It lands in the review panel; a human confirms.
  A misparsed appointment time silently corrupts OTP for that lane forever.
- Appointment times: store the raw parsed string *and* the resolved instant + IANA zone.
- Missing field returns `null`. Never guess an appointment time.

---

## 9. Open questions

**Answered:**

- **Multi-stop** — yes, supported; normal load is one pickup + one delivery.
- **Appointment windows** — none in normal operation; `apptEnd` present and enterable.
- **Identifiers** — load number and reference number as separate adjacent columns;
  LS number per stop.

**Still open — assume and flag, do not stall:**

1. **Timezones.** Are appointment times local to the stop, or all in Central? Proposed default:
   store the instant, derive the stop's zone from the ZIP, display stop-local with a UTC toggle.
2. **Early arrivals.** Does arriving 4 hours early count against you at any of the four?
   Default: no.
3. **USPS shape.** Is USPS always the consignee, always the shipper, or both ends?
4. **Edit lock.** Who can change an actual time after a load is marked Delivered? Lock after N days?
5. **TMS actuals.** Your sample file has the actual columns populated. Can the TMS export them,
   or were those typed? If the TMS has them, we import and ops only fills the gaps.
6. **Firebase project ID**, and is Blaze billing enabled?
7. **Volume.** Roughly how many loads per week across the four customers? Decides whether the
   dashboard can aggregate client-side or needs the scheduled rollups from day one.
