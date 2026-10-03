import { describe, expect, it } from "vitest";
import { localFinalPlan, localRunEnd, localTactical } from "../src/agent/localRig";
import type { LedgerEntry } from "../src/shared/rig";
import { makeObservation, PROFILES } from "./fixtures";

const run = (profile: keyof typeof PROFILES, extra = {}) =>
  localTactical(makeObservation({ model: PROFILES[profile], ...extra })).decision;

describe("localTactical profiles", () => {
  it("reads each simulated player differently", () => {
    const right = run("RIGHT_HUGGER");
    const left = run("LEFT_HUGGER");
    const cautious = run("CAUTIOUS");
    const aggressive = run("AGGRESSIVE");

    expect(right.action.side).toBe("R");
    expect(left.action.side).toBe("L");
    expect(["laneBias", "wallPark"]).toContain(right.hypothesis.field);
    expect(cautious.hypothesis.field).toBe("style");
    expect(cautious.action.ability).toBe("PULSE");
    expect(["style", "correctionRate"]).toContain(aggressive.hypothesis.field);
    expect(aggressive.action.ability).toBe("MAGNET");

    const signatures = new Set([right, left, cautious, aggressive].map((d) => `${d.hypothesis.field}/${d.action.ability}/${d.action.side}`));
    expect(signatures.size).toBe(4);
    for (const d of [right, left, cautious, aggressive]) {
      expect(d.prediction).not.toBeNull();
      expect(d.taunt.length).toBeGreaterThan(0);
      expect(d.taunt).not.toMatch(/!/);
    }
  });

  it("is deterministic for the same observation", () => {
    const obs = makeObservation({ model: PROFILES.RIGHT_HUGGER });
    expect(localTactical(obs)).toEqual(localTactical(obs));
  });

  it("waits on a neutral, thin model", () => {
    const d = localTactical(makeObservation()).decision;
    expect(d.action.ability).toBe("WAIT");
    expect(d.intent).toBe("hold");
  });

  it("only says 'I remember you.' with real memory", () => {
    const withMem = localTactical(
      makeObservation({ memory: { runs: 2, wins: 0, bestTimeMs: null, prior: { laneBias: null, panicSide: null, wallParkSide: null, reactionMs: null, style: null, bestAbility: null, worstAbility: null }, notes: [], lastSeenHoursAgo: 3 } }),
    ).decision;
    expect(withMem.taunt).toBe("I remember you.");
    expect(localTactical(makeObservation()).decision.taunt).not.toBe("I remember you.");
  });

  it("probes gently when confidence is low and in calibration", () => {
    const low = run("RIGHT_HUGGER", { model: { ...PROFILES.RIGHT_HUGGER, laneBias: { ...PROFILES.RIGHT_HUGGER.laneBias, c: 0.35 }, wallPark: { ...PROFILES.RIGHT_HUGGER.wallPark, c: 0.3 } } });
    expect(low.intent).toBe("probe");
    expect(low.action.intensity).toBe(1);
    const calib = run("RIGHT_HUGGER", { chamber: { n: 1, template: "CALIBRATION" }, pressure: { note: "calibration: one gentle probe allowed" } });
    expect(calib.action.intensity).toBe(1);
  });

  it("respects allowed abilities and gives relief on a death streak", () => {
    const onlyPulse = run("RIGHT_HUGGER", { pressure: { allowed: ["PULSE", "WAIT"] } });
    expect(["PULSE", "WAIT"]).toContain(onlyPulse.action.ability);
    const relief = run("RIGHT_HUGGER", { pressure: { deathStreak: 3 } });
    expect(relief.intent).toBe("relief");
    expect(relief.action.ability).toBe("WAIT");
  });

  it("picks a chamber that tests the strongest read", () => {
    const d = run("RIGHT_HUGGER", { wantNextChamber: true });
    expect(d.nextChamber?.template).toBe("SPLITTER");
    expect(d.nextChamber?.pressureSide).toBe("R");
    const noSplitter = run("RIGHT_HUGGER", { wantNextChamber: true, chamber: { remainingTemplates: ["FUNNEL", "TOWER"] } });
    expect(noSplitter.nextChamber?.template).toBe("FUNNEL");
  });
});

describe("ADAPTER: hypothesis revision and abandonment", () => {
  const entry = (weakened: number, status: LedgerEntry["status"] = "active"): LedgerEntry => ({
    id: "h1", field: "panicDirection", claim: "Flees right.", confidence: 0.6, supported: 1, weakened, status, source: "local",
  });
  const outcome = { ability: "PULSE" as const, side: "R" as const, hypothesisId: "h1", prediction: "flee R within 1800ms", verdict: "WEAKENED" as const, observed: "fled L in 400ms", killed: false };

  it("first exploits the panic read", () => {
    const d = run("ADAPTER");
    expect(d.hypothesis.field).toBe("panicDirection");
    expect(d.action.ability).toBe("PULSE");
  });

  it("revises after one WEAKENED, without repeating the failed ability", () => {
    const d = run("ADAPTER", { ledger: [entry(1)], lastOutcome: outcome });
    if (d.hypothesis.field === "panicDirection") {
      expect(d.hypothesis.status).toBe("revise");
      expect(d.action.ability).not.toBe("PULSE");
    }
  });

  it("abandons after WEAKENED twice, then moves on", () => {
    const d = run("ADAPTER", { ledger: [entry(2)], lastOutcome: outcome });
    expect(d.hypothesis.status).toBe("abandon");
    expect(d.hypothesis.ref).toBe("h1");
    expect(d.action.ability).toBe("WAIT");

    const next = run("ADAPTER", { ledger: [entry(2, "abandoned")], lastOutcome: null, epoch: "c2.l2" });
    expect(next.hypothesis.field).not.toBe("panicDirection");
  });
});

describe("final plan and run end", () => {
  it("builds the final room against the strongest signals", () => {
    const d = localFinalPlan(makeObservation({ model: PROFILES.RIGHT_HUGGER })).decision;
    expect(d.targets[0]).toMatch(/laneBias|wallPark/);
    expect(d.trapSide).toBe("R");
    expect(d.exitSide).toBe("L");
    expect(d.loadout.length).toBeGreaterThan(0);
  });

  it("writes specific memory notes with numbers", () => {
    const d = localRunEnd(makeObservation({ model: PROFILES.RIGHT_HUGGER }), { result: "abandoned", deaths: 4 }).decision;
    expect(d.memoryNotes.length).toBeGreaterThan(0);
    expect(d.memoryNotes.join(" ")).toMatch(/\d+%/);
    expect(d.verdict).toMatch(/4 deaths/);
  });
});
