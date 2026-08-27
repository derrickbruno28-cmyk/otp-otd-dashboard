import type { CfCode } from "../lib/types";

const SEGMENTS: { v: CfCode | null; label: string; title: string; activeCls: string }[] = [
  {
    v: null, label: "No Flag",
    title: "Not yet coded — this is a to-do, not a verdict",
    activeCls: "bg-pendingSoft text-pending",
  },
  { v: "CF", label: "CF", title: "Contractor failure", activeCls: "bg-lateSoft text-late" },
  { v: "NON_CF", label: "Non-CF", title: "Not contractor failure", activeCls: "bg-ontimeSoft text-ontime" },
  { v: "CF_CHALLENGE", label: "Challenge", title: "Determination under challenge", activeCls: "bg-surface2 text-ink" },
];

export function CfControl({ value, onChange, disabled }: {
  value: CfCode | null;
  onChange(v: CfCode | null): void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="CF determination"
      className={`inline-flex overflow-hidden rounded border border-ruleStrong ${disabled ? "opacity-50" : ""}`}
    >
      {SEGMENTS.map((s, i) => {
        const active = value === s.v;
        return (
          <button
            key={s.label}
            type="button"
            disabled={disabled}
            title={s.title}
            aria-pressed={active}
            onClick={() => { if (!active) onChange(s.v); }}
            className={[
              "px-2 py-0.5 text-xs font-mono whitespace-nowrap",
              i > 0 ? "border-l border-ruleStrong" : "",
              active ? s.activeCls : "bg-surface text-ink3",
              disabled ? "cursor-not-allowed" : active ? "" : "hover:bg-surface2 hover:text-ink2",
            ].join(" ")}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
