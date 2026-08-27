import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider, connectAuthEmulator, getAuth, signInWithCredential, signInWithPopup, signOut,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectStorageEmulator, getStorage } from "firebase/storage";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

export const SIGN_IN_DOMAIN = "ghlogisticsllc.com";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FB_API_KEY,
  authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FB_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app);

if (import.meta.env.VITE_USE_EMULATORS === "1") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  // E2E/demo hook, emulator-only: the popup path needs apis.google.com, which a
  // sandboxed test network may block. The Auth emulator accepts an unsigned Google
  // credential, and the domain blocking functions still run on it.
  (window as unknown as Record<string, unknown>).__signInWithFakeGoogle = (claims: object) =>
    signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify(claims)));
}

/**
 * Google sign-in. The `hd` parameter only pre-filters the account chooser — it is a UI
 * hint, not security. The real gates are the blocking function (functions/src/identity.ts)
 * and firestore.rules, both of which reject anything outside the domain.
 */
export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: SIGN_IN_DOMAIN, prompt: "select_account" });
  await signInWithPopup(auth, provider);
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}
