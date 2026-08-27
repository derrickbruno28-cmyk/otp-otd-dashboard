import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

export { enforceDomainOnCreate, enforceDomainOnSignIn } from "./identity";
export { onLoadWrite } from "./onLoadWrite";
export { recalcDriverStats } from "./driverStats";
export { evaluateDriverFlags, evaluateDriverFlagsScheduled } from "./driverFlags";
export { generateWeeklyAudit } from "./weeklyAudit";
export { parseTender } from "./parseTender";
