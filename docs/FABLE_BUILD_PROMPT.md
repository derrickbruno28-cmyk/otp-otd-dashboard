# Handoff prompt for Claude Fable 5

Copy everything below the line into a fresh Fable 5 session, in the repo
`derrickbruno28-cmyk/otp-otd-dashboard`.

---

You are my senior developer and my senior coordinator for on-time pickup and on-time
delivery performance across all route performance issues and successes. You own both sides
of this: the code, and whether the numbers it produces would survive a customer calling us
out on them — or a driver disputing a write-up that came out of them.

Build the Route Performance Tracker for AJG Transport / Gomez Haulers.

## Context

Repo: `derrickbruno28-cmyk/otp-otd-dashboard`. Develop on branch
`claude/asset-ops-route-tracker-83dgqo`. **Read `docs/BUILD_SPEC.md` first** — it is the
approved spec and it is authoritative over anything here that contradicts it.

The repo holds an Express + Postgres dashboard (`server.js`, `public/index.html`,
`db/schema.sql`) that tracks trucks and drivers. It is being retired — do not extend it. Do
read `public/index.html` first: its Excel column-mapper and inline row-edit interactions are
good and should carry into the new UI.

## What this replaces

Two things, and the second is why the first matters.

My ops team logs actual pickup and delivery events against scheduled appointments, with a
reason on every miss. Then, every week, somebody rebuilds an OTP/OTD audit by hand — scorecard
against target, fail-reason ranking, driver flagging, escalation. This app does the capture
*and* generates the audit.

Read the Week 33 numbers before you design anything:

| | On-time | Late | Rate | Target | Gap |
|---|---|---|---|---|---|
| OTP | 118 | 26 | 81.9% | 97.0% | −15.1 pts |
| OTD | 74 | 70 | 51.4% | 95.0% | −43.6 pts |

**31 of 70 OTD misses — 44% — are one reason: `Driver – Made Multiple Stops`.** The next
reason is 7. Fixing that single behavior takes OTD from 51.4% to 72.9% on the same loads.
If a week's worth of data contains a fact like that, my team should see it the day it's keyed,
not the following Thursday. Design toward that.

Four customers: **AeroNet, Source One, USPS, Milwaukee Tool.** All four on one page;
filtering is a chip row, not a page change.

## Stack

Vite + React + TypeScript + Tailwind on Firebase Hosting. Firestore, Firebase Auth, Cloud
Functions (Node 20, v2), Cloud Storage. Emulator suite for local dev. Blaze plan assumed.

## The things I care most about

Full model, scoring, screens and Firestore layout are in `docs/BUILD_SPEC.md` §3–§6.
These are the ones that get it wrong if you skim:

- **A load is a list of stops.** Normal load is one pickup and one delivery; we do run
  multi-stop and the model must not assume otherwise.
- **LS Number is one per load**, not per stop. Every report I produce quotes a single LS# on
  both the OTP and the OTD side of the same load. `loadNumber` and `referenceNumber` are
  separate adjacent columns; `loadNumber` is the dedupe key, matched on `(customerId, loadNumber)`.
- **A miss carries more than one reason.** LS# 20322 failed OTD for a tire failure *and* for
  multiple stops. `reasons[]` per metric, each with its own free-text note. A LATE load with
  no reason is visibly incomplete and counts into a Missing-reason badge.
- **`Driver – Made Multiple Stops` is not the same thing as a multi-stop load.** One means
  unauthorized stops en route; the other means a route with several scheduled stops. They
  share a word and nothing else. Never derive one from the other.
- **Targets are per customer with a fleet default of OTP 97% / OTD 95%.** Every scorecard
  renders Rate · Target · Gap in signed percentage points, the way my audit does.
- **CF / Non-CF coding is USPS only** — gate it on `customer.cfCodingEnabled`. It is per
  metric, not per load. `null` means *not yet coded*: it is a to-do, so uncoded late loads go
  into a Needs-CF-Coding queue with a count, and the audit prints them as No Flag with the
  standing note that no determination has been entered. Shuttle legs are excluded from the CF
  breakdown and still scored on the metric earned.
- **A blank actual is PENDING, not a miss.** Out of the percentage denominator, displayed as
  its own count beside every percentage — never render a percentage without it. My current
  spreadsheet returns FALSE on a blank actual, which counts unkeyed loads as misses and
  understates every customer.
- **Every computed value is written by a Cloud Function and is not client-writable.**
  Firestore rules must reject client writes to them. Someone who can type their own result
  can type their way to 100%.
- **Weeks run Sunday–Saturday** (Week 33 = Aug 9–15, 2026), configurable, and a load belongs
  to the week of its first pickup appointment. Do not use a date library's ISO-week default.

## The weekly audit, generated

`generateWeeklyAudit` builds my report from the data, for any week, fleet-wide **or filtered
to one customer** — which is new; today it's fleet-wide only, and per-customer OTP/OTD is the
thing this build adds. Five sections, mirroring what I produce by hand today:

1. Scorecard with target and gap, week-over-week comparison, CF breakdown for USPS.
2. Top fail reasons, ranked, ties sharing a rank, overflow listed inline with counts.
3. Drivers flagged for review — every driver or team with **3+ fail reasons (OTP + OTD
   combined)** that week, ranked. Two boxes each, OTP fails and OTD fails, listing only the
   failing LS#s, with all-time individual OTP/OTD. Reasons in the DRIVER category are flagged
   for coaching.
4. Top 10 worst performers month-to-date, minimum 3 loads, ranked by total late events.
5. Fail-reason summary index — every LS# grouped by reason, with driver names.

Shareable page plus PDF. Regenerating a week reruns from current data so late-entered reasons
flow through.

**On escalation:** a driver flagged in consecutive weeks moves Step 1 Call → Step 2 Write-Up
per SOP GHL-OPS-003, with reviewer and timestamp recorded. **The app proposes it; a human with
the manager role confirms it.** A write-up is a personnel action and must never fire
automatically.

## Tender PDF drop-in

Ops drags a load tender PDF onto the page and the line item fills itself in. Cloud Function,
Anthropic TypeScript SDK, model `claude-opus-5`, PDF as a base64 `document` block, response
constrained by `output_config.format`. Code shape in `docs/BUILD_SPEC.md` §9. API key from
Secret Manager, never in the client bundle.

**Keep the PDF.** `settings/fleet.retainTenderPdf` defaults true; the file lives in Cloud
Storage and opens from the load. When a customer says the appointment was 0800 and we say
1000, the tender is the evidence. With the switch off, extract and delete, keeping a SHA-256
fingerprint so a re-upload is recognized.

`stops` is an array in printed order — a four-stop tender produces four stops. Load number and
reference number are separate schema fields; tenders label them inconsistently (Load #,
Order #, Pro #, PU #, Ref #, BOL #) so the extraction must report which label it read for each.

Two rules I will not bend on:

1. **A parsed tender never saves itself.** It lands in a review panel, every autofilled field
   badged, until a human confirms. A misparsed appointment silently corrupts that lane's OTP
   forever and nobody catches it for a month.
2. **A missing field comes back `null`.** Never guess an appointment time.

## Build in two phases

Ship phase 1 before starting phase 2 — my team needs to key real loads while the reporting
lands.

- **Phase 1 — capture.** Auth and roles, customers and targets, loads and stops, actuals entry
  in load view and stop view, reason taxonomy and multi-reason entry, USPS CF coding,
  scorecards with target and gap, tender drop, Excel import, CSV export.
- **Phase 2 — accounting.** Drivers and all-time stats, weekly audit generation, driver
  flagging and SOP escalation, week-over-week, month-to-date worst performers, PDF export.

## Build quality bar

- **Every button, chip, filter, sort header, and row control is wired and does something.**
  No dead controls, no `TODO`, no `alert("coming soon")`, no placeholder handlers. If it is on
  screen it works end to end against Firestore.
- Keying actuals is the daily job and the reason the rest of this exists. Inline edit, two
  clicks, tab between time fields, Enter saves, Esc cancels. Reason entry inline from the LATE
  chip, searchable, multi-select, note per reason.
- Loading, empty and error states on every async surface. A failed write says what failed and
  never silently drops an entry.
- Wide tables scroll inside their own container; the page body never scrolls sideways.
- Works on a laptop and on a phone in a yard.

## Seed data

Seed the four customers with their targets and grace windows, USPS with `cfCodingEnabled`,
and the **34 fail reasons verbatim from `docs/BUILD_SPEC.md` §3.3** with their categories.
The category prefix is not cosmetic — `DRIVER` drives the coaching flag.

## Deliverables

1. The working app on the branch above, committed in reviewable increments, phase 1 first.
2. `firestore.rules` and `firestore.indexes.json`, deployable as-is.
3. `docs/DEPLOY_FIREBASE.md` — click-by-click in the style of the existing `DEPLOY.md`:
   create the project, enable Blaze, set the Anthropic secret, seed customers, drivers and
   reasons, deploy rules, functions and hosting.
4. Seed scripts.
5. A short note on anything in the spec you would build differently, and why.

## Assumptions to state, not stall on

`docs/BUILD_SPEC.md` §10 lists eight open items — timezone handling, early arrivals, which end
USPS sits on, edit locking, whether the TMS exports actuals, the Firebase project ID, who the
reviewer is, and volume. Each has a proposed default. Take it, make the choice visible in the
code, and keep building. Do not wait on me for any of them.
