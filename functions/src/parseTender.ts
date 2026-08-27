/**
 * tenders/{tenderId} PDF → structured TenderParse via Claude.
 * A parse NEVER creates a load — a human confirms in the review panel.
 * Missing fields come back null; appointment times are never guessed.
 */
import { createHash } from "crypto";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_FLEET } from "./scoring";
import type { FleetSettings, TenderParse } from "./types";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

type Json = Record<string, unknown>;

/** FieldExtraction<T> — value nullable, confidence, verbatim sourceText, labelRead. */
const field = (value: Json): Json => ({
  type: "object",
  additionalProperties: false,
  required: ["value", "confidence", "sourceText", "labelRead"],
  properties: {
    value: { anyOf: [value, { type: "null" }] },
    confidence: { type: "string", enum: ["high", "low"] },
    sourceText: { type: ["string", "null"] },
    labelRead: { type: ["string", "null"] },
  },
});
const str = field({ type: "string" });
const num = field({ type: "number" });

const TENDER_JSON_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: [
    "loadNumber", "referenceNumber", "customerName", "equipmentType",
    "pieces", "weightLbs", "billingMiles", "commodity", "stops",
  ],
  properties: {
    loadNumber: str,
    referenceNumber: str,
    customerName: str,
    equipmentType: str,
    pieces: num,
    weightLbs: num,
    billingMiles: num,
    commodity: str,
    stops: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "locationName", "address", "city", "state", "zip", "appt", "apptEnd"],
        properties: {
          type: field({ type: "string", enum: ["PICKUP", "DELIVERY"] }),
          locationName: str,
          address: str,
          city: str,
          state: str,
          zip: str,
          appt: str,
          apptEnd: str,
        },
      },
    },
  },
};

const EXTRACTION_PROMPT = `You are extracting a freight tender / rate confirmation PDF into JSON for a logistics on-time dashboard.

Rules:
- Extract EXACTLY what is printed. A field that is not present in the document returns value null — NEVER guess. This matters most for appointment times: a guessed appointment silently corrupts on-time scoring forever.
- Every field carries: value; confidence ("high" only when the printed text is unambiguous, otherwise "low"); sourceText (the verbatim printed text you read the value from, or null); labelRead (the printed label the value appeared under, or null).
- Identifiers: tenders label load and reference numbers inconsistently (Load #, Order #, Pro #, PU #, Ref #, BOL #, Shipment #, …). loadNumber and referenceNumber are separate fields — report in labelRead exactly which printed label each was read from.
- stops is an array in PRINTED ORDER — a four-stop tender produces four stops. type is "PICKUP" for shipper/pickup/origin stops and "DELIVERY" for consignee/delivery/drop stops.
- Appointment times: appt is the appointment (or window open); apptEnd is the window close ONLY when a window is printed, else null. Put the time exactly as printed in sourceText. Set value to an ISO-8601 UTC instant only when the printed date and time are unambiguous, resolved in that stop's own local time zone inferred from its printed city/state; if the date, time, or zone cannot be determined with certainty, return the raw printed string as value with confidence "low".
- state is the 2-letter US state code as printed; zip is a string with leading zeros preserved.
- pieces, weightLbs, billingMiles are numbers (strip units and thousands separators); null when not printed.

Return only JSON matching the schema.`;

export const parseTender = onObjectFinalized(
  { secrets: [ANTHROPIC_API_KEY], memory: "1GiB", timeoutSeconds: 540 },
  async (event) => {
    const name = event.data.name ?? "";
    const match = name.match(/^tenders\/([^/]+)$/);
    if (!match) return;
    const tenderId = match[1];
    const ref = getFirestore().collection("tenders").doc(tenderId);

    const file = getStorage().bucket(event.data.bucket).file(name);
    // Only parse objects that belong to a tender doc an ops user created first
    // (status "uploaded"). Anything else at this path is an orphan — delete it
    // rather than burn a model call on an arbitrary PDF.
    const existing = await ref.get();
    const existingStatus = existing.exists ? (existing.data() as { status?: string }).status : null;
    if (existingStatus !== "uploaded" && existingStatus !== "parsing") {
      console.warn(`Orphan or out-of-band object at ${name} (doc status: ${existingStatus}); deleting object.`);
      await file.delete({ ignoreNotFound: true });
      return;
    }

    try {
      const [bytes] = await file.download();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await ref.set({ status: "parsing", sha256 }, { merge: true });

      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const res = await client.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema: TENDER_JSON_SCHEMA } },
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
            },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        }],
      });

      if (res.stop_reason === "refusal") {
        await ref.set(
          { status: "error", error: "The model declined to process this document." },
          { merge: true },
        );
        return;
      }
      let text = "";
      for (const block of res.content) if (block.type === "text") text += block.text;
      if (!text) throw new Error(`Empty model response (stop_reason: ${res.stop_reason ?? "unknown"}).`);
      const parsed = JSON.parse(text) as TenderParse;
      if (!Array.isArray(parsed.stops)) throw new Error("Parsed JSON is missing the stops array.");
      await ref.set({ status: "parsed", parsed, error: null }, { merge: true });

      const fleetSnap = await getFirestore().collection("settings").doc("fleet").get();
      const fleet: FleetSettings = fleetSnap.exists
        ? { ...DEFAULT_FLEET, ...(fleetSnap.data() as FleetSettings) }
        : DEFAULT_FLEET;
      if (fleet.retainTenderPdf === false) {
        await file.delete({ ignoreNotFound: true });
        await ref.set({ storagePath: null }, { merge: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ref.set({ status: "error", error: message }, { merge: true });
    }
  },
);

/**
 * Retention: when settings/fleet.tenderRetentionDays is set, strip stored tender
 * PDFs older than the window (the parsed record, sha256 fingerprint, and filename
 * remain). Runs daily; deletes are logged per tender.
 */
export const purgeTenderPdfs = onSchedule(
  { schedule: "every day 03:00", timeZone: "America/Chicago" },
  async () => {
    const fleetSnap = await getFirestore().collection("settings").doc("fleet").get();
    const fleet: FleetSettings = fleetSnap.exists
      ? { ...DEFAULT_FLEET, ...(fleetSnap.data() as FleetSettings) }
      : DEFAULT_FLEET;
    const days = fleet.tenderRetentionDays;
    if (typeof days !== "number" || days <= 0) return;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const snap = await getFirestore().collection("tenders")
      .where("createdAt", "<", cutoff)
      .limit(500)
      .get();
    for (const docSnap of snap.docs) {
      const t = docSnap.data() as { storagePath?: string | null };
      if (!t.storagePath) continue;
      try {
        await getStorage().bucket().file(t.storagePath).delete({ ignoreNotFound: true });
        await docSnap.ref.set({ storagePath: null }, { merge: true });
        console.log(`Purged tender PDF ${t.storagePath} (older than ${days}d)`);
      } catch (e) {
        console.error(`Failed to purge ${t.storagePath}:`, e);
      }
    }
  },
);
