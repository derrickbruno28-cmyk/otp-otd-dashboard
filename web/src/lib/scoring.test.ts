import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FLEET, effectiveTarget, gapPoints, gradeLoad, gradeStop, isGhostShutdown,
  summarizeMetric, weekOf, weekRangeLabel,
} from "./scoring";
import { isoToLocalInput, localInputToIso, parseWeightLbs, timeZoneForState } from "./format";
import type { Customer, Load, Stop } from "./types";

const usps: Customer = {
  id: "usps", name: "USPS", aliases: [], targets: { otp: 0.97, otd: null },
  graceMinutes: { pickup: 15, delivery: 15 }, earlyToleranceHours: 2,
  earlyCountsAsMiss: false, cfCodingEnabled: true, active: true, sortOrder: 3,
};

function stop(over: Partial<Stop>): Stop {
  return {
    seq: 1, type: "PICKUP", locationName: "X", address: "", city: "", state: "TX",
    zip: "75001", timeZone: "America/Chicago", appt: null, apptEnd: null,
    actualArrival: null, actualDeparture: null, ...over,
  };
}
function load(stops: Stop[], over: Partial<Load> = {}): Load {
  return {
    lsNumber: "20322", loadNumber: "L1", referenceNumber: "", customerId: "usps",
    operatingCompany: "GH", equipmentType: "", status: "In Transit",
    pieces: null, weightLbs: null, billingMiles: null, commodity: "",
    stops, primaryDriverId: null, secondaryDriverId: null,
    primaryDriverName: "", secondaryDriverName: "", truckNumber: "", runType: "",
    tripNumber: "", isShuttleLeg: false, otpReasons: [], otdReasons: [],
    cf: { otp: null, otd: null }, ...over,
  };
}

describe("gradeStop", () => {
  it("blank actual is PENDING, never a miss (the sheet bug)", () => {
    const r = gradeStop(stop({ appt: "2026-08-10T13:00:00Z" }), usps);
    expect(r.status).toBe("PENDING");
    expect(r.varianceMin).toBeNull();
  });
  it("blank appointment is PENDING", () => {
    const r = gradeStop(stop({ actualArrival: "2026-08-10T13:00:00Z" }), usps);
    expect(r.status).toBe("PENDING");
  });
  it("on time inside grace", () => {
    const r = gradeStop(stop({
      appt: "2026-08-10T13:00:00Z", actualArrival: "2026-08-10T13:14:00Z",
    }), usps);
    expect(r.status).toBe("ON_TIME");
    expect(r.varianceMin).toBe(14);
  });
  it("late one minute past grace", () => {
    const r = gradeStop(stop({
      appt: "2026-08-10T13:00:00Z", actualArrival: "2026-08-10T13:16:00Z",
    }), usps);
    expect(r.status).toBe("LATE");
    expect(r.varianceMin).toBe(16);
  });
  it("window close (apptEnd) drives the deadline; variance stays vs appt", () => {
    const r = gradeStop(stop({
      appt: "2026-08-10T13:00:00Z", apptEnd: "2026-08-10T15:00:00Z",
      actualArrival: "2026-08-10T14:50:00Z",
    }), usps);
    expect(r.status).toBe("ON_TIME");
    expect(r.varianceMin).toBe(110);
  });
  it("very early is EARLY", () => {
    const r = gradeStop(stop({
      appt: "2026-08-10T13:00:00Z", actualArrival: "2026-08-10T10:00:00Z",
    }), usps);
    expect(r.status).toBe("EARLY");
    expect(r.varianceMin).toBe(-180);
  });
});

describe("gradeLoad", () => {
  const stops: Stop[] = [
    stop({ seq: 1, type: "PICKUP", appt: "2026-08-10T13:00:00Z",
      actualArrival: "2026-08-10T12:55:00Z", actualDeparture: "2026-08-10T14:00:00Z" }),
    stop({ seq: 2, type: "DELIVERY", appt: "2026-08-11T13:00:00Z",
      actualArrival: "2026-08-11T14:00:00Z", actualDeparture: "2026-08-11T15:00:00Z" }),
    stop({ seq: 3, type: "DELIVERY", appt: "2026-08-12T13:00:00Z",
      actualArrival: "2026-08-12T13:05:00Z", actualDeparture: "2026-08-12T13:30:00Z" }),
  ];
  const g = gradeLoad(load(stops), usps);

  it("OTP = first PICKUP, OTD = FINAL delivery", () => {
    expect(g.otp.status).toBe("ON_TIME");
    expect(g.otd.status).toBe("ON_TIME");   // final delivery on time…
  });
  it("…but the missed middle stop still drags all-stop %", () => {
    expect(g.stopOnTimePct).toBeCloseTo(2 / 3);
  });
  it("transit = first pickup departure → final delivery arrival", () => {
    expect(g.transitMin).toBe(2825); // Aug 10 14:00Z -> Aug 12 13:05Z = 47h05m
  });
  it("denormalized appointment bookends", () => {
    expect(g.firstPickupAppt).toBe("2026-08-10T13:00:00Z");
    expect(g.finalDeliveryAppt).toBe("2026-08-12T13:00:00Z");
  });
});

describe("summarizeMetric — pending excluded from denominator", () => {
  const mk = (otpStatus: "ON_TIME" | "LATE" | "PENDING") => {
    const l = load([]);
    l.otp = { status: otpStatus, varianceMin: 0, deadline: null };
    return l;
  };
  it("2 on-time, 1 late, 3 pending → 66.7% of 3, pending 3", () => {
    const s = summarizeMetric(
      [mk("ON_TIME"), mk("ON_TIME"), mk("LATE"), mk("PENDING"), mk("PENDING"), mk("PENDING")],
      "otp", { usps },
    );
    expect(s.denominator).toBe(3);
    expect(s.pending).toBe(3);
    expect(s.rate).toBeCloseTo(2 / 3);
  });
});

describe("targets and gap", () => {
  it("USPS OTP target is its own 97; OTD falls back to fleet 95", () => {
    expect(effectiveTarget("otp", usps, DEFAULT_FLEET)).toBe(0.97);
    expect(effectiveTarget("otd", usps, DEFAULT_FLEET)).toBe(0.95);
  });
  it("week 33 audit gap reproduces −15.1", () => {
    expect(gapPoints(118 / 144, 0.97)!).toBeCloseTo(-15.06, 1);
  });
});

describe("weeks — Sunday-start, week 1 contains Jan 1 (NOT ISO)", () => {
  it("Aug 9 2026 is Week 33 of 2026", () => {
    const w = weekOf("2026-08-09T18:00:00Z", "America/Chicago");
    expect(w).toMatchObject({ weekYear: 2026, weekNumber: 33, monthKey: "2026-08" });
  });
  it("Aug 15 2026 (Saturday) is still Week 33; Aug 16 is Week 34", () => {
    expect(weekOf("2026-08-15T18:00:00Z", "America/Chicago").weekNumber).toBe(33);
    expect(weekOf("2026-08-16T18:00:00Z", "America/Chicago").weekNumber).toBe(34);
  });
  it("a UTC instant late on Saturday still lands in the fleet-tz week", () => {
    // Sun Aug 16 03:00 UTC = Sat Aug 15 22:00 CT → week 33
    expect(weekOf("2026-08-16T03:00:00Z", "America/Chicago").weekNumber).toBe(33);
  });
  it("range label matches the audit style", () => {
    expect(weekRangeLabel(2026, 33)).toBe("Aug 9–15, 2026");
  });
  it("year boundary: Dec 28 2025 starts week 1 of 2026", () => {
    expect(weekOf("2025-12-28T18:00:00Z", "America/Chicago"))
      .toMatchObject({ weekYear: 2026, weekNumber: 1 });
    expect(weekOf("2025-12-27T18:00:00Z", "America/Chicago").weekYear).toBe(2025);
  });
});

describe("ghost shutdown (USPS)", () => {
  it("flags a late, undelivered USPS load", () => {
    const l = load([], { status: "In Transit" });
    l.otd = { status: "LATE", varianceMin: 60, deadline: null };
    expect(isGhostShutdown(l)).toBe(true);
  });
  it("clears once Delivered, and never applies to other customers", () => {
    const l = load([], { status: "Delivered" });
    l.otd = { status: "LATE", varianceMin: 60, deadline: null };
    expect(isGhostShutdown(l)).toBe(false);
    const a = load([], { customerId: "aeronet", status: "In Transit" });
    a.otd = { status: "LATE", varianceMin: 60, deadline: null };
    expect(isGhostShutdown(a)).toBe(false);
  });
});

describe("timezone round-trips", () => {
  it("state → zone default", () => {
    expect(timeZoneForState("NC")).toBe("America/New_York");
    expect(timeZoneForState("ms")).toBe("America/Chicago");
  });
  it("wall time round-trips through ISO in CT (CDT)", () => {
    const iso = localInputToIso("2026-08-10T08:00", "America/Chicago")!;
    expect(iso).toBe("2026-08-10T13:00:00.000Z");
    expect(isoToLocalInput(iso, "America/Chicago")).toBe("2026-08-10T08:00");
  });
  it("and in winter (CST)", () => {
    const iso = localInputToIso("2026-01-10T08:00", "America/Chicago")!;
    expect(iso).toBe("2026-01-10T14:00:00.000Z");
  });
});

describe("weight parsing", () => {
  it('parses "8250.000lbs" to 8250', () => {
    expect(parseWeightLbs("8250.000lbs")).toBe(8250);
  });
});

describe("shared-code guard", () => {
  it("functions/src copies of scoring.ts and types.ts are byte-identical", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    for (const f of ["scoring.ts", "types.ts"]) {
      const a = fs.readFileSync(path.join(root, "web/src/lib", f), "utf8");
      const b = fs.readFileSync(path.join(root, "functions/src", f), "utf8");
      expect(b).toBe(a);
    }
  });
});
