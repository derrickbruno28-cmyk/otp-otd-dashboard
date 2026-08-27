import { useState } from "react";
import { useAuth } from "../state/AuthContext";
import { SIGN_IN_DOMAIN } from "../lib/firebase";
import { ErrorNote } from "./ui";

export function SignIn() {
  const { signIn, error } = useAuth();
  const [busy, setBusy] = useState(false);

  const handleSignIn = async () => {
    setBusy(true);
    try { await signIn(); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-nav flex flex-col items-center justify-center gap-10 px-4">
      {/* Text GH mark — placeholder until the real SVG logo arrives. */}
      <div className="flex flex-col items-center gap-3 select-none">
        <span className="font-display font-bold text-7xl text-white leading-none">G<span className="text-brand">/</span>H</span>
        <span className="font-mono text-sm tracking-[0.5em] pl-[0.5em] text-white/60">LOGISTICS</span>
        <span className="font-mono text-[11px] tracking-[0.25em] pl-[0.25em] text-white/40">ROUTE PERFORMANCE TRACKER</span>
      </div>

      <div className="w-full max-w-sm flex flex-col items-center gap-3">
        <button
          onClick={() => void handleSignIn()}
          disabled={busy}
          className="w-full max-w-xs px-5 py-2.5 rounded bg-brand text-brandInk text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Opening Google sign-in…" : "Sign in with Google"}
        </button>
        <p className="font-mono text-xs text-white/50">@{SIGN_IN_DOMAIN} accounts only</p>
        {error && <div className="w-full"><ErrorNote message={error} /></div>}
      </div>
    </div>
  );
}
