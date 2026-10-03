// zod schemas for API request bodies. The Observation schema mirrors the
// interface in src/shared/rig.ts so nothing malformed reaches the RIG brains.
import { z } from "zod";
import { ABILITIES, ACTIONS, CALL_KINDS, MODEL_FIELDS, RunEndSchema, SIDES, TEMPLATES, TRIGGERS } from "../src/shared/rig";

const side = z.enum(SIDES);
const n = z.number().finite();
const metric = <T extends z.ZodTypeAny>(v: T) => z.object({ v, c: n, n: n });
const templateName = z.enum(["CALIBRATION", ...TEMPLATES, "MODEL"]);
const abilityStat = z.object({ used: n, kills: n, evaded: n });
const abilityRecord = z.partialRecord(z.enum(ABILITIES), abilityStat);

export const PlayerModelSchema = z.object({
  laneBias: metric(z.object({ L: n, C: n, R: n })),
  wallPark: metric(z.object({ L: n, R: n, side: side.nullable() })),
  panicDirection: metric(z.object({ L: n, R: n, hold: n, side: side.nullable() })),
  reactionMs: metric(n.nullable()),
  style: metric(z.object({ label: z.enum(["cautious", "steady", "aggressive"]), climbRate: n, stationaryPct: n })),
  correctionRate: metric(n),
  motorShare: metric(z.object({ L: n, R: n })),
  exitApproach: metric(z.object({ side: side.nullable(), L: n, C: n, R: n })),
  abilityWeakness: metric(abilityRecord),
  adaptation: metric(z.object({ calledOut: z.enum(MODEL_FIELDS).nullable(), before: n.nullable(), after: n.nullable(), changed: z.boolean() })),
});

const short = (max: number) => z.string().max(max);

const LedgerEntrySchema = z.object({
  id: short(8),
  field: z.enum(MODEL_FIELDS),
  claim: short(200),
  confidence: n,
  supported: n,
  weakened: n,
  status: z.enum(["active", "abandoned"]),
  source: z.enum(["live", "local"]),
});

const MemorySummarySchema = z.object({
  runs: n,
  wins: n,
  bestTimeMs: n.nullable(),
  prior: z.object({
    laneBias: z.object({ L: n, C: n, R: n }).nullable(),
    panicSide: side.nullable(),
    wallParkSide: side.nullable(),
    reactionMs: n.nullable(),
    style: z.string().nullable(),
    bestAbility: z.enum(ABILITIES).nullable(),
    worstAbility: z.enum(ABILITIES).nullable(),
  }),
  notes: z.array(short(120)).max(6),
  lastSeenHoursAgo: n.nullable(),
});

export const ObservationSchema = z.object({
  epoch: short(64),
  trigger: z.enum(TRIGGERS),
  callsLeft: n,
  runClock: n,
  chamber: z.object({
    n: z.number().int().min(1).max(9),
    of: n,
    template: templateName,
    progress: n,
    exitSide: side,
    deathsHere: n,
    holes: z.array(z.object({ id: short(16), side, y: n })).max(40),
    remainingTemplates: z.array(z.enum(TEMPLATES)).max(5),
  }),
  ball: z.object({ lane: side, vxSign: z.union([z.literal(-1), z.literal(0), z.literal(1)]), stationaryMs: n }),
  pressure: z.object({
    budget: n,
    cooldowns: z.partialRecord(z.enum(ABILITIES), n),
    allowed: z.array(z.enum(ACTIONS)),
    deathStreak: n,
    note: short(160).nullable(),
  }),
  model: PlayerModelSchema,
  events: z.array(short(160)).max(16),
  lastOutcome: z
    .object({
      ability: z.enum(ACTIONS),
      side: side.nullable(),
      hypothesisId: short(8),
      prediction: short(160),
      verdict: z.enum(["SUPPORTED", "WEAKENED", "INCONCLUSIVE", "TRIVIAL"]),
      observed: short(160),
      killed: z.boolean(),
    })
    .nullable(),
  ledger: z.array(LedgerEntrySchema).max(9),
  memory: MemorySummarySchema.nullable(),
  variety: z.object({ abilityUses: z.partialRecord(z.enum(ACTIONS), n), recentTaunts: z.array(short(120)).max(12) }),
  wantNextChamber: z.boolean(),
});

export const DecideRequestSchema = z.object({
  runId: z.string().max(32).nullable(),
  kind: z.enum(CALL_KINDS),
  observation: ObservationSchema,
  extra: z.record(z.string(), z.unknown()).optional(),
});

export const SessionRequestSchema = z.object({ playerId: z.string().max(32).nullish() });
export const RunStartSchema = z.object({ playerId: z.string().min(1).max(32) });

export const RunEventsSchema = z.object({
  runId: z.string().min(1).max(32),
  events: z.array(z.object({ t: n, type: short(48), data: z.unknown().optional() })),
});

export const RunSummarySchema = z.object({
  result: z.enum(["escaped", "abandoned"]),
  durationMs: n,
  deaths: n,
  chambers: z.array(z.object({ template: templateName, deaths: n, timeMs: n })).max(10),
  model: PlayerModelSchema,
  restingSpots: z.array(n).max(64),
  ledger: z.array(LedgerEntrySchema).max(9),
  calls: z.object({ live: n, local: n }),
});

export const RunEndRequestSchema = z.object({
  runId: z.string().min(1).max(32),
  playerId: z.string().min(1).max(32),
  summary: RunSummarySchema,
  rigEnd: RunEndSchema.nullish(),
});
