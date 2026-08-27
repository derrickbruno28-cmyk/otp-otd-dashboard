#!/usr/bin/env node
/**
 * Seed Firestore with the customer roster, fail-reason taxonomy, and fleet settings,
 * and optionally grant the admin role to an existing user.
 *
 * Live project:  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json node scripts/seed.mjs
 * Emulator:      GCLOUD_PROJECT=<project-id> node scripts/seed.mjs --emulator
 * Grant admin:   node scripts/seed.mjs --admin you@ghlogisticsllc.com
 *
 * Idempotent — every write is a merge; re-run any time. Run from the repo root.
 * firebase-admin is resolved from functions/node_modules (no root install needed),
 * so `npm --prefix functions install` must have run first.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = "Usage: node scripts/seed.mjs [--emulator] [--admin you@ghlogisticsllc.com]";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
let useEmulator = false;
let adminEmail = null;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--emulator") {
    useEmulator = true;
  } else if (a === "--admin") {
    adminEmail = args[i + 1];
    i += 1;
    if (!adminEmail || adminEmail.startsWith("--")) fail(`--admin needs an email address.\n${USAGE}`);
  } else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else {
    fail(`Unknown argument: ${a}\n${USAGE}`);
  }
}

// Must be set before the Firestore client is constructed.
if (useEmulator && !process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080"; // firebase.json emulators.firestore.port
}
const emulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

// firebase-admin lives only in functions/node_modules; NODE_PATH is ignored by the ESM
// resolver, so resolve it with a CJS require anchored inside functions/.
const requireFromFunctions = createRequire(join(repoRoot, "functions", "package.json"));
let adminApp;
let adminFirestore;
try {
  adminApp = requireFromFunctions("firebase-admin/app");
  adminFirestore = requireFromFunctions("firebase-admin/firestore");
} catch (err) {
  fail(`Could not load firebase-admin from functions/node_modules (${err.message}).\nRun: npm --prefix functions install`);
}

if (!emulated && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn(
    "GOOGLE_APPLICATION_CREDENTIALS is not set — falling back to gcloud application-default credentials.\n" +
      "For a service-account key: Firebase console → Project settings → Service accounts → Generate new private key.",
  );
}

const projectId =
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  (emulated ? "demo-gh" : undefined);

const app = emulated
  ? adminApp.initializeApp({ projectId })
  : adminApp.initializeApp({
      credential: adminApp.applicationDefault(),
      ...(projectId ? { projectId } : {}),
    });
const db = adminFirestore.getFirestore(app);

function readJson(name) {
  const path = join(repoRoot, "data", name);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`Could not read ${path}: ${err.message}`);
  }
}

const customers = readJson("customers.json");
const failReasons = readJson("failReasons.json");
const fleet = readJson("fleet.json");

async function main() {
  console.log(
    `Seeding ${emulated ? `Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}` : "live Firestore"}` +
      (projectId ? ` (project: ${projectId})` : ""),
  );

  const batch = db.batch();
  for (const { id, ...data } of customers) {
    if (!id) fail("customers.json: entry missing id");
    batch.set(db.doc(`customers/${id}`), data, { merge: true });
  }
  for (const { id, ...data } of failReasons) {
    if (!id) fail("failReasons.json: entry missing id");
    batch.set(db.doc(`failReasons/${id}`), data, { merge: true });
  }
  batch.set(db.doc("settings/fleet"), fleet, { merge: true });
  await batch.commit();
  console.log(
    `Seeded ${customers.length} customers, ${failReasons.length} fail reasons, and settings/fleet.`,
  );

  if (adminEmail) {
    const snap = await db.collection("users").where("email", "==", adminEmail).get();
    if (snap.empty) {
      console.log(`\nNo users doc matches ${adminEmail} — that doc is created on first sign-in.`);
      console.log("Have that person sign in to the app once, then re-run:");
      console.log(`  node scripts/seed.mjs${useEmulator ? " --emulator" : ""} --admin ${adminEmail}`);
    } else {
      for (const doc of snap.docs) {
        await doc.ref.set({ role: "admin" }, { merge: true });
        console.log(`Granted role "admin" to ${adminEmail} (users/${doc.id}).`);
      }
    }
  }
}

main().catch((err) => fail(`Seed failed: ${err.message}`));
