# GH Route Performance Tracker — Firebase Deployment Guide

This project deploys to Firebase:

- `web/`: the React dashboard (Vite build → Firebase Hosting)
- `functions/`: Cloud Functions — scoring, revisions, driver stats, weekly audit, tender parsing, sign-in domain enforcement
- `firestore.rules`, `firestore.indexes.json`, `storage.rules`: security rules and indexes
- `scripts/seed.mjs`: seeds customers, fail reasons, and fleet settings from `data/`
- `firebase.json`: ties it all together, including the emulator suite

You will need Node 20 or newer, an `@ghlogisticsllc.com` Google account, and an Anthropic API key (for tender PDF parsing).

## 1. Install the Firebase CLI

1. Open Terminal.
2. Run:

```bash
npm install -g firebase-tools
firebase login
```

3. Sign in with your `@ghlogisticsllc.com` account.

## 2. Create the Firebase project

1. Go to [Firebase console](https://console.firebase.google.com/).
2. Click `Create a project`.
3. Enter a project name, e.g. `gh-route-performance`.
4. Disable Google Analytics (not needed).
5. Click `Create project` and wait for provisioning.
6. Note the **project ID** (shown under the name, e.g. `gh-route-performance`) — you will use it below.

## 3. Upgrade to the Blaze plan

Cloud Functions, Secret Manager, and blocking sign-in functions all require Blaze.

1. In the console, click the gear icon → `Usage and billing`.
2. Click `Details & settings` → `Modify plan`.
3. Select `Blaze (Pay as you go)` and link a billing account.

## 4. Enable Google sign-in and Identity Platform

Sign-in is Google only, restricted to `@ghlogisticsllc.com`. The restriction is enforced by blocking functions (`enforceDomainOnCreate` / `enforceDomainOnSignIn` in `functions/src/identity.ts`), and blocking functions require Identity Platform — do this step **before** deploying functions or the deploy will fail.

1. In the console, click `Build` → `Authentication`.
2. Click `Get started`.
3. Open the `Sign-in method` tab.
4. Click `Google` → toggle `Enable` → pick a support email → `Save`.
5. Open the `Settings` tab and click the `Upgrade to Firebase Authentication with Identity Platform` banner (also reachable from the Authentication landing page). Confirm the upgrade.
6. Still in `Settings`, open `Authorized domains` and confirm `localhost` and `<project-id>.web.app` are listed. Add your custom domain here later if you attach one.

## 5. Enable Firestore and Storage

1. Click `Build` → `Firestore Database` → `Create database`.
2. Choose `Start in production mode` (the repo's rules replace the defaults in step 7).
3. Pick a region — `us-central1` matches the functions region in `functions/src/index.ts`.
4. Click `Enable`.
5. Click `Build` → `Storage` → `Get started`, same region, production mode.

## 6. Create the web app and fill `web/.env`

1. Click the gear icon → `Project settings` → `General`.
2. Under `Your apps`, click the `</>` (web) icon.
3. Enter a nickname, e.g. `gh-dashboard`. Leave `Also set up Firebase Hosting` unchecked — hosting deploys via the CLI.
4. Click `Register app` and keep the config snippet visible.
5. In Terminal, from the repo root:

```bash
cd web
cp .env.example .env
```

6. Open `web/.env` and paste each value from the config snippet:

- `apiKey` → `VITE_FB_API_KEY`
- `authDomain` → `VITE_FB_AUTH_DOMAIN`
- `projectId` → `VITE_FB_PROJECT_ID`
- `storageBucket` → `VITE_FB_STORAGE_BUCKET`
- `messagingSenderId` → `VITE_FB_MESSAGING_SENDER_ID`
- `appId` → `VITE_FB_APP_ID`

7. Leave `VITE_USE_EMULATORS` empty for production.

## 7. Link the repo and deploy rules, indexes, and Storage rules

From the repo root:

```bash
firebase use --add
# pick your project, alias "default"
firebase deploy --only firestore:rules,firestore:indexes,storage
```

> The storage rules call `firestore.get(...)` to check the uploader's role and tender
> doc (cross-service rules). The first deploy prompts you to grant the Storage rules
> service account Firestore access — answer yes; it is a one-time grant.

## 8. Set the Anthropic API key secret

Tender parsing (`parseTender`) reads `ANTHROPIC_API_KEY` from Secret Manager — it is never in the client bundle. Set it **before** deploying functions:

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
```

Paste your key from [console.anthropic.com](https://console.anthropic.com/) when prompted.

## 9. Deploy Cloud Functions

```bash
npm --prefix functions install
firebase deploy --only functions
```

Notes:

1. The predeploy hook compiles the TypeScript automatically.
2. The first deploy asks to enable Google Cloud APIs (Cloud Build, Artifact Registry, Eventarc) — accept and re-run if it times out while they activate.
3. Deploying registers the blocking functions with Identity Platform automatically. Verify: `Authentication` → `Settings` → `Blocking functions` shows both `enforceDomainOnCreate` and `enforceDomainOnSignIn`.

## 10. Seed Firestore

The seed script loads `data/customers.json` (4 customers), `data/failReasons.json` (34 reasons), and `data/fleet.json` (`settings/fleet`). It is idempotent — every write is a merge, so re-running is always safe. It resolves `firebase-admin` from `functions/node_modules`, so step 9's `npm --prefix functions install` must have run.

1. Get a service-account key: gear icon → `Project settings` → `Service accounts` → `Generate new private key`. Save the JSON **outside** the repo — it is a credential.
2. From the repo root:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
node scripts/seed.mjs
```

3. Confirm the output: `Seeded 4 customers, 34 fail reasons, and settings/fleet.`

## 11. Build the web app and deploy Hosting

From the repo root:

```bash
npm --prefix web install
npm --prefix web run build
firebase deploy --only hosting
```

Open `https://<project-id>.web.app`.

## 12. Grant yourself admin

New accounts land as `viewer`. The `users/{uid}` doc is created on first sign-in, so:

1. Open the hosting URL and sign in with your `@ghlogisticsllc.com` account.
2. From the repo root (credentials still exported from step 10):

```bash
node scripts/seed.mjs --admin you@ghlogisticsllc.com
```

3. Reload the app. Your role badge reads `ADMIN` and the Admin tab appears.

If the script prints `No users doc matches …`, the sign-in in step 1 has not happened yet — sign in once, then re-run.

## 13. Local emulator workflow

The emulator suite runs Auth, Firestore, Functions, Storage, and Hosting locally (`firebase.json` sets the ports).

1. Build functions and start the emulators, from the repo root:

```bash
npm --prefix functions install
npm --prefix functions run build
firebase emulators:start
```

2. Seed the emulator in a second Terminal. `GCLOUD_PROJECT` must match the project the emulator started with (your `firebase use` project, or the `--project` flag you passed):

```bash
GCLOUD_PROJECT=<project-id> node scripts/seed.mjs --emulator
```

3. Point the web app at the emulators: set `VITE_USE_EMULATORS=1` in `web/.env`, then:

```bash
npm --prefix web run dev
```

4. Open [http://localhost:5173](http://localhost:5173). The Auth emulator fabricates accounts — enter any `@ghlogisticsllc.com` address; the blocking functions still run and still reject other domains.
5. To grant your emulator account admin, sign in once, then:

```bash
GCLOUD_PROJECT=<project-id> node scripts/seed.mjs --emulator --admin you@ghlogisticsllc.com
```

Notes:

- The emulator serves compiled output — re-run `npm --prefix functions run build` after editing anything in `functions/src`.
- The Emulator UI is at [http://localhost:4000](http://localhost:4000) for browsing Firestore data.
- Emulator data is discarded on shutdown; re-seed on the next start.

## 14. What to verify

1. Sign in with a company account — it works, and the header shows your name, photo, and role badge.
2. Sign in with a personal Gmail — rejected with `Sign-in is restricted to @ghlogisticsllc.com accounts.`
3. Firestore console shows `customers` (4 docs), `failReasons` (34 docs), and `settings/fleet` with OTP 0.97 / OTD 0.95.
4. After step 12, the Admin tab appears and the Admin screen loads customers, reasons, users, and fleet settings.
5. Create a load with pickup and delivery appointments plus actual arrivals — the OTP and OTD chips grade within a few seconds (the `onLoadWrite` function is computing).
6. Edit a stop time, then open the load's History — the revision lists your name, the timestamp, and the before/after values.
7. Drop a tender PDF — status moves `uploaded` → `parsing` → `parsed`, and Review shows the extracted fields (`parseTender` and the `ANTHROPIC_API_KEY` secret are working).
8. Scorecards show OTP against 97% and OTD against 95%, each with its pending count beside it.
9. On the Audit screen, `Generate & save snapshot` returns the week's audit and a `weeklyAudits` doc appears in Firestore.
10. USPS loads show the CF / Non-CF controls; other customers' loads do not.
