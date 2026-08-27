/**
 * THE sign-in gate. The client's `hd` hint only filters the account chooser;
 * these blocking functions are what actually keep non-company accounts out.
 * Requires Identity Platform (see docs/DEPLOY_FIREBASE.md).
 */
import { HttpsError, beforeUserCreated, beforeUserSignedIn } from "firebase-functions/v2/identity";

export const SIGN_IN_DOMAIN = "ghlogisticsllc.com";

function assertCompanyAccount(email: string | undefined, emailVerified: boolean | undefined): void {
  if (!email || !email.toLowerCase().endsWith(`@${SIGN_IN_DOMAIN}`)) {
    throw new HttpsError(
      "permission-denied",
      `Sign-in is restricted to @${SIGN_IN_DOMAIN} accounts.`,
    );
  }
  if (emailVerified === false) {
    throw new HttpsError("permission-denied", "Email address is not verified.");
  }
}

export const enforceDomainOnCreate = beforeUserCreated((event) => {
  assertCompanyAccount(event.data?.email, event.data?.emailVerified);
});

export const enforceDomainOnSignIn = beforeUserSignedIn((event) => {
  assertCompanyAccount(event.data?.email, event.data?.emailVerified);
});
