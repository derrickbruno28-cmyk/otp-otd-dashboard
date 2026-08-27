import { useEffect, useState } from "react";
import { atLeast, useAuth } from "../state/AuthContext";
import { useToast } from "./Toast";

export type Tab = "loads" | "scorecards" | "audit" | "drivers" | "admin";

const TABS: { id: Tab; label: string }[] = [
  { id: "loads", label: "Loads" },
  { id: "scorecards", label: "Scorecards" },
  { id: "audit", label: "Audit" },
  { id: "drivers", label: "Drivers" },
  { id: "admin", label: "Admin" },
];

type Theme = "dark" | "light";

function storedTheme(): Theme {
  try {
    return localStorage.getItem("gh-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export function Header({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const { profile, role, signOut } = useAuth();
  const { push } = useToast();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [imgFailed, setImgFailed] = useState(false);

  // Applies the persisted theme on mount and every toggle after.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("gh-theme", theme); } catch { /* storage blocked — theme still applies */ }
  }, [theme]);

  const name = profile?.displayName ?? "";
  const photo = profile?.photoURL ?? "";
  const tabs = TABS.filter((t) => t.id !== "admin" || atLeast(role, "admin"));

  return (
    <header className="bg-nav text-white sticky top-0 z-40 border-b border-white/10">
      <div className="max-w-[1600px] mx-auto px-3 sm:px-5 h-14 flex items-center gap-3 sm:gap-5">
        {/* Text GH mark — placeholder until the real SVG logo arrives. */}
        <div className="flex items-baseline gap-2 shrink-0 select-none">
          <span className="font-display font-bold text-2xl text-white leading-none">G<span className="text-brand">/</span>H</span>
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.3em] text-white/60">LOGISTICS</span>
        </div>

        <nav className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto md:justify-center" aria-label="Sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                tab === t.id ? "bg-white/10 text-white" : "text-white/60 hover:text-white hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            className="p-1.5 rounded text-white/70 hover:text-white hover:bg-white/10"
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>

          {photo && !imgFailed ? (
            <img
              src={photo}
              alt={name}
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="h-7 w-7 rounded-full border border-white/20"
            />
          ) : (
            <span className="h-7 w-7 rounded-full bg-white/10 border border-white/20 grid place-items-center text-[11px] font-semibold text-white/80">
              {initials(name)}
            </span>
          )}
          <span className="hidden sm:inline text-sm text-white/85 max-w-[16ch] truncate">{name}</span>
          <span className="font-mono uppercase text-[10px] tracking-wider text-brand bg-brand/10 border border-brand/40 rounded px-1.5 py-0.5">
            {role}
          </span>
          <button
            onClick={() => { signOut().catch((e: unknown) => push("error", `Sign-out failed: ${String((e as { message?: string })?.message ?? e)}`)); }}
            className="px-2 py-1 rounded border border-white/20 text-xs text-white/60 hover:text-white hover:bg-white/5"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
