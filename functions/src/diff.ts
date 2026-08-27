/** Field-level diff for revisions. Arrays of objects (stops, reasons) diff per index+key. */
import type { RevisionChange } from "./types";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

const SKIP_KEYS = new Set([
  "updatedAt", "updatedBy", "updatedByName", "lastWriteSource", "_mirroredAt",
]);

export function diffObjects(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  prefix = "",
): RevisionChange[] {
  const out: RevisionChange[] = [];
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    if (!prefix && SKIP_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const bv = b[key];
    const av = a[key];
    if (deepEqual(bv, av)) continue;
    if (Array.isArray(bv) && Array.isArray(av)) {
      const len = Math.max(bv.length, av.length);
      for (let i = 0; i < len; i++) {
        const bi = bv[i];
        const ai = av[i];
        if (deepEqual(bi, ai)) continue;
        if (isPlainObject(bi) && isPlainObject(ai)) {
          out.push(...diffObjects(bi, ai, `${path}[${i}]`));
        } else {
          out.push({ path: `${path}[${i}]`, before: bi ?? null, after: ai ?? null });
        }
      }
      continue;
    }
    if (isPlainObject(bv) && isPlainObject(av)) {
      out.push(...diffObjects(bv, av, path));
      continue;
    }
    out.push({ path, before: bv ?? null, after: av ?? null });
  }
  return out;
}

/** Human sentence for the History panel: the load's story, not a debug dump. */
export function summarizeChanges(changes: RevisionChange[]): string {
  if (!changes.length) return "No visible changes";
  const parts: string[] = [];
  const label = (p: string) =>
    p.replace(/^stops\[(\d+)\]\./, (_, i) => `stop ${Number(i) + 1} `)
      .replace(/([A-Z])/g, (m) => " " + m.toLowerCase())
      .replace(/\./g, " ")
      .trim();
  for (const c of changes.slice(0, 6)) {
    const b = c.before === null || c.before === undefined || c.before === "" ? "—" : String(c.before);
    const a = c.after === null || c.after === undefined || c.after === "" ? "—" : String(c.after);
    if (typeof c.after === "object" || typeof c.before === "object") {
      parts.push(`${label(c.path)} updated`);
    } else {
      parts.push(`${label(c.path)}: ${b} → ${a}`);
    }
  }
  if (changes.length > 6) parts.push(`+${changes.length - 6} more`);
  return parts.join("; ");
}
