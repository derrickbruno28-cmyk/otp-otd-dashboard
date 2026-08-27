# Handoff prompt for Claude Fable 5

Copy everything below the line into a fresh Fable 5 session, in the repo
`derrickbruno28-cmyk/otp-otd-dashboard`.

---

You are my senior developer and my senior coordinator for on-time pickup and on-time
delivery performance across all route performance issues and successes. You own both
sides of this: the code, and whether the numbers it produces would survive a customer
calling us out on them.

Build a Route Performance Tracker for my asset operations team.

## Context

Repo: `derrickbruno28-cmyk/otp-otd-dashboard`. Develop on branch
`claude/asset-ops-route-tracker-83dgqo`. Read `docs/BUILD_SPEC.md` first — it is the
approved spec and it is authoritative over anything in this prompt that contradicts it.

The repo currently holds an Express + Postgres dashboard (`server.js`, `public/index.html`,
`db/schema.sql`) that tracks trucks and drivers. That app is being retired. Do not extend it.
Do read `public/index.html` before you start — its Excel column-mapper and inline row-edit
interactions are good and should be carried into the new UI.

## What it does

My ops team logs the **actual** pickup and delivery events against the **scheduled**
appointments from the load tender, so we can prove — per customer, per lane, per week —
whether we hit the appointment.

Four customers: **AeroNet, Source One, USPS, Milwaukee Tool.** All four live on one page;
filtering is a chip row, not a page change.

## Stack

Vite + React + TypeScript + Tailwind on Firebase Hosting. Firestore, Firebase Auth,
Cloud Functions (Node 20, v2), Cloud Storage. Firebase emulator suite for local dev.
Blaze plan is assumed.

## Data model, scoring rules, screens, Firestore layout

All in `docs/BUILD_SPEC.md` §4–§7. Implement them as written. The parts I care most about:

- **A load is a list of stops, not an origin and a destination.** The normal load is one
  pickup and one delivery, but we do run multi-stop and the model must not assume otherwise.
  `stops[]`, ordered by `seq`, each typed `PICKUP` or `DELIVERY`.
- **Three identifiers, all distinct.** `loadNumber` is the load number and the dedupe key —
  match on `(customerId, loadNumber)`. `referenceNumber` is the reference / pickup number and
  sits in the column immediately to its right. `lsNumber` is the load stop number and lives
  **on the stop**, so a two-stop load has two of them.
- **Appointments are straight times.** `apptEnd` exists on every stop and is normally empty;
  when a customer does hand us a window, ops types the close time into the same field and
  nothing else changes. Do not build a separate window mode.
- **OTP grades on arrival at the shipper**, not departure — first `PICKUP` stop. OTD is the
  final `DELIVERY` stop. Departure is still captured and drives the dwell metric.
- **Also compute All-Stop on-time %** across every graded stop. A multi-stop load can hit its
  first pickup and its final delivery while missing two stops in the middle, and OTP/OTD alone
  would score that clean. OTP and OTD stay the headline numbers; All-Stop sits beside them.
- **Grace windows are per customer, default 15 minutes**, separate for pickup and delivery,
  editable on an admin settings screen.
- **A blank actual time is PENDING, not a miss.** Pending loads come out of the percentage
  denominator and are displayed as their own count next to every percentage. Never render a
  percentage anywhere in the UI without its pending count beside it. My current spreadsheet
  gets this wrong and it understates every customer.
- **All computed values are written by a Cloud Function and are not client-writable.**
  Firestore rules must reject a client write to them. Someone who can type their own result
  can type their way to 100%.

## The Loads table has two views

**Load view** is one row per load, with a stop-count badge and an expander for the full stop
list. **Stop view** is one row per stop — that is how ops actually keys actuals, LS number by
LS number, and it is the surface that has to be fastest. Inline editing of `actualArrival` and
`actualDeparture` works in both: two clicks, not a modal round trip; tab between time fields,
Enter saves, Esc cancels.

## Tender PDF drop-in

Ops drags a load tender PDF onto the page and the line item fills itself in.

Cloud Function, Anthropic TypeScript SDK, model `claude-opus-5`, PDF passed through as a
base64 `document` block, response constrained with `output_config.format` against a JSON
Schema. Details and the code shape are in `docs/BUILD_SPEC.md` §8. API key from Secret
Manager, never in the client bundle.

The schema's `stops` is an array in printed order — a four-stop tender produces four stops,
never a collapsed origin and destination. Load number and reference number are separate schema
fields; tenders label them inconsistently (Load #, Order #, Pro #, PU #, Ref #, BOL #), so the
extraction must report which label it actually read for each.

Two rules I will not bend on:

1. **A parsed tender never saves itself.** It lands in a review panel with every autofilled
   field badged until a human confirms it. A misparsed appointment time silently corrupts
   that lane's OTP forever, and nobody catches it for a month.
2. **A missing field comes back `null`.** Never guess an appointment time.

## Build quality bar

- **Every button, chip, filter, sort header, and row control is wired and does something.**
  No dead controls, no `TODO`, no `alert("coming soon")`, no placeholder handlers. If a
  control is on screen it works end to end against Firestore.
- Loading, empty, and error states on every async surface. A failed write tells the user what
  failed and does not silently drop their entry.
- Wide tables scroll inside their own container. The page body never scrolls sideways.
- Works on a laptop and on a phone in a yard.

## Deliverables

1. The working app on the branch above, committed in reviewable increments.
2. `firestore.rules` and `firestore.indexes.json`, both deployable as-is.
3. `docs/DEPLOY_FIREBASE.md` — click-by-click, in the style of the existing `DEPLOY.md`:
   create the project, enable Blaze, set the Anthropic secret, seed the four customers,
   deploy rules, functions, and hosting.
4. A seed script loading the four customers with their default grace windows.
5. A short note on anything in the spec you would build differently, and why.

## Assumptions to state, not stall on

`docs/BUILD_SPEC.md` §9 lists seven open items — timezone handling, early-arrival treatment,
which end USPS sits on, edit locking after delivery, whether the TMS can export actuals, the
Firebase project ID, and weekly volume. Take the proposed default for each, make the choice
visible in the code, and keep building. Do not wait on me for any of them.
