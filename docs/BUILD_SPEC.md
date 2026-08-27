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
| OTP graded on | **Arrival at shipper** vs pickup appointment | Standard; does not penalize the driver for the shipper's dock dwell |
| Departure times | Still captured, drive the dwell metric | Needed for detention conversations |
| Grace window | Per customer, configurable, **default 15 min** | USPS SLAs differ from a manufacturer's |
| Blank actuals | Count as **PENDING**, excluded from the percentage | Current sheet counts them as misses |
| Tender autofill | Drag-and-drop **PDF** | Stated requirement |
| Service Type column | Dropped | Stated requirement |
| LS Number (Load Stop #) | New manual field, first-class | Stated requirement |

---

## 3. Why a fresh build rather than merging the existing dashboard

The current app tracks **assets** — `truck_num`, `primary_driver`, `secondary_driver`,
`run_type`, `del1/del2`. The new sheet tracks **orders** — customer, shipper/consignee
names and street addresses, pieces, weight, commodity, billing distance. There is no
customer column in the old schema and no truck/driver column in the new sheet, so a
merge today means hand-reconciling historical rows that nobody can reconcile reliably.

The build is therefore a fresh Firestore app, **but the `loads` document carries the
asset fields (`truckNumber`, `primaryDriver`, `secondaryDriver`, `runType`, `tripNumber`)
from day one as optional**. That turns the eventual unification into a data migration
instead of a rewrite. Keep Render running read-only until the new app is trusted, then
retire it.

---

## 4. Field map — sheet column to app field

`Filled by` legend: **T** = tender autofill, **M** = manual entry by ops, **C** = computed server-side.

| Sheet column | App field | Type | Filled by |
|---|---|---|---|
| Order Number | `orderNumber` | string | T |
| *(new)* | `lsNumber` — Load Stop # | string | M |
| Equipment Type | `equipmentType` | enum | T |
| Customer Name | `customerId` | enum: aeronet / source-one / usps / milwaukee-tool | T/M |
| Origin - City | `origin.city` | string | T |
| Origin - State | `origin.state` | string(2) | T |
| Origin - Zip | `origin.zip` | string — **keep as string, leading zeros** | T |
| Shipper Location Name | `shipper.name` | string | T |
| Shipper Street Address | `shipper.address` | string | T |
| Pickup Time | `pickupAppt` | timestamp | T |
| *(new, optional)* | `pickupApptEnd` | timestamp — window close | T |
| Shipper Actual Arrival Time | `pickupActualArrival` | timestamp | **M — grades OTP** |
| Shipper Actual Departure Time | `pickupActualDeparture` | timestamp | M |
| Destination - City | `destination.city` | string | T |
| Destination - State | `destination.state` | string(2) | T |
| Destination - Zip | `destination.zip` | string | T |
| Consignee Location Name | `consignee.name` | string | T |
| Consignee Street Address | `consignee.address` | string | T |
| Delivery Time | `deliveryAppt` | timestamp | T |
| *(new, optional)* | `deliveryApptEnd` | timestamp — window close | T |
| Destination Actual Arrival Time | `deliveryActualArrival` | timestamp | **M — grades OTD** |
| Destination Actual Departure Time | `deliveryActualDeparture` | timestamp | M |
| Order Status | `status` | enum: Tendered / Dispatched / At Shipper / In Transit / At Consignee / Delivered / Cancelled | M |
| Cases/Piece Count | `pieces` | integer | T |
| Weight | `weightLbs` | number — parse `"8250.000lbs"` to `8250` | T |
| Billing Distance | `billingMiles` | number | T |
| Commodity | `commodity` | string | T |
| Service Type | *dropped* | — | — |
| On Time Pickup | `otp.status` | computed | C |
| On Time Delivery | `otd.status` | computed | C |

### Computed block (server-side only — never client-writable)

```
otp: { status, varianceMin, deadline, reasonCode, notes }
otd: { status, varianceMin, deadline, reasonCode, notes }
dwell: { shipperMin, consigneeMin }
transitMin
```

`reasonCode` enum: `SHIPPER_DELAY`, `CONSIGNEE_DELAY`, `TRAFFIC_WEATHER`, `MECHANICAL`,
`DRIVER_LATE`, `DISPATCH_PLANNING`, `CUSTOMER_RESCHEDULE`, `APPT_ERROR`,
`PRIOR_STOP_DETENTION`, `OTHER`.

---

## 5. Scoring rules

```
graceP   = customer.graceMinutes.pickup     (default 15)
graceD   = customer.graceMinutes.delivery   (default 15)

deadlineP = (pickupApptEnd   ?? pickupAppt)   + graceP
deadlineD = (deliveryApptEnd ?? deliveryAppt) + graceD

otp.status =
  PENDING   if pickupAppt or pickupActualArrival is missing
  EARLY     if pickupActualArrival < pickupAppt - customer.earlyToleranceHours
  ON_TIME   if pickupActualArrival <= deadlineP
  LATE      otherwise

otd.status = same shape, using deliveryAppt / deliveryActualArrival / deadlineD

varianceMin = actualArrival - appt, signed (negative = early)
dwell.shipperMin   = pickupActualDeparture   - pickupActualArrival
dwell.consigneeMin = deliveryActualDeparture - deliveryActualArrival
transitMin         = deliveryActualArrival   - pickupActualDeparture
```

**Percentages:**

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
   range, status, OTP/OTD outcome, and a search box matching order # / LS # / city / consignee.
   Inline edit on the four actual-time fields — that is the ops team's daily job and must be
   two clicks, not a modal round trip. Row expands for full detail. Column show/hide, saved views.
2. **KPI header** — Loads, OTP%, OTD%, Pending, Avg minutes late, Worst lane. Recomputes with
   the active filter. Per-customer scorecard cards below.
3. **Add Load** — slide-over drawer, every field, validation.
4. **Tender drop zone** — drag a PDF anywhere on the page; parse; land in a **review panel**
   with every autofilled field badged until confirmed; save creates the load and links the PDF.
5. **Excel/CSV import** — port the existing column-mapper UX from `public/index.html`
   (it works well), remapped to this schema. Batch ID + undo.
6. **Customer settings** (admin only) — grace windows, early tolerance, early-counts-as-miss,
   name aliases used to match tender text to a customer.
7. **Reports** — CSV export of the filtered view; weekly and monthly rollup per customer.
8. **Audit trail** — who set each actual time and when. These numbers go to customers;
   they need provenance.

---

## 7. Firebase architecture

**Stack:** Vite + React + TypeScript + Tailwind on Firebase Hosting.

### Firestore

| Collection | Contents |
|---|---|
| `loads/{loadId}` | Everything in §4 + `customerId`, computed block, `createdBy`, `updatedBy`, `batchId`, optional asset fields |
| `customers/{customerId}` | `name`, `aliases[]`, `graceMinutes{pickup,delivery}`, `earlyToleranceHours`, `earlyCountsAsMiss`, `active` |
| `users/{uid}` | `role`, `displayName`, `email` |
| `tenders/{tenderId}` | `storagePath`, `status`, `parsedFields`, `confidence`, `loadId`, `uploadedBy` |
| `importBatches/{batchId}` | `rowCount`, `createdAt`, `rolledBackAt` |
| `auditLog/{entryId}` | `loadId`, `field`, `before`, `after`, `uid`, `at` |
| `rollups/{customerId}_{period}` | Precomputed weekly/monthly aggregates |

**Composite indexes:** `(customerId, pickupAppt desc)`, `(customerId, otp.status, pickupAppt)`,
`(status, pickupAppt desc)`.

### Auth and rules

Google sign-in + email/password. Roles via custom claims: `admin` / `ops` / `viewer`.
No unauthenticated read or write, anywhere. `ops` writes loads; only `admin` writes
`customers`; `auditLog` and the computed block are function-write-only — a client that
can type its own OTP result can type its way to 100%.

### Cloud Functions (Node 20, TypeScript, v2)

| Function | Trigger | Job |
|---|---|---|
| `onLoadWrite` | Firestore write on `loads/{id}` | Recompute `otp`, `otd`, `dwell`, `transitMin` |
| `writeAudit` | Firestore write on `loads/{id}` | Diff and append to `auditLog` |
| `parseTender` | Storage finalize on `tenders/**` | PDF to structured fields (§8) |
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

- API key from **Secret Manager** (`defineSecret("ANTHROPIC_API_KEY")`). Never in the client bundle.
- The schema requires a `confidence` (`high`/`low`) and a verbatim `sourceText` per extracted
  field, so the review panel can show what the model read.
- **Never auto-save a parsed tender.** It lands in the review panel; a human confirms.
  A misparsed appointment time silently corrupts OTP for that lane forever.
- Appointment times: store the raw parsed string *and* the resolved instant + IANA zone.
- Missing field returns `null`. Never guess an appointment time.

---

## 9. Open questions

Three of these change the data model, so they are worth answering before the build starts.

**Schema-affecting:**

1. **Multi-stop.** The sheet is one pickup, one delivery — but the old dashboard has DEL1/DEL2.
   Do any of these four customers run multi-stop? If yes the model needs a `stops[]` array,
   and that is much cheaper to decide now than to migrate later.
2. **Appointment windows.** Single appointment time, or start–end windows / FCFS? Does USPS
   give a window?
3. **Unique key.** Is Order Number unique across all customers, or only within a customer?
   This is the dedupe key for imports and re-imports.

**Behavior:**

4. **Timezones.** Are appointment times local to the stop, or all in Central? Proposed default:
   store the instant, derive the stop's zone from the ZIP, display stop-local with a UTC toggle.
5. **Early arrivals.** Does arriving 4 hours early count against you at any of the four?
6. **USPS shape.** Is USPS always the consignee, always the shipper, or both ends?
7. **Edit lock.** Who can change an actual time after a load is marked Delivered? Lock after N days?
8. **TMS actuals.** Your sample file has the actual columns populated. Can the TMS export them,
   or were those typed? If the TMS has them, we import and ops only fills the gaps.

**Ops:**

9. Firebase project ID, and is Blaze billing enabled?
10. Roughly how many loads per week across the four customers? Decides whether the dashboard can
    aggregate client-side or needs the scheduled rollups from day one.
