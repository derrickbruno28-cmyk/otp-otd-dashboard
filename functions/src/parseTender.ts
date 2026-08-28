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

/**
 * FieldExtraction — the API's structured-output compiler caps union-typed
 * parameters at 16, and nullable-everywhere blew past it. So the schema is
 * union-free: every value is a plain string, empty string means "not found",
 * and normalizeParse() converts sentinels to real nulls (and numerics to
 * numbers) before anything is stored.
 */
interface RawField { value: unknown; confidence: "high" | "low"; sourceText: string; labelRead: string; }
function normStr(f: RawField | undefined) {
  const v = typeof f?.value === "string" ? f.value.trim() : f?.value ?? "";
  return {
    value: v === "" || v === null || v === undefined ? null : String(v),
    confidence: f?.confidence === "high" ? "high" as const : "low" as const,
    sourceText: f?.sourceText ? String(f.sourceText) : null,
    labelRead: f?.labelRead ? String(f.labelRead) : null,
  };
}
function normNum(f: RawField | undefined) {
  const s = normStr(f);
  if (s.value === null) return { ...s, value: null };
  const m = String(s.value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return { ...s, value: m ? Number(m[0]) : null };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeParse(raw: any): TenderParse {
  const stops = Array.isArray(raw?.stops) ? raw.stops : [];
  return {
    loadNumber: normStr(raw?.loadNumber),
    referenceNumber: normStr(raw?.referenceNumber),
    customerName: normStr(raw?.customerName),
    equipmentType: normStr(raw?.equipmentType),
    pieces: normNum(raw?.pieces),
    weightLbs: normNum(raw?.weightLbs),
    billingMiles: normNum(raw?.billingMiles),
    commodity: normStr(raw?.commodity),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stops: stops.map((st: any) => ({
      type: { ...normStr(st?.type), value:
        st?.type?.value === "PICKUP" || st?.type?.value === "DELIVERY" ? st.type.value : null },
      locationName: normStr(st?.locationName),
      address: normStr(st?.address),
      city: normStr(st?.city),
      state: normStr(st?.state),
      zip: normStr(st?.zip),
      appt: normStr(st?.appt),
      apptEnd: normStr(st?.apptEnd),
    })),
  } as TenderParse;
}

const EXTRACTION_PROMPT = `You are extracting a freight tender / rate confirmation PDF into JSON for a logistics on-time dashboard.

Rules:
- Extract EXACTLY what is printed. A field that is not present in the document returns an EMPTY STRING value — NEVER guess. This matters most for appointment times: a guessed appointment silently corrupts on-time scoring forever.
- Every field carries: value; confidence ("high" only when the printed text is unambiguous, otherwise "low"); sourceText (the verbatim printed text you read the value from, empty string if none); labelRead (the printed label the value appeared under, empty string if none).
- Identifiers: tenders label load and reference numbers inconsistently (Load #, Order #, Pro #, PU #, Ref #, BOL #, Shipment #, …). loadNumber and referenceNumber are separate fields — report in labelRead exactly which printed label each was read from.
- stops is an array in PRINTED ORDER — a four-stop tender produces four stops. type is "PICKUP" for shipper/pickup/origin stops and "DELIVERY" for consignee/delivery/drop stops.
- Appointment times: appt is the appointment (or window open); apptEnd is the window close ONLY when a window is printed, else an empty string. Put the time exactly as printed in sourceText. Set value to an ISO-8601 UTC instant only when the printed date and time are unambiguous, resolved in that stop's own local time zone inferred from its printed city/state; if the date, time, or zone cannot be determined with certainty, return the raw printed string as value with confidence "low".
- state is the 2-letter US state code as printed; zip is a string with leading zeros preserved.
- pieces, weightLbs, billingMiles: give the printed number as a plain string (units are fine, they are stripped later); empty string when not printed.

Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY this shape,
where every leaf field is {"value": string, "confidence": "high"|"low", "sourceText": string, "labelRead": string}
(empty string for anything absent):

{
  "loadNumber": F, "referenceNumber": F, "customerName": F, "equipmentType": F,
  "pieces": F, "weightLbs": F, "billingMiles": F, "commodity": F,
  "stops": [
    { "type": F(value "PICKUP" or "DELIVERY"), "locationName": F, "address": F,
      "city": F, "state": F, "zip": F, "appt": F, "apptEnd": F }
  ]
}`;

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
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first < 0 || last <= first) throw new Error("Model response contained no JSON object.");
      const parsed = normalizeParse(JSON.parse(text.slice(first, last + 1)));
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
