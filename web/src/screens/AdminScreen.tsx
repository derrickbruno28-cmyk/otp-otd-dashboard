import { useEffect, useMemo, useState } from "react";
import { doc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { fmtDateTime, tzAbbr } from "../lib/format";
import { atLeast, useAuth } from "../state/AuthContext";
import { useData } from "../state/DataContext";
import { useToast } from "../components/Toast";
import { Chip, EmptyState, ErrorNote, Field, Section } from "../components/ui";
import type { Customer, FailReason, FleetSettings, ReasonCategory, Role } from "../lib/types";

const INPUT =
  "rounded border border-ruleStrong bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:border-brand disabled:opacity-50";
const TH = "text-left text-xs font-mono uppercase tracking-wide text-ink3 px-2 py-1.5 whitespace-nowrap";
const TD = "px-2 py-1.5 align-middle border-t border-rule";
const SAVE_BTN =
  "px-3 py-1.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50";

const CATEGORIES: ReasonCategory[] = [
  "DRIVER", "SHIPPER", "DISPATCH", "BROKERAGE", "MECHANICAL", "EXTERNAL", "PLANNING", "COMPLIANCE",
];
const APPLIES: FailReason["appliesTo"][] = ["OTP", "OTD", "BOTH"];
const ROLES: Role[] = ["viewer", "ops", "manager", "admin"];
const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];

/** 0.97 → "97"; null → "" (inherit fleet). */
function fracToPct(v: number | null): string {
  return v === null ? "" : String(Math.round(v * 1000) / 10);
}
/** "97" → 0.97; "" → null; junk → undefined. */
function pctToFrac(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : undefined;
}
/** Non-negative number, required; junk/blank → undefined. */
function numOf(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e);
}

/* ---------------------------- Customers ---------------------------- */

interface CustomerDraft {
  aliases: string;
  otp: string; otd: string;
  gracePickup: string; graceDelivery: string; earlyTol: string;
  earlyCountsAsMiss: boolean; cfCodingEnabled: boolean; active: boolean;
}
function toCustomerDraft(c: Customer): CustomerDraft {
  return {
    aliases: c.aliases.join(", "),
    otp: fracToPct(c.targets.otp),
    otd: fracToPct(c.targets.otd),
    gracePickup: String(c.graceMinutes.pickup),
    graceDelivery: String(c.graceMinutes.delivery),
    earlyTol: String(c.earlyToleranceHours),
    earlyCountsAsMiss: c.earlyCountsAsMiss,
    cfCodingEnabled: c.cfCodingEnabled,
    active: c.active,
  };
}

function CustomersTab() {
  const { customers, fleet } = useData();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, CustomerDraft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const edit = (id: string, c: Customer, patch: Partial<CustomerDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? toCustomerDraft(c)), ...patch } }));

  const save = async (c: Customer) => {
    const id = String(c.id);
    const d = drafts[id];
    if (!d) return;
    const otp = pctToFrac(d.otp);
    const otd = pctToFrac(d.otd);
    if (otp === undefined || otd === undefined) {
      toast.push("error", `${c.name}: targets must be 0–100 (whole percent) or blank to inherit the fleet default.`);
      return;
    }
    const gp = numOf(d.gracePickup), gd = numOf(d.graceDelivery), et = numOf(d.earlyTol);
    if (gp === undefined || gd === undefined || et === undefined) {
      toast.push("error", `${c.name}: grace minutes and early tolerance must be non-negative numbers.`);
      return;
    }
    setBusyId(id);
    try {
      await setDoc(
        doc(db, "customers", id),
        {
          aliases: d.aliases.split(",").map((s) => s.trim()).filter(Boolean),
          targets: { otp, otd },
          graceMinutes: { pickup: gp, delivery: gd },
          earlyToleranceHours: et,
          earlyCountsAsMiss: d.earlyCountsAsMiss,
          cfCodingEnabled: d.cfCodingEnabled,
          active: d.active,
        },
        { merge: true },
      );
      setDrafts(({ [id]: _, ...rest }) => rest);
      toast.push("ok", `${c.name} saved.`);
    } catch (e) {
      toast.push("error", `Saving ${c.name} failed: ${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  if (!customers.length) {
    return <EmptyState title="No customers" hint="Run the seed script (scripts/seed.mjs) to create the customer set." />;
  }
  return (
    <Section title="Customers">
      <div className="scroll-x">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Name</th>
              <th className={TH}>Aliases (comma-separated)</th>
              <th className={TH}>OTP target %</th>
              <th className={TH}>OTD target %</th>
              <th className={TH}>Grace PU min</th>
              <th className={TH}>Grace DEL min</th>
              <th className={TH}>Early tol hrs</th>
              <th className={TH}>Early = miss</th>
              <th className={TH} title="CF / Non-CF coding — USPS only">CF / Non-CF coding — USPS only</th>
              <th className={TH}>Active</th>
              <th className={TH} />
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => {
              const id = String(c.id);
              const d = drafts[id] ?? toCustomerDraft(c);
              const dirty = id in drafts;
              const busy = busyId === id;
              return (
                <tr key={id}>
                  <td className={`${TD} whitespace-nowrap`}>
                    <div className="font-semibold">{c.name}</div>
                    <div className="font-mono text-xs text-ink3">{id}</div>
                  </td>
                  <td className={TD}>
                    <input className={`${INPUT} w-56`} value={d.aliases} disabled={busy}
                      onChange={(e) => edit(id, c, { aliases: e.target.value })} />
                  </td>
                  <td className={TD}>
                    <input type="number" min={0} max={100} step={0.1}
                      className={`${INPUT} tnum w-20`} value={d.otp} disabled={busy}
                      placeholder={fracToPct(fleet.targets.otp)}
                      title="Blank = fleet default"
                      onChange={(e) => edit(id, c, { otp: e.target.value })} />
                  </td>
                  <td className={TD}>
                    <input type="number" min={0} max={100} step={0.1}
                      className={`${INPUT} tnum w-20`} value={d.otd} disabled={busy}
                      placeholder={fracToPct(fleet.targets.otd)}
                      title="Blank = fleet default"
                      onChange={(e) => edit(id, c, { otd: e.target.value })} />
                  </td>
                  <td className={TD}>
                    <input type="number" min={0} className={`${INPUT} tnum w-16`} value={d.gracePickup} disabled={busy}
                      onChange={(e) => edit(id, c, { gracePickup: e.target.value })} />
                  </td>
                  <td className={TD}>
                    <input type="number" min={0} className={`${INPUT} tnum w-16`} value={d.graceDelivery} disabled={busy}
                      onChange={(e) => edit(id, c, { graceDelivery: e.target.value })} />
                  </td>
                  <td className={TD}>
                    <input type="number" min={0} step={0.5} className={`${INPUT} tnum w-16`} value={d.earlyTol} disabled={busy}
                      onChange={(e) => edit(id, c, { earlyTol: e.target.value })} />
                  </td>
                  <td className={`${TD} text-center`}>
                    <input type="checkbox" className="h-4 w-4" checked={d.earlyCountsAsMiss} disabled={busy}
                      aria-label={`${c.name}: early counts as miss`}
                      onChange={(e) => edit(id, c, { earlyCountsAsMiss: e.target.checked })} />
                  </td>
                  <td className={`${TD} text-center`}>
                    <input type="checkbox" className="h-4 w-4" checked={d.cfCodingEnabled} disabled={busy}
                      aria-label={`${c.name}: CF / Non-CF coding — USPS only`}
                      onChange={(e) => edit(id, c, { cfCodingEnabled: e.target.checked })} />
                  </td>
                  <td className={`${TD} text-center`}>
                    <input type="checkbox" className="h-4 w-4" checked={d.active} disabled={busy}
                      aria-label={`${c.name}: active`}
                      onChange={(e) => edit(id, c, { active: e.target.checked })} />
                  </td>
                  <td className={TD}>
                    <button type="button" className={SAVE_BTN} disabled={!dirty || busy}
                      onClick={() => void save(c)}>
                      {busy ? "Saving…" : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* --------------------------- Fail reasons --------------------------- */

interface ReasonDraft {
  label: string;
  category: ReasonCategory;
  appliesTo: FailReason["appliesTo"];
  active: boolean;
  sortOrder: string;
}
function toReasonDraft(r: FailReason): ReasonDraft {
  return {
    label: r.label, category: r.category, appliesTo: r.appliesTo,
    active: r.active, sortOrder: String(r.sortOrder),
  };
}

function ReasonsTab() {
  const { reasons, reasonsById } = useData();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, ReasonDraft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [add, setAdd] = useState<{ label: string; category: ReasonCategory; appliesTo: FailReason["appliesTo"]; sortOrder: string }>(
    { label: "", category: "DRIVER", appliesTo: "BOTH", sortOrder: "" },
  );
  const [adding, setAdding] = useState(false);
  const addId = slugify(add.label);

  const grouped = useMemo(
    () => CATEGORIES.map((cat) => ({
      cat,
      rows: reasons.filter((r) => r.category === cat)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)),
    })).filter((g) => g.rows.length > 0),
    [reasons],
  );

  const edit = (id: string, r: FailReason, patch: Partial<ReasonDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? toReasonDraft(r)), ...patch } }));

  const save = async (r: FailReason) => {
    const id = String(r.id);
    const d = drafts[id];
    if (!d) return;
    if (!d.label.trim()) { toast.push("error", "Reason label cannot be blank."); return; }
    const so = numOf(d.sortOrder);
    if (so === undefined) { toast.push("error", `${d.label}: sort order must be a non-negative number.`); return; }
    setBusyId(id);
    try {
      await setDoc(
        doc(db, "failReasons", id),
        { label: d.label.trim(), category: d.category, appliesTo: d.appliesTo, active: d.active, sortOrder: so },
        { merge: true },
      );
      setDrafts(({ [id]: _, ...rest }) => rest);
      toast.push("ok", `${d.label.trim()} saved.`);
    } catch (e) {
      toast.push("error", `Saving reason failed: ${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const addReason = async () => {
    const label = add.label.trim();
    if (!label || !addId) { toast.push("error", "Enter a label for the new reason."); return; }
    if (reasonsById[addId]) { toast.push("error", `Code "${addId}" already exists.`); return; }
    let so = numOf(add.sortOrder);
    if (add.sortOrder.trim() && so === undefined) {
      toast.push("error", "Sort order must be a non-negative number (or blank for end of category).");
      return;
    }
    if (so === undefined) {
      const inCat = reasons.filter((r) => r.category === add.category);
      so = inCat.length ? Math.max(...inCat.map((r) => r.sortOrder)) + 1 : 1;
    }
    setAdding(true);
    try {
      await setDoc(doc(db, "failReasons", addId), {
        label, category: add.category, appliesTo: add.appliesTo, active: true, sortOrder: so,
      });
      setAdd({ label: "", category: add.category, appliesTo: "BOTH", sortOrder: "" });
      toast.push("ok", `Added ${label}.`);
    } catch (e) {
      toast.push("error", `Adding reason failed: ${errMsg(e)}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink3">Codes are chosen from this list in the app — never typed.</p>
      <Section title="Add a fail reason">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Label">
            <input className={`${INPUT} w-72`} value={add.label} disabled={adding}
              placeholder="Driver – Made Multiple Stops"
              onChange={(e) => setAdd((a) => ({ ...a, label: e.target.value }))} />
          </Field>
          <Field label="Code (derived)">
            <input className={`${INPUT} font-mono w-72 text-ink3`} value={addId} readOnly disabled
              aria-label="Derived reason code" />
          </Field>
          <Field label="Category">
            <select className={INPUT} value={add.category} disabled={adding}
              onChange={(e) => setAdd((a) => ({ ...a, category: e.target.value as ReasonCategory }))}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Applies to">
            <select className={INPUT} value={add.appliesTo} disabled={adding}
              onChange={(e) => setAdd((a) => ({ ...a, appliesTo: e.target.value as FailReason["appliesTo"] }))}>
              {APPLIES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Sort order" hint="Blank = end of category">
            <input type="number" min={0} className={`${INPUT} tnum w-24`} value={add.sortOrder} disabled={adding}
              onChange={(e) => setAdd((a) => ({ ...a, sortOrder: e.target.value }))} />
          </Field>
          <button type="button" className={SAVE_BTN} disabled={adding || !addId}
            onClick={() => void addReason()}>
            {adding ? "Adding…" : "Add reason"}
          </button>
        </div>
      </Section>
      {!reasons.length ? (
        <EmptyState title="No fail reasons" hint="Run the seed script (scripts/seed.mjs) to load the 34-reason taxonomy." />
      ) : (
        <Section title="Fail reason taxonomy">
          <div className="scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={TH}>Label</th>
                  <th className={TH}>Code</th>
                  <th className={TH}>Category</th>
                  <th className={TH}>Applies to</th>
                  <th className={TH}>Sort</th>
                  <th className={TH}>Active</th>
                  <th className={TH} />
                </tr>
              </thead>
              {grouped.map((g) => (
                <tbody key={g.cat}>
                  <tr>
                    <td colSpan={7}
                      className={`${TD} font-mono text-xs uppercase tracking-wide ${g.cat === "DRIVER" ? "text-catDriver" : "text-ink3"}`}>
                      {g.cat}
                    </td>
                  </tr>
                  {g.rows.map((r) => {
                    const id = String(r.id);
                    const d = drafts[id] ?? toReasonDraft(r);
                    const dirty = id in drafts;
                    const busy = busyId === id;
                    return (
                      <tr key={id}>
                        <td className={TD}>
                          <input className={`${INPUT} w-80`} value={d.label} disabled={busy}
                            onChange={(e) => edit(id, r, { label: e.target.value })} />
                        </td>
                        <td className={`${TD} font-mono text-xs text-ink3 whitespace-nowrap`}>{id}</td>
                        <td className={TD}>
                          <select className={`${INPUT} ${d.category === "DRIVER" ? "text-catDriver" : ""}`}
                            value={d.category} disabled={busy}
                            onChange={(e) => edit(id, r, { category: e.target.value as ReasonCategory })}>
                            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td className={TD}>
                          <select className={INPUT} value={d.appliesTo} disabled={busy}
                            onChange={(e) => edit(id, r, { appliesTo: e.target.value as FailReason["appliesTo"] })}>
                            {APPLIES.map((a) => <option key={a} value={a}>{a}</option>)}
                          </select>
                        </td>
                        <td className={TD}>
                          <input type="number" min={0} className={`${INPUT} tnum w-16`} value={d.sortOrder} disabled={busy}
                            onChange={(e) => edit(id, r, { sortOrder: e.target.value })} />
                        </td>
                        <td className={`${TD} text-center`}>
                          <input type="checkbox" className="h-4 w-4" checked={d.active} disabled={busy}
                            aria-label={`${r.label}: active`}
                            onChange={(e) => edit(id, r, { active: e.target.checked })} />
                        </td>
                        <td className={TD}>
                          <button type="button" className={SAVE_BTN} disabled={!dirty || busy}
                            onClick={() => void save(r)}>
                            {busy ? "Saving…" : "Save"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

/* ------------------------------ Users ------------------------------ */

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

function UsersTab() {
  const { users, fleet } = useData();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const sorted = useMemo(
    () => [...users].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [users],
  );

  const setRole = async (uid: string, name: string, role: Role) => {
    setBusyId(uid);
    try {
      await updateDoc(doc(db, "users", uid), { role });
      toast.push("ok", `${name} is now ${role}.`);
    } catch (e) {
      toast.push("error", `Role change for ${name} failed: ${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  if (!sorted.length) {
    return <EmptyState title="No users yet" hint="Users appear here after their first sign-in." />;
  }
  return (
    <Section title="Users">
      <div className="scroll-x">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH} />
              <th className={TH}>Name</th>
              <th className={TH}>Email</th>
              <th className={TH}>Role</th>
              <th className={TH}>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((u) => {
              const uid = String(u.id);
              const busy = busyId === uid;
              return (
                <tr key={uid}>
                  <td className={`${TD} w-10`}>
                    {u.photoURL ? (
                      <img src={u.photoURL} alt="" referrerPolicy="no-referrer"
                        className="h-7 w-7 rounded-full object-cover" />
                    ) : (
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-surface2 text-xs font-mono text-ink2">
                        {initials(u.displayName)}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} whitespace-nowrap font-semibold`}>{u.displayName}</td>
                  <td className={`${TD} font-mono text-xs text-ink2 whitespace-nowrap`}>{u.email}</td>
                  <td className={TD}>
                    <select className={INPUT} value={u.role} disabled={busy}
                      aria-label={`Role for ${u.displayName}`}
                      onChange={(e) => void setRole(uid, u.displayName, e.target.value as Role)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className={`${TD} font-mono text-xs text-ink2 whitespace-nowrap tnum`}>
                    {fmtDateTime(u.lastSignInAt, fleet.timeZone)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/* ------------------------------ Fleet ------------------------------ */

interface FleetDraft {
  otp: string; otd: string; timeZone: string;
  retainTenderPdf: boolean; tenderRetentionDays: string;
}
function toFleetDraft(f: FleetSettings): FleetDraft {
  return {
    otp: fracToPct(f.targets.otp),
    otd: fracToPct(f.targets.otd),
    timeZone: f.timeZone,
    retainTenderPdf: f.retainTenderPdf,
    tenderRetentionDays: f.tenderRetentionDays === null ? "" : String(f.tenderRetentionDays),
  };
}

function FleetTab() {
  const { fleet } = useData();
  const toast = useToast();
  const [draft, setDraft] = useState<FleetDraft>(() => toFleetDraft(fleet));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(toFleetDraft(fleet));
  }, [fleet, dirty]);

  const edit = (patch: Partial<FleetDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    const otp = pctToFrac(draft.otp);
    const otd = pctToFrac(draft.otd);
    if (otp === undefined || otp === null || otd === undefined || otd === null) {
      toast.push("error", "Fleet targets are required — enter whole percents 0–100.");
      return;
    }
    const days = draft.tenderRetentionDays.trim() === "" ? null : numOf(draft.tenderRetentionDays);
    if (days === undefined) {
      toast.push("error", "Tender retention days must be a non-negative number or blank.");
      return;
    }
    setSaving(true);
    try {
      await setDoc(doc(db, "settings", "fleet"), {
        targets: { otp, otd },
        timeZone: draft.timeZone,
        retainTenderPdf: draft.retainTenderPdf,
        tenderRetentionDays: days,
        signInDomain: fleet.signInDomain,
      });
      setDirty(false);
      toast.push("ok", "Fleet settings saved.");
    } catch (e) {
      toast.push("error", `Saving fleet settings failed: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Fleet settings"
      right={
        <button type="button" className={SAVE_BTN} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Field label="OTP target %" hint="Fleet default; customers inherit this when their target is blank">
          <input type="number" min={0} max={100} step={0.1} className={`${INPUT} tnum w-24`}
            value={draft.otp} disabled={saving}
            onChange={(e) => edit({ otp: e.target.value })} />
        </Field>
        <Field label="OTD target %">
          <input type="number" min={0} max={100} step={0.1} className={`${INPUT} tnum w-24`}
            value={draft.otd} disabled={saving}
            onChange={(e) => edit({ otd: e.target.value })} />
        </Field>
        <Field label="Fleet time zone" hint="Week and month bucketing use this zone">
          <select className={`${INPUT} w-full`} value={draft.timeZone} disabled={saving}
            onChange={(e) => edit({ timeZone: e.target.value })}>
            {TIMEZONES.map((z) => <option key={z} value={z}>{z} ({tzAbbr(z)})</option>)}
          </select>
        </Field>
        <Field label="Tender retention days" hint="Blank = keep indefinitely">
          <input type="number" min={0} className={`${INPUT} tnum w-24`}
            value={draft.tenderRetentionDays} disabled={saving}
            onChange={(e) => edit({ tenderRetentionDays: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink sm:col-span-2">
          <input type="checkbox" className="h-4 w-4" checked={draft.retainTenderPdf} disabled={saving}
            onChange={(e) => edit({ retainTenderPdf: e.target.checked })} />
          Keep tender PDFs (evidence for disputes)
        </label>
        <Field label="Sign-in domain" hint="Read-only — changing this requires redeploying the blocking function">
          <input className={`${INPUT} font-mono w-full text-ink3`} value={fleet.signInDomain} readOnly disabled />
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------ Screen ------------------------------ */

type AdminTab = "customers" | "reasons" | "users" | "fleet";
const TABS: { key: AdminTab; label: string }[] = [
  { key: "customers", label: "Customers" },
  { key: "reasons", label: "Fail Reasons" },
  { key: "users", label: "Users" },
  { key: "fleet", label: "Fleet" },
];

export function AdminScreen() {
  const { role } = useAuth();
  const [tab, setTab] = useState<AdminTab>("customers");

  if (!atLeast(role, "admin")) {
    return <ErrorNote message="Admin access required. Ask an administrator to grant your account the admin role." />;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Chip key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </Chip>
        ))}
      </div>
      {tab === "customers" ? <CustomersTab /> :
        tab === "reasons" ? <ReasonsTab /> :
        tab === "users" ? <UsersTab /> : <FleetTab />}
    </div>
  );
}
