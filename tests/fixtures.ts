// Shared test fixtures: a full, valid Observation with a neutral player model,
// deep-mergeable overrides, and a handful of simulated player profiles.
import type { Observation, PlayerModelSnapshot, TacticalDecision } from "../src/shared/rig";

type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function deepMerge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!isPlain(over) || !isPlain(base)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v as never) : v;
  }
  return out as T;
}

export function neutralModel(): PlayerModelSnapshot {
  return {
    laneBias: { v: { L: 0.33, C: 0.34, R: 0.33 }, c: 0.2, n: 5 },
    wallPark: { v: { L: 0, R: 0, side: null }, c: 0.1, n: 0 },
    panicDirection: { v: { L: 0, R: 0, hold: 0, side: null }, c: 0, n: 0 },
    reactionMs: { v: null, c: 0, n: 0 },
    style: { v: { label: "steady", climbRate: 0.5, stationaryPct: 0.2 }, c: 0.2, n: 5 },
    correctionRate: { v: 4, c: 0.2, n: 5 },
    motorShare: { v: { L: 0.5, R: 0.5 }, c: 0.2, n: 5 },
    exitApproach: { v: { side: null, L: 0, C: 0, R: 0 }, c: 0, n: 0 },
    abilityWeakness: { v: {}, c: 0, n: 0 },
    adaptation: { v: { calledOut: null, before: null, after: null, changed: false }, c: 0, n: 0 },
  };
}

export function makeObservation(overrides: DeepPartial<Observation> = {}): Observation {
  const base: Observation = {
    epoch: "c2.l1",
    trigger: "confidence",
    callsLeft: 20,
    runClock: 42,
    chamber: {
      n: 2,
      of: 5,
      template: "FUNNEL",
      progress: 0.3,
      exitSide: "C",
      deathsHere: 0,
      holes: [
        { id: "h1", side: "L", y: 0.4 },
        { id: "h2", side: "R", y: 0.55 },
      ],
      remainingTemplates: ["SPLITTER", "EYE", "HOURGLASS", "TOWER"],
    },
    ball: { lane: "C", vxSign: 0, stationaryMs: 0 },
    pressure: {
      budget: 0.8,
      cooldowns: {},
      allowed: ["SHIFT", "PULSE", "CRUSH", "MAGNET", "JAM", "WAIT"],
      deathStreak: 0,
      note: null,
    },
    model: neutralModel(),
    events: ["chamber 2 start"],
    lastOutcome: null,
    ledger: [],
    memory: null,
    variety: { abilityUses: {}, recentTaunts: [] },
    wantNextChamber: false,
  };
  return deepMerge(base, overrides);
}

/** Simulated players, expressed as model overrides. */
export const PROFILES = {
  RIGHT_HUGGER: {
    laneBias: { v: { L: 0.08, C: 0.17, R: 0.75 }, c: 0.8, n: 40 },
    wallPark: { v: { L: 0.5, R: 11, side: "R" }, c: 0.7, n: 12 },
  },
  LEFT_HUGGER: {
    laneBias: { v: { L: 0.72, C: 0.2, R: 0.08 }, c: 0.8, n: 40 },
    wallPark: { v: { L: 12, R: 1, side: "L" }, c: 0.75, n: 13 },
  },
  CAUTIOUS: {
    style: { v: { label: "cautious", climbRate: 0.2, stationaryPct: 0.62 }, c: 0.8, n: 40 },
    panicDirection: { v: { L: 1, R: 0, hold: 5, side: null }, c: 0.5, n: 6 },
  },
  AGGRESSIVE: {
    style: { v: { label: "aggressive", climbRate: 1.6, stationaryPct: 0.03 }, c: 0.8, n: 40 },
    correctionRate: { v: 1.2, c: 0.75, n: 30 },
    exitApproach: { v: { side: "L", L: 4, C: 1, R: 0 }, c: 0.5, n: 5 },
  },
  ADAPTER: {
    panicDirection: { v: { L: 1, R: 5, hold: 0, side: "R" }, c: 0.7, n: 6 },
    laneBias: { v: { L: 0.2, C: 0.2, R: 0.6 }, c: 0.6, n: 30 },
  },
} satisfies Record<string, DeepPartial<PlayerModelSnapshot>>;

/** A schema-valid tactical decision to mutate in validator tests. */
export function makeDecision(overrides: DeepPartial<TacticalDecision> = {}): TacticalDecision {
  const base: TacticalDecision = {
    observation: "Right lane 75% over 40s.",
    hypothesis: { ref: "new", status: "new", field: "laneBias", claim: "Favors the right lane.", confidence: 0.7 },
    intent: "exploit",
    strategy: "Pre-arm SHIFT right.",
    action: { ability: "SHIFT", side: "R", intensity: 2, telegraphMs: 1200, trigger: { type: "ball_enters", lane: "R", progress: null } },
    prediction: { event: "enter_lane", side: "R", ms: null, result: null, windowMs: 4000, pRig: 0.8, pBaseline: 0.34 },
    taunt: "Right lane again.",
    tauntRef: "laneBias",
    nextChamber: null,
  };
  return deepMerge(base, overrides);
}
