// Shared contract between the game client, the server, the live Claude adapter
// and the deterministic local RIG. Everything RIG can *do* is enumerated here.
import { z } from "zod";

export const ABILITIES = ["SHIFT", "PULSE", "CRUSH", "MAGNET", "JAM"] as const;
export type Ability = (typeof ABILITIES)[number];
export const ACTIONS = [...ABILITIES, "WAIT"] as const;
export type ActionKind = (typeof ACTIONS)[number];

export const SIDES = ["L", "C", "R"] as const;
export type Side = (typeof SIDES)[number];
export type LR = "L" | "R";

export const TEMPLATES = ["FUNNEL", "SPLITTER", "EYE", "HOURGLASS", "TOWER"] as const;
export type MiddleTemplate = (typeof TEMPLATES)[number];
export type TemplateName = "CALIBRATION" | MiddleTemplate | "MODEL";

/** Player-model fields RIG may reason about. Each maps to a concrete metric. */
export const MODEL_FIELDS = [
  "laneBias",
  "wallPark",
  "panicDirection",
  "reactionMs",
  "style",
  "correctionRate",
  "motorShare",
  "exitApproach",
  "abilityWeakness",
  "adaptation",
] as const;
export type ModelField = (typeof MODEL_FIELDS)[number];

export const INTENTS = ["probe", "exploit", "bait", "hold", "relief"] as const;
export type Intent = (typeof INTENTS)[number];

export const PREDICTION_EVENTS = ["flee", "enter_lane", "avoid_lane", "react_within", "outcome", "stall"] as const;
export type PredictionEvent = (typeof PREDICTION_EVENTS)[number];

export const HYP_STATUS = ["new", "reinforce", "revise", "abandon"] as const;

export const CALL_KINDS = ["tactical", "final", "run_end"] as const;
export type CallKind = (typeof CALL_KINDS)[number];

export const TRIGGERS = [
  "chamber_start",
  "first_read",
  "confidence",
  "action_resolved",
  "contradiction",
  "death",
  "idle",
  "plan_next",
  "final_plan",
  "run_end",
] as const;
export type TriggerReason = (typeof TRIGGERS)[number];

// ---------------------------------------------------------------- decisions
const nullable = <T extends z.ZodTypeAny>(t: T) => t.nullable();

export const TacticalDecisionSchema = z.object({
  observation: z.string(),
  hypothesis: z.object({
    ref: z.string(), // "new" or an existing ledger id like "h2"
    status: z.enum(HYP_STATUS),
    field: z.enum(MODEL_FIELDS),
    claim: z.string(),
    confidence: z.number(),
  }),
  intent: z.enum(INTENTS),
  strategy: z.string(),
  action: z.object({
    ability: z.enum(ACTIONS),
    side: nullable(z.enum(SIDES)),
    intensity: z.number(),
    telegraphMs: z.number(),
    trigger: z.object({
      type: z.enum(["now", "ball_enters", "progress"]),
      lane: nullable(z.enum(SIDES)),
      progress: nullable(z.number()),
    }),
  }),
  prediction: nullable(
    z.object({
      event: z.enum(PREDICTION_EVENTS),
      side: nullable(z.enum(SIDES)),
      ms: nullable(z.number()),
      result: nullable(z.enum(["dies", "evades"])),
      windowMs: z.number(),
      pRig: z.number(),
      pBaseline: z.number(),
    }),
  ),
  taunt: z.string(),
  tauntRef: nullable(z.enum(MODEL_FIELDS)),
  nextChamber: nullable(
    z.object({
      template: z.enum(TEMPLATES),
      pressureSide: nullable(z.enum(["L", "R"])),
      density: z.number(),
      reason: z.string(),
    }),
  ),
});
export type TacticalDecision = z.infer<typeof TacticalDecisionSchema>;

export const FinalPlanSchema = z.object({
  observation: z.string(),
  claim: z.string(), // what RIG believes it has figured out
  targets: z.array(z.enum(MODEL_FIELDS)), // the 1-3 tendencies the room is built against
  trapSide: z.enum(["L", "R"]), // side made to look comfortable then punished
  exitSide: z.enum(["L", "C", "R"]),
  loadout: z.array(z.enum(ABILITIES)), // 1-2 abilities RIG keeps for this room
  useRestingSpots: z.boolean(), // punch holes where the player habitually rested
  revealLine: z.string(), // shown as the room is built (<= 10 words)
  taunt: z.string(),
});
export type FinalPlan = z.infer<typeof FinalPlanSchema>;

export const RunEndSchema = z.object({
  verdict: z.string(), // one line, <= 12 words
  memoryNotes: z.array(z.string()), // 1-3 durable notes for next run, <= 80 chars each
  taunt: z.string(), // closing line, <= 8 words
});
export type RunEnd = z.infer<typeof RunEndSchema>;

// -------------------------------------------------------------- observation
export interface Metric<T> {
  v: T;
  c: number; // confidence 0..1
  n: number; // samples (seconds or events)
}

export interface PlayerModelSnapshot {
  laneBias: Metric<{ L: number; C: number; R: number }>;
  wallPark: Metric<{ L: number; R: number; side: Side | null }>; // seconds parked on each wall
  panicDirection: Metric<{ L: number; R: number; hold: number; side: Side | null }>;
  reactionMs: Metric<number | null>;
  style: Metric<{ label: "cautious" | "steady" | "aggressive"; climbRate: number; stationaryPct: number }>;
  correctionRate: Metric<number>; // tilt reversals per 10 s
  motorShare: Metric<{ L: number; R: number }>;
  exitApproach: Metric<{ side: Side | null; L: number; C: number; R: number }>;
  abilityWeakness: Metric<Partial<Record<Ability, { used: number; kills: number; evaded: number }>>>;
  adaptation: Metric<{ calledOut: ModelField | null; before: number | null; after: number | null; changed: boolean }>;
}

export interface LedgerEntry {
  id: string; // h1..h9
  field: ModelField;
  claim: string;
  confidence: number;
  supported: number;
  weakened: number;
  status: "active" | "abandoned";
  source: RigSource;
}

export type Verdict = "SUPPORTED" | "WEAKENED" | "INCONCLUSIVE" | "TRIVIAL";

export interface DecisionOutcome {
  ability: ActionKind;
  side: Side | null;
  hypothesisId: string;
  prediction: string; // human readable e.g. "flee R within 1200ms"
  verdict: Verdict;
  observed: string; // human readable e.g. "fled L in 380ms"
  killed: boolean;
}

export interface Observation {
  epoch: string;
  trigger: TriggerReason;
  callsLeft: number;
  runClock: number; // seconds
  chamber: {
    n: number; // 1-based
    of: number;
    template: TemplateName;
    progress: number; // 0..1
    exitSide: Side;
    deathsHere: number;
    holes: { id: string; side: Side; y: number }[]; // y normalized 0..1
    remainingTemplates: MiddleTemplate[]; // what RIG may pick next
  };
  ball: { lane: Side; vxSign: -1 | 0 | 1; stationaryMs: number };
  pressure: {
    budget: number; // 0..1, director's allowance
    cooldowns: Partial<Record<Ability, number>>; // seconds remaining
    allowed: ActionKind[];
    deathStreak: number;
    note: string | null; // e.g. "calibration: one gentle probe allowed"
  };
  model: PlayerModelSnapshot;
  events: string[]; // ≤ 8 terse recent events, newest last
  lastOutcome: DecisionOutcome | null;
  ledger: LedgerEntry[]; // ≤ 5
  memory: MemorySummary | null;
  variety: { abilityUses: Partial<Record<ActionKind, number>>; recentTaunts: string[] };
  wantNextChamber: boolean;
}

export interface MemorySummary {
  runs: number;
  wins: number;
  bestTimeMs: number | null;
  prior: {
    laneBias: { L: number; C: number; R: number } | null;
    panicSide: Side | null;
    wallParkSide: Side | null;
    reactionMs: number | null;
    style: string | null;
    bestAbility: Ability | null; // ability with the highest kill rate against this player
    worstAbility: Ability | null; // ability the player handles best
  };
  notes: string[]; // RIG's own notes from previous runs (≤ 3 most recent)
  lastSeenHoursAgo: number | null;
}

export type RigSource = "live" | "local";

export interface DecideRequest {
  runId: string | null;
  kind: CallKind;
  observation: Observation;
  // for final/run_end
  extra?: Record<string, unknown>;
}

export interface DecideResponse<T = TacticalDecision | FinalPlan | RunEnd> {
  decision: T;
  source: RigSource;
  latencyMs: number;
  model: string | null;
  fallbackReason: string | null;
  repairs: string[]; // validator clamps applied (for Agent View)
}

// ---------------------------------------------------------------- persistence
export interface PersistedMemory {
  runs: number;
  wins: number;
  bestTimeMs: number | null;
  laneBias: { L: number; C: number; R: number } | null; // EMA over runs
  panic: { L: number; R: number; hold: number };
  wallPark: { L: number; R: number };
  reactionMs: number | null; // EMA
  style: string | null;
  abilityStats: Partial<Record<Ability, { used: number; kills: number; evaded: number }>>;
  restingSpots: number[]; // 12-bin histogram of normalized x where ball rested
  notes: string[];
  lastRunAt: string | null;
  deathsByTemplate: Partial<Record<TemplateName, number>>;
}

export interface RunSummary {
  result: "escaped" | "abandoned";
  durationMs: number;
  deaths: number;
  chambers: { template: TemplateName; deaths: number; timeMs: number }[];
  model: PlayerModelSnapshot;
  restingSpots: number[];
  ledger: LedgerEntry[];
  calls: { live: number; local: number };
}

export interface SessionResponse {
  playerId: string;
  rigMode: RigSource;
  model: string | null;
  memory: PersistedMemory;
  memorySummary: MemorySummary | null;
  storage: "sqlite" | "memory";
}

export const EMPTY_MEMORY: PersistedMemory = {
  runs: 0,
  wins: 0,
  bestTimeMs: null,
  laneBias: null,
  panic: { L: 0, R: 0, hold: 0 },
  wallPark: { L: 0, R: 0 },
  reactionMs: null,
  style: null,
  abilityStats: {},
  restingSpots: new Array(12).fill(0),
  notes: [],
  lastRunAt: null,
  deathsByTemplate: {},
};

/** Hard bounds the server clamps every decision into (fairness director adds context-aware rules). */
export const BOUNDS = {
  intensity: [1, 3] as const,
  telegraphMs: [700, 2200] as const,
  windowMs: [800, 6000] as const,
  confidence: [0.05, 0.95] as const,
  tauntWords: 9,
  claimChars: 90,
  observationChars: 120,
  strategyChars: 90,
};
