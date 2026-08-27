# Module contract — every agent builds against THIS, not against each other's code

Already written (import freely, never modify):
- `lib/types.ts` — all domain types + `COMPUTED_LOAD_KEYS`, `LOAD_STATUSES`, `CUSTOMER_IDS`, `OPERATING_COMPANIES`
- `lib/scoring.ts` — gradeStop/gradeLoad/summarizeMetric/effectiveTarget/gapPoints/isGhostShutdown/weekOf/weekDayRange/dayNumberToUtcDate/weekRangeLabel/zonedYmd/DEFAULT_FLEET
- `lib/format.ts` — timeZoneForState, isoToLocalInput, localInputToIso, fmtDateTime, fmtDate, fmtPct, fmtGapPts, fmtVariance, fmtDwell, tzAbbr, parseWeightLbs, nowIso, newId
- `lib/firebase.ts` — auth, db, storage, functions, signInWithGoogle, signOutUser, SIGN_IN_DOMAIN
- `lib/loads.ts` — subscribeLoads, createLoad(load, signer, source), updateLoad(id, fields, signer, source), deleteLoad, clientWritable, withLocalGrades, filterLoads(loads, f, customersById, fleetTz, reasonCategoryByCode), needsCfCoding, missingReason, pendingActuals, EMPTY_FILTERS, LoadFilters, Signer
- `lib/csv.ts` — loadsToSheetCsv(loads, customersById), loadsToStopCsv(loads), downloadCsv(fileName, csv)
- `state/AuthContext.tsx` — useAuth(): { fbUser, profile, role, loading, error, signIn, signOut }; atLeast(role, min); ROLE_RANK
- `state/DataContext.tsx` — useData(): { customers, customersById, reasons, reasonsById, drivers, driversById, users, fleet, ready, error }
- `App.tsx` — already imports the exact names below. Match them.

## Styling (docs/BRAND.md via tailwind.config.js)
Colors: `bg-ground bg-surface bg-surface2 text-ink text-ink2 text-ink3 border-rule border-ruleStrong bg-brand text-brandInk bg-nav text-ontime bg-ontimeSoft text-late bg-lateSoft text-pending bg-pendingSoft text-catDriver text-catOther` (each also works as text-/bg-/border-).
Fonts: `font-display` (Saira Semi Condensed — headings/metrics), `font-sans` (IBM Plex Sans), `font-mono` (IBM Plex Mono — identifiers, timestamps). Numbers in columns: class `tnum`.
Patterns: card = `bg-surface border border-rule rounded-lg`; primary button = `px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50`; ghost button = `px-3 py-1.5 rounded border border-ruleStrong text-ink2 text-sm hover:bg-surface2`; danger = `text-late border border-late/40`.
Chip row buttons: `px-2.5 py-1 rounded-full text-xs font-mono border` — active: `bg-brand text-brandInk border-brand`; idle: `border-ruleStrong text-ink2 hover:bg-surface2`.
GOLD IS RESERVED: brand accent + DRIVER-category flags only. PENDING is steel (text-pending), never amber. Status chips: ON_TIME `bg-ontimeSoft text-ontime`, LATE `bg-lateSoft text-late`, EARLY `bg-surface2 text-ink2`, PENDING `bg-pendingSoft text-pending`.
Wide tables: wrap in `<div className="scroll-x">`. Never let the page body scroll sideways.
Every percentage rendered MUST show the pending count beside it.

## Exports each file MUST provide (exact names & props)

### components/ui.tsx
- `Spinner({ label?: string })`
- `ErrorNote({ message: string })` — red-tinted card
- `EmptyState({ title: string, hint?: string })`
- `Chip({ active, onClick, children, title? })` — filter chip button
- `StatusChip({ status: OnTimeStatus, varianceMin?: number | null })` — colored per Styling; shows fmtVariance when present
- `GhostChip()` — gold-bordered "GHOST SHUTDOWN" chip, `title="USPS protocol: hourly customer updates until delivered"`
- `Drawer({ open, onClose, title, width?, children })` — right slide-over, ESC closes, backdrop click closes
- `ConfirmDialog({ open, title, body, confirmLabel, danger?, onConfirm, onCancel })`
- `Field({ label, children, hint? })` — labeled form row
- `Section({ title, right?, children })` — card with header row

### components/Toast.tsx
- `ToastProvider({ children })`
- `useToast(): { push(kind: "ok" | "error", message: string): void }`

### components/Header.tsx
- `export type Tab = "loads" | "scorecards" | "audit" | "drivers" | "admin"`
- `Header({ tab, onTab }: { tab: Tab; onTab(t: Tab): void })`
Navy bar (bg-nav, stays navy in both themes). Left: GH mark — `<span class="font-display font-bold text-2xl text-white">G<span class="text-brand">/</span>H</span>` + "LOGISTICS" letterspaced mono small (placeholder until the real SVG arrives; note that in a comment). Center: tab buttons (hide "admin" unless atLeast(role,"admin"); hide nothing else). Right: theme toggle (moon/sun, toggles `data-theme` on document.documentElement between "dark"/"light", persist localStorage "gh-theme", default dark), then the signed-in identity: photoURL avatar (fallback initials), displayName, role badge (mono uppercase, brand-tinted), sign-out button. Mobile: tabs scroll horizontally.

### components/SignIn.tsx
- `SignIn()` — full-screen navy ground, GH mark large, one gold "Sign in with Google" button calling useAuth().signIn, note "@ghlogisticsllc.com accounts only", error from useAuth().error shown via ErrorNote.

### components/TimeInput.tsx
- `TimeInput({ value, timeZone, onCommit, onCancel, autoFocus, ariaLabel }: { value: string | null; timeZone: string; onCommit(next: string | null): void; onCancel?(): void; autoFocus?: boolean; ariaLabel?: string })`
`<input type="datetime-local">` seeded via isoToLocalInput; Enter or blur commits via localInputToIso (empty → null); Esc calls onCancel without committing. Shows tzAbbr(timeZone) suffix.

### components/ReasonPicker.tsx
- `ReasonPicker({ metric, entries, onChange, disabled }: { metric: "OTP" | "OTD"; entries: ReasonEntry[]; onChange(next: ReasonEntry[]): void; disabled?: boolean })`
Dropdown, NEVER free text for the code: button opens a panel listing active reasons where appliesTo === metric or BOTH, grouped by category (DRIVER group visually gold-flagged), search box filters, click toggles selection (multi-select). Each selected entry renders as a chip with its label + a small note input (free text) + remove ×. New entries stamped {enteredBy: profile.id, enteredByName, enteredAt: nowIso()}. Cascade assist: when metric === "OTD" and the load's OTP is LATE, sort `driver-late-pickup-cascaded-to-delivery` to the top with a "suggested" tag — offered, never auto-applied (caller passes otpLate via a prop: add optional `suggestCascade?: boolean`).

### components/CfControl.tsx
- `CfControl({ value, onChange, disabled }: { value: CfCode | null; onChange(v: CfCode | null): void; disabled?: boolean })`
Four-state segmented control: — (null, renders "No Flag", pending-steel), CF, Non-CF, Challenge. Title text: null = "Not yet coded — this is a to-do, not a verdict".

### components/HistoryPanel.tsx
- `HistoryPanel({ loadId, open, onClose }: { loadId: string; open: boolean; onClose(): void })`
Drawer titled "History". Subscribes to loads/{loadId}/revisions ordered by at desc (limit 200). Filter by person (select of distinct displayName). Each entry: displayName, fmtDateTime(at, fleet.timeZone), source badge (mono), summary; expandable to a field-level table of changes (path / before / after). Append-only — no edit/delete UI exists.

### components/LoadDrawer.tsx
- `LoadDrawer({ open, initial, onClose }: { open: boolean; initial: Load | null; onClose(): void })`
Create (initial === null) / edit drawer. All load fields; stops editor starts with 1 PICKUP + 1 DELIVERY, "Add stop" appends (seq renumbers), per-stop remove (min 2 enforced), reorder up/down buttons, per-stop: type select, locationName, address, city, state (2-letter → auto-set timeZone via timeZoneForState, zone editable select of common US zones), zip, TimeInput for appt / apptEnd ("window close — normally empty") / actualArrival / actualDeparture. Load fields: lsNumber, loadNumber, referenceNumber, customer select, operatingCompany select (AJG/GH), status select, equipmentType, pieces, weightLbs, billingMiles, commodity, truckNumber, tripNumber, runType, isShuttleLeg checkbox, primary/secondary driver selects from useData().drivers (writes both Id and Name fields). Validation: lsNumber, loadNumber, customerId required; ≥1 PICKUP and ≥1 DELIVERY. Save: createLoad/updateLoad with signer {uid: profile.id!, name: profile.displayName}, source "manual"; duplicate check on create — query loads where customerId+loadNumber match (client-side over the loads passed via prop? No: accept optional `existing: Load[]` prop from caller for the dedupe check; warn inline "Load number already exists for this customer" and block save unless "Save anyway" checked). Toast on success/failure.

### screens/LoadsScreen.tsx
- `LoadsScreen({ loads, filtered, filters, onFilters }: { loads: Load[]; filtered: Load[]; filters: LoadFilters; onFilters(f: LoadFilters): void })`
Top bar: customer chips (All + 4 from useData().customers), company chips (All/AJG/GH), quick-filter chips with live counts: Ghost Shutdown (gold border, count of isGhostShutdown over `loads`), Needs CF coding, Missing reason, Pending actuals; search input; date from/to; status/OTP/OTD/reason/category selects; Clear filters. Action row: view toggle (Load view / Stop view), "+ Add Load", "Import Excel", "Drop tender" (opens TenderZone modal), "Export CSV" (menu: sheet-shape / per-stop → downloadCsv). 
Load view table columns: LS # (mono, gold when any attached reason has category DRIVER), Load #, Ref #, Customer, Co., stops badge ("2 stops"), lane (first PU city/state → final DEL city/state), PU appt vs actual arrival (fmtDateTime in stop tz), OTP StatusChip, DEL appt vs actual arrival, OTD StatusChip (+ GhostChip when isGhostShutdown), reasons (chips of labels, DRIVER ones gold), CF (only when customer cfCodingEnabled: two mini CfControls readonly display; click opens editor inline for ops+), drivers, status select (inline, ops+ saves immediately), ✎ edit (opens LoadDrawer), 🕘 history (opens HistoryPanel). Row click expands stop list inline (per-stop rows with TimeInput inline editing of actualArrival/actualDeparture for ops+ — two clicks: click cell → input; Enter saves via updateLoad patching stops array; Esc cancels). Sortable headers: LS#, pickup appt, OTP, OTD (click toggles asc/desc).
Stop view: one row per stop across `filtered` — LS# (gold rule as above), load #, customer, stop # + type, location, city/state, appt, window close, actual arrival (inline TimeInput), actual departure (inline TimeInput), StatusChip, variance, dwell. This is the fastest data-entry surface: tab moves between the two time cells, Enter saves, Esc cancels.
Pending counts visible next to every % anywhere shown. Empty state when filtered is empty. All writes: updateLoad(load.id!, {...}, signer, "manual").

### screens/ScorecardsScreen.tsx
- `ScorecardsScreen({ loads, filtered, filters, onFilters })` (same props as LoadsScreen)
KPI strip over `filtered` (respects active filters; render the same chip rows as LoadsScreen top bar by reusing filters/onFilters — implement a small local copy of the chip row, not an import from LoadsScreen): tiles for Loads scored, OTP (rate big font-display, target, fmtGapPts gap, meter bar with target tick, "N pending" underneath), OTD same, All-Stop % (avg stopOnTimePct across filtered graded loads + pending count), Ghost Shutdown count (gold), Avg minutes late (mean positive variance among LATE otd), Needs CF count. Per-customer cards (each vs its own effectiveTarget), then per-company cards (AJG/GH vs fleet target). Week-over-week block: current week vs previous (weekOf on firstPickupAppt): OTP%, OTP late, OTD%, OTD late, total scored, with ▲/▼ deltas (ontime/late colored). "Top OTD fail reasons this week" mini bar list: count per reason label over otdReasons of late OTD loads this week, DRIVER bars bg-catDriver, others bg-catOther, count labels, legend.

### screens/AuditScreen.tsx
- `AuditScreen({ loads }: { loads: Load[] })`
Controls (no-print): week select (distinct weekYear_weekNumber present in loads, plus current; labeled with weekRangeLabel), customer scope select (Fleet-wide + customers), company scope select (Both + AJG/GH), "Generate & save snapshot" (calls httpsCallable(functions, "generateWeeklyAudit")({weekYear, weekNumber, customerId, operatingCompany}) → renders returned WeeklyAudit; on error toast + fall back to the identical client-side computation), "Print / PDF" (window.print()).
Renders the five sections (compute client-side from `loads` by default so it works before any snapshot exists — same math as functions/src/weeklyAudit.ts, keep it in this file): 01 Scorecard (on-time/late/rate/target/gap rows + pending line + WoW table + CF breakdown for USPS scope incl. No Flag note verbatim: "No Flag = no CF/Non-CF determination has been entered — a to-do, not a verdict."), 02 Top 5 fail reasons per metric (ranked, ties share a rank, overflow beyond 5 listed inline as "Label (n)"), 03 Drivers flagged (3+ reason entries across OTP+OTD that week; two boxes per driver listing failing LS#s with reason label + note; DRIVER-category text in gold; all-time individual OTP/OTD from driversById allTime; repeat-from-previous-week ⇒ "Week N reappearance triggers Step 2 (Write-Up) per SOP GHL-OPS-003"), 04 Top 10 worst performers MTD (min 3 loads, ranked by total late), 05 Fail reason summary index (every reason with count + LS#s + driver names). Header: "OTP / OTD OPERATIONS AUDIT — WEEK N", scope line, rangeLabel, generated stamp. Print stylesheet friendly (light theme applies automatically in print).

### screens/DriversScreen.tsx
- `DriversScreen({ loads }: { loads: Load[] })`
Left: driver list (search, active filter, company filter) with all-time OTP/OTD/loads + reviewState badge. Right: selected driver detail — all-time tiles (pending noted), week-by-week table (from loads where driver on the load: week, loads, otp fails, otd fails), fail history (each late load: LS#, week, metric, reason labels + notes), review panel: current reviewState, proposed flags from driverFlags collection (subscribe where driverId ==, order weekYear/weekNumber desc, limit 20) with "Confirm Step 1/2" buttons for manager+ (updates driverFlags doc confirmed* fields AND drivers doc reviewState/reviewedBy/reviewedByName/reviewedAt via updateDoc; ConfirmDialog first: "A write-up is a personnel action. Confirm STEP_2_WRITE_UP for {name}?"), reviewNotes textarea (manager+, saved with toast). "Add driver" (ops+): name + company. Never auto-escalate — buttons only.

### screens/AdminScreen.tsx
- `AdminScreen()` — admin only (guard with role, show ErrorNote otherwise).
Tabs inside: Customers (table: name, aliases (comma-edit), OTP target % input (blank = fleet default), OTD target %, grace pickup/delivery mins, early tolerance hrs, earlyCountsAsMiss toggle, cfCodingEnabled toggle (label "CF / Non-CF coding — USPS only"), active toggle; save per row via setDoc merge; toast), Fail Reasons (table grouped by category: label, category select, appliesTo select, active toggle, sortOrder; add new reason form — id = slugified label, shown read-only; note at top: "Codes are chosen from this list in the app — never typed"), Users (table: photo, name, email, role select (admin can change; writes users/{uid}.role), lastSignInAt), Fleet (targets otp/otd % inputs, timeZone select, retainTenderPdf toggle labeled "Keep tender PDFs (evidence for disputes)", tenderRetentionDays number-or-blank, signInDomain read-only with note "changing this requires redeploying the blocking function"; save → setDoc settings/fleet).

### lib/xlsxImport.ts (with components/ImportModal.tsx)
- `parseWorkbook(file: File): Promise<{ headers: string[]; rows: Record<string, unknown>[] }>` (SheetJS, first sheet, header row detect)
- `autoMap(headers: string[]): Record<string, string | null>` — target fields (keys): lsNumber, loadNumber, referenceNumber, customerName, equipmentType, originCity, originState, originZip, destCity, destState, destZip, pickupTime, shipperActualArrival, shipperActualDeparture, deliveryTime, destActualArrival, destActualDeparture, status, shipperName, shipperAddress, consigneeName, consigneeAddress, pieces, weight, billingMiles, commodity, primaryDriver, secondaryDriver, truckNumber, operatingCompany. Fuzzy match against the legacy sheet headers ("Order Number"→loadNumber, "Pickup Time"→pickupTime, "Shipper Actual Arrival Time"→shipperActualArrival, etc.). MINIMAL MANUAL INPUT: actuals columns import too.
- `rowsToLoads(rows, mapping, ctx: { customers: Customer[]; nowIso(): string }): { loads: Load[]; problems: string[] }` — dates: accept Date objects, Excel serials, and strings (parse via new Date; serial → (n − 25569) * 86400s UTC, then treat the wall time as the stop zone's local time via localInputToIso); zips as strings (pad leading zeros to 5 when numeric); weight via parseWeightLbs; customer matched by name/alias (case-insensitive; unmatched → problem line, row skipped); two stops built with timeZoneForState.
### components/ImportModal.tsx
- `ImportModal({ open, onClose, existing }: { open: boolean; onClose(): void; existing: Load[] })`
Steps: file pick/drop → mapping table (selects prefilled by autoMap; unmapped = "— skip —") → preview (first 10 as compact table + problems list) → commit: dedupe on (customerId, loadNumber) against `existing` — matches become updateLoad (merge non-empty imported fields, source "import"; record {id, previousData} into batch), new rows createLoad(source "import"); write importBatches doc; progress; result summary (created/updated/skipped). "Undo last import" button when a not-rolled-back batch exists: deletes createdLoadIds, restores previousData via updateLoad(source "system"→ no, use "import"), marks rolledBackAt. Toasts.

### components/TenderZone.tsx (with TenderReview inside the same file)
- `TenderZone({ open, onClose, existing }: { open: boolean; onClose(): void; existing: Load[] })`
Full-screen drop modal: drag/drop or pick PDF(s) → for each: create tenders doc (status "uploaded", fileName, sizeBytes, uploadedBy/Name, createdAt, storagePath `tenders/{docId}`, parsed:null, error:null, loadId:null, sha256:null) then uploadBytes(ref(storage, `tenders/{docId}`), file, {contentType:"application/pdf"}). List of my recent tenders (subscribe tenders ordered createdAt desc limit 25): status chips (uploaded/parsing → Spinner, parsed → "Review", error → message, confirmed → link "load created"). Review panel (Drawer): every parsed field shown as an editable input pre-filled from parsed.*.value with a confidence badge (low = gold "CHECK" tag) and sourceText + labelRead tooltip ("read as: Load # — '…verbatim…'"); customer select pre-matched from customerName via aliases; stops list in printed order (editable, same per-stop fields as LoadDrawer); appointment strings resolved to ISO with the stop's zone (localInputToIso) shown for confirmation; NOTHING saves until "Confirm & create load" (ops+) → createLoad(source "tender", tenderId set) + update tender {status:"confirmed", loadId}; "Discard" → status "discarded". A parsed tender NEVER auto-saves. Null fields stay blank — never guessed.

### functions/src/driverStats.ts
- `export const recalcDriverStats = onDocumentWritten("loads/{loadId}", …)` — for each driverId in before/after (primary+secondary, deduped): query loads where primaryDriverId == id and where secondaryDriverId == id (two queries, merge by doc id), compute DriverAllTime over individual loads (otp/otd status counts, pcts excl. PENDING), set drivers/{id}.allTime (merge). Skip if no driver ids involved.

### functions/src/driverFlags.ts
- `export const evaluateDriverFlags = onCall(…)` accepting {weekYear, weekNumber} — query loads where weekYear==, weekNumber==; per driver (primary AND secondary get credited the same load fails, per the audit's team boxes): count reason entries on OTP-late and OTD-late loads; failCount ≥ 3 → upsert driverFlags/{weekYear}_{weekNumber}_{driverId} with fails arrays {lsNumber, loadId, reasons(labels)}, proposedStep = STEP_2_WRITE_UP if a flag doc exists for the SAME driver in the previous week (handle year boundary via weekDayRange math: prevWeek = weekNumber-1 or last week of prior year) else STEP_1_CALL; NEVER writes drivers.reviewState (a manager confirms in the UI). Also `export const evaluateDriverFlagsScheduled = onSchedule("every monday 09:00", …)` calling the same core for the just-finished week (America/Chicago).

### functions/src/weeklyAudit.ts
- `export const generateWeeklyAudit = onCall(…)` accepting {weekYear, weekNumber, customerId?, operatingCompany?} — require auth + domain; loads for the week (+ scope filters), previous week for WoW; compute the full WeeklyAudit object per types.ts: scorecard (summarize otp/otd with target from scope customer or fleet, gapPts ×100 handled by gapPoints), cfBreakdown ONLY over USPS loads in scope (cf per metric; late loads only; noFlag = late && cf null; shuttle legs excluded from breakdown and counted into shuttleExcluded), topFailReasons (rank with ties sharing a rank), flaggedDrivers (same 3+ rule as driverFlags, incl. repeatFromPrevWeek + allTime from drivers docs), worstPerformersMtd (monthKey of the week's Sunday; min 3 loads individual; rank by otpFails+otdFails desc; alert strings "Monitoring — Step 1 Call/Action" / "| Week N Repeat → Step 2"), reasonIndex (per reason: count, entries {lsNumber, driverNames}). Save to weeklyAudits/{weekYear}_{weekNumber}[_{customerId}][_{operatingCompany}] and return it.

### functions/src/parseTender.ts
- `export const parseTender = onObjectFinalized({ bucket-default, secrets: [ANTHROPIC_API_KEY] }, …)` for paths tenders/{tenderId}: download bytes; sha256; set tender doc {status:"parsing", sha256}; call Anthropic (@anthropic-ai/sdk) `client.beta.messages.create` model "claude-opus-5", max_tokens 16000, betas ["server-side-fallback-2026-07-01"], fallbacks "default", thinking {type:"adaptive"}, output_config {format:{type:"json_schema", schema: TENDER_JSON_SCHEMA}}, content [{type:"document", source:{type:"base64", media_type:"application/pdf", data}}, {type:"text", text: EXTRACTION_PROMPT}]. TENDER_JSON_SCHEMA mirrors TenderParse from types.ts: every field {value (nullable), confidence "high"|"low", sourceText nullable, labelRead nullable}; stops array in printed order. EXTRACTION_PROMPT: extract exactly what is printed; a field not present returns value null — NEVER guess, especially appointment times; report which label each identifier was under (Load #, Order #, Pro #, PU #, Ref #, BOL #…); appointment times as printed plus ISO when unambiguous with the stop's own city/state timezone. Parse response JSON (check stop_reason === "refusal" → status error), write {status:"parsed", parsed}. Then fleet settings: if retainTenderPdf === false → delete the storage object, set storagePath null. Errors → {status:"error", error: message}. defineSecret("ANTHROPIC_API_KEY").

### scripts/seed.mjs + docs/DEPLOY_FIREBASE.md
seed.mjs: node script, firebase-admin, GOOGLE_APPLICATION_CREDENTIALS or emulator env; reads data/customers.json, data/failReasons.json, data/fleet.json; setDoc with the JSON ids; idempotent (merge). `--emulator` flag sets FIRESTORE_EMULATOR_HOST. Also `--admin you@ghlogisticsllc.com` grants role admin to the users doc matching that email (create by querying users where email ==; if absent print instructions to sign in once first).
DEPLOY_FIREBASE.md: click-by-click in the style of DEPLOY.md — create Firebase project, upgrade to Blaze, enable Google sign-in provider + upgrade to Identity Platform (required for blocking functions), add authorized domain, create web app + paste config into web/.env, enable Firestore + Storage, `firebase deploy --only firestore:rules,firestore:indexes,storage`, set secret `firebase functions:secrets:set ANTHROPIC_API_KEY`, deploy functions, seed (node scripts/seed.mjs --admin …), build web (npm run build) + deploy hosting, emulator workflow, and a "what to verify" checklist.
