import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, signInWithGoogle, signOutUser } from "../lib/firebase";
import { nowIso } from "../lib/format";
import type { AppUser, Role } from "../lib/types";

export interface AuthState {
  /** Firebase user (null = signed out). */
  fbUser: User | null;
  /** Mirrored profile with role, from users/{uid}. */
  profile: AppUser | null;
  role: Role;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, (u) => {
    setFbUser(u);
    if (!u) { setProfile(null); setLoading(false); }
  }), []);

  // Mirror the Google profile into users/{uid} (never the role — rules protect it),
  // then subscribe so a role grant or a Workspace name change follows through live.
  useEffect(() => {
    if (!fbUser) return;
    let cancelled = false;
    setDoc(
      doc(db, "users", fbUser.uid),
      {
        displayName: fbUser.displayName ?? fbUser.email ?? "Unknown",
        email: fbUser.email ?? "",
        photoURL: fbUser.photoURL ?? "",
        lastSignInAt: nowIso(),
        _mirroredAt: serverTimestamp(),
      },
      { merge: true },
    ).catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); });

    const unsub = onSnapshot(
      doc(db, "users", fbUser.uid),
      (snap) => {
        if (cancelled) return;
        const d = snap.data() as Partial<AppUser> | undefined;
        setProfile({
          id: fbUser.uid,
          displayName: d?.displayName ?? fbUser.displayName ?? "",
          email: d?.email ?? fbUser.email ?? "",
          photoURL: d?.photoURL ?? fbUser.photoURL ?? "",
          role: (d?.role as Role) ?? "viewer",
          lastSignInAt: d?.lastSignInAt ?? nowIso(),
        });
        setLoading(false);
      },
      (e) => { if (!cancelled) { setError(String(e?.message ?? e)); setLoading(false); } },
    );
    return () => { cancelled = true; unsub(); };
  }, [fbUser]);

  const value = useMemo<AuthState>(() => ({
    fbUser,
    profile,
    role: profile?.role ?? "viewer",
    loading,
    error,
    signIn: async () => {
      setError(null);
      try { await signInWithGoogle(); }
      catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        if (err.code === "auth/popup-closed-by-user") return;
        setError(err.message ?? "Sign-in failed");
      }
    },
    signOut: signOutUser,
  }), [fbUser, profile, loading, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

export const ROLE_RANK: Record<Role, number> = { viewer: 0, ops: 1, manager: 2, admin: 3 };
export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
