import { describe, expect, it } from "vitest";
import { isStale, RigOutputError, validateFinal, validateRunEnd, validateTactical } from "../src/agent/validate";
import { makeDecision, makeObservation, PROFILES } from "./fixtures";

const hugger = () => makeObservation({ model: PROFILES.RIGHT_HUGGER });

describe("validateTactical", () => {
  it("passes a clean decision untouched", () => {
    const { decision, repairs } = validateTactical(makeDecision(), hugger());
    expect(repairs).toEqual([]);
    expect(decision.action.ability).toBe("SHIFT");
  });

  it("clamps numbers into BOUNDS", () => {
    const raw = makeDecision({
      hypothesis: { confidence: 1.7 },
      action: { intensity: 7.4, telegraphMs: 50 },
      prediction: { event: "enter_lane", side: "R", ms: null, result: null, windowMs: 99999, pRig: 3, pBaseline: -1 },
    });
    const { decision, repairs } = validateTactical(raw, hugger());
    expect(decision.hypothesis.confidence).toBe(0.95);
    expect(decision.action.intensity).toBe(3);
    expect(decision.action.telegraphMs).toBe(700);
    expect(decision.prediction!.windowMs).toBe(6000);
    expect(decision.prediction!.pRig).toBe(0.99);
    expect(decision.prediction!.pBaseline).toBe(0.01);
    expect(repairs.length).toBeGreaterThan(3);
  });

  it("truncates long text", () => {
    const raw = makeDecision({ hypothesis: { claim: "x".repeat(200) }, observation: "y".repeat(300), strategy: "z".repeat(150) });
    const { decision } = validateTactical(raw, hugger());
    expect(decision.hypothesis.claim.length).toBeLessThanOrEqual(90);
    expect(decision.observation.length).toBeLessThanOrEqual(120);
    expect(decision.strategy.length).toBeLessThanOrEqual(90);
  });

  it("turns a disallowed or cooling ability into WAIT", () => {
    const obs = makeObservation({ model: PROFILES.RIGHT_HUGGER, pressure: { allowed: ["PULSE", "WAIT"] } });
    const r1 = validateTactical(makeDecision(), obs);
    expect(r1.decision.action.ability).toBe("WAIT");
    expect(r1.decision.action.side).toBeNull();
    expect(r1.decision.intent).toBe("hold");
    expect(r1.repairs.join()).toMatch(/SHIFT not allowed/);

    const cooling = makeObservation({ model: PROFILES.RIGHT_HUGGER, pressure: { cooldowns: { SHIFT: 3 } } });
    expect(validateTactical(makeDecision(), cooling).decision.action.ability).toBe("WAIT");
  });

  it("fills missing side and fixes JAM side", () => {
    const r1 = validateTactical(makeDecision({ action: { side: null } }), hugger());
    expect(r1.decision.action.side).toBe("R");
    const r2 = validateTactical(makeDecision({ action: { ability: "JAM", side: "C", trigger: { type: "now", lane: null, progress: null } } }), hugger());
    expect(["L", "R"]).toContain(r2.decision.action.side);
  });

  it("normalizes inconsistent triggers", () => {
    const noLane = validateTactical(makeDecision({ action: { trigger: { type: "ball_enters", lane: null, progress: 0.5 } } }), hugger());
    expect(noLane.decision.action.trigger).toEqual({ type: "now", lane: null, progress: null });
    const past = validateTactical(makeDecision({ action: { trigger: { type: "progress", lane: "L", progress: 0.1 } } }), hugger());
    expect(past.decision.action.trigger.lane).toBeNull();
    expect(past.decision.action.trigger.progress).toBeCloseTo(0.35);
  });

  it("nulls malformed predictions", () => {
    const noSide = validateTactical(makeDecision({ prediction: { event: "flee", side: null } }), hugger());
    expect(noSide.decision.prediction).toBeNull();
    const noMs = validateTactical(makeDecision({ prediction: { event: "react_within", side: null, ms: null } }), hugger());
    expect(noMs.decision.prediction).toBeNull();
    const noResult = validateTactical(makeDecision({ prediction: { event: "outcome", side: null, result: null } }), hugger());
    expect(noResult.decision.prediction).toBeNull();
  });

  it("downgrades low-confidence exploits to probes", () => {
    const { decision } = validateTactical(makeDecision({ hypothesis: { confidence: 0.3 }, action: { intensity: 3 } }), hugger());
    expect(decision.intent).toBe("probe");
    expect(decision.action.intensity).toBe(1);
  });

  it("keeps calibration gentle", () => {
    const obs = makeObservation({ model: PROFILES.RIGHT_HUGGER, chamber: { n: 1, template: "CALIBRATION" } });
    const { decision } = validateTactical(makeDecision({ action: { intensity: 3 } }), obs);
    expect(decision.action.intensity).toBe(1);
    expect(decision.intent).toBe("probe");
  });

  it("resets unknown hypothesis refs", () => {
    const { decision } = validateTactical(makeDecision({ hypothesis: { ref: "h7", status: "reinforce" } }), hugger());
    expect(decision.hypothesis.ref).toBe("new");
    expect(decision.hypothesis.status).toBe("new");
  });

  it("enforces nextChamber rules", () => {
    const nc = { template: "FUNNEL" as const, pressureSide: "R" as const, density: 9, reason: "walls" };
    expect(validateTactical(makeDecision({ nextChamber: nc }), hugger()).decision.nextChamber).toBeNull();
    const want = makeObservation({ model: PROFILES.RIGHT_HUGGER, wantNextChamber: true });
    const fixed = validateTactical(makeDecision({ nextChamber: nc }), want).decision.nextChamber!;
    expect(fixed.template).toBe("SPLITTER");
    expect(fixed.density).toBe(3);
    expect(validateTactical(makeDecision(), want).decision.nextChamber?.template).toBe("SPLITTER");
  });

  it("cleans taunts: words, exclamations, profanity, repeats", () => {
    const long = validateTactical(makeDecision({ taunt: "one two three four five six seven eight nine ten" }), hugger());
    expect(long.decision.taunt.split(" ").length).toBeLessThanOrEqual(8);
    expect(validateTactical(makeDecision({ taunt: "Gotcha!" }), hugger()).decision.taunt).toBe("Gotcha.");
    expect(validateTactical(makeDecision({ taunt: "You shitty player" }), hugger()).decision.taunt).toBe("Noted.");
    const obs = makeObservation({ model: PROFILES.RIGHT_HUGGER, variety: { recentTaunts: ["Right lane again."] } });
    const rep = validateTactical(makeDecision(), obs);
    expect(rep.decision.taunt).not.toBe("Right lane again.");
    expect(rep.repairs.join()).toMatch(/repeated/);
  });

  it("replaces taunts that contradict the referenced metric", () => {
    const { decision, repairs } = validateTactical(makeDecision({ taunt: "You love the left." }), hugger());
    expect(decision.taunt).not.toMatch(/left/i);
    expect(decision.taunt).toMatch(/right/i); // grounded replacement from the real data
    expect(repairs.join()).toMatch(/contradicts laneBias/);
  });

  it("throws RigOutputError on schema mismatch", () => {
    expect(() => validateTactical({ nope: true }, hugger())).toThrow(RigOutputError);
    expect(() => validateTactical({ ...makeDecision(), action: { ...makeDecision().action, ability: "LASER" } }, hugger())).toThrow(RigOutputError);
  });
});

describe("isStale", () => {
  it("rejects decisions from an earlier chamber/life", () => {
    expect(isStale("c2.l1", "c2.l1")).toBe(false);
    expect(isStale("c2.l1", "c2.l2")).toBe(true);
    expect(isStale("c2.l1", "c3.l1")).toBe(true);
  });
});

describe("validateFinal / validateRunEnd", () => {
  it("caps final plan lists and reveal line", () => {
    const { decision } = validateFinal(
      {
        observation: "o",
        claim: "c",
        targets: ["laneBias", "laneBias", "wallPark", "style", "motorShare"],
        trapSide: "R",
        exitSide: "L",
        loadout: ["SHIFT", "CRUSH", "PULSE"],
        useRestingSpots: true,
        revealLine: "one two three four five six seven eight nine ten eleven twelve",
        taunt: "Built for you.",
      },
      hugger(),
    );
    expect(decision.targets).toEqual(["laneBias", "wallPark", "style"]);
    expect(decision.loadout).toEqual(["SHIFT", "CRUSH"]);
    expect(decision.revealLine.split(" ").length).toBeLessThanOrEqual(10);
  });

  it("caps run-end notes", () => {
    const { decision } = validateRunEnd(
      { verdict: "Predictable.", memoryNotes: ["a".repeat(120), "b", "c", "d"], taunt: "Bye." },
      hugger(),
    );
    expect(decision.memoryNotes).toHaveLength(3);
    expect(decision.memoryNotes[0].length).toBeLessThanOrEqual(80);
  });
});
