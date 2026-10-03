// The Fairness Director. RIG (LLM or local) proposes; this deterministic layer
// disposes. It owns cooldowns, pressure budget, relief after repeated deaths,
// escalation when the player dominates, repetition limits and telegraph floors.
import type { Ability, ActionKind, Observation, Side, TacticalDecision } from "../shared/rig";
import { ABILITIES } from "../shared/rig";
import { MIN_TELEGRAPH } from "../engine/constants";
import type { EffectOrder } from "../engine/game";

export interface FairnessContext {
  chamber: number; // 0-based
  isFinal: boolean;
  clock: number; // run ms
  deathsHere: number;
  lastDeathAt: number | null;
  cleanChambers: number; // consecutive previous chambers with 0 deaths
  progress: number;
  reactionMs: number | null;
  protectedUntil: number;
}

export interface FairnessState {
  lastUse: Partial<Record<Ability, number>>; // run ms
  lastStart: number; // run ms of last accepted attack
  history: { ability: Ability; side: Side }[];
  calibrationProbes: number;
  jamThisChamber: number;
}

export const newFairnessState = (): FairnessState => ({
  lastUse: {},
  lastStart: -1e9,
  history: [],
  calibrationProbes: 0,
  jamThisChamber: 0,
});

const ABILITY_COOLDOWN_MS = 9000;

export function globalGapMs(ctx: FairnessContext) {
  let gap = ctx.chamber <= 1 ? 5000 : ctx.isFinal ? 3200 : 4000;
  if (ctx.deathsHere >= 3) gap += 3000;
  if (ctx.cleanChambers >= 2) gap -= 800;
  return gap;
}

export function intensityCap(ctx: FairnessContext): 1 | 2 | 3 {
  if (ctx.chamber === 0) return 1;
  if (ctx.deathsHere >= 3) return 1;
  if (ctx.deathsHere >= 2) return 2;
  if (ctx.cleanChambers >= 2 || ctx.isFinal) return 3;
  return 2;
}

/** Relief mode: after many deaths RIG must hold fire for a while. */
export function inRelief(ctx: FairnessContext) {
  return ctx.deathsHere >= 5 && ctx.lastDeathAt !== null && ctx.clock - ctx.lastDeathAt < 12000;
}

export function allowedActions(ctx: FairnessContext, st: FairnessState): ActionKind[] {
  if (inRelief(ctx)) return ["WAIT"];
  if (ctx.chamber === 0) return st.calibrationProbes >= 1 ? ["WAIT"] : ["CRUSH", "PULSE", "WAIT"];
  const out: ActionKind[] = [];
  for (const a of ABILITIES) {
    if (a === "JAM" && (ctx.chamber < 3 || st.jamThisChamber >= 1)) continue;
    out.push(a);
  }
  out.push("WAIT");
  return out;
}

export function cooldowns(ctx: FairnessContext, st: FairnessState): Partial<Record<Ability, number>> {
  const out: Partial<Record<Ability, number>> = {};
  for (const a of ABILITIES) {
    const last = st.lastUse[a];
    if (last === undefined) continue;
    const left = ABILITY_COOLDOWN_MS - (ctx.clock - last);
    if (left > 0) out[a] = Math.round(left / 100) / 10;
  }
  return out;
}

export function pressureFor(ctx: FairnessContext, st: FairnessState): Observation["pressure"] {
  const gapLeft = Math.max(0, globalGapMs(ctx) - (ctx.clock - st.lastStart));
  const budget = inRelief(ctx) ? 0 : Math.max(0, Math.min(1, 1 - gapLeft / globalGapMs(ctx))) * (intensityCap(ctx) / 3);
  let note: string | null = null;
  if (ctx.chamber === 0)
    note =
      st.calibrationProbes >= 1
        ? "calibration: probe used; watch"
        : "calibration: one gentle probe allowed (intensity 1); use it to test your first read";
  else if (inRelief(ctx)) note = "relief: player struggling, director forces WAIT";
  else if (ctx.deathsHere >= 3) note = "player struggling: intensity capped at 1";
  else if (ctx.cleanChambers >= 2) note = "player dominating: full intensity allowed";
  return {
    budget: Math.round(budget * 100) / 100,
    cooldowns: cooldowns(ctx, st),
    allowed: allowedActions(ctx, st),
    deathStreak: ctx.deathsHere,
    note,
  };
}

export type Ruling =
  | { ok: true; order: EffectOrder; notes: string[] }
  | { ok: false; reason: string; notes: string[] };

/** Turn a validated decision into an executable order, or veto it. */
export function rule(d: TacticalDecision, decisionId: string, ctx: FairnessContext, st: FairnessState): Ruling {
  const notes: string[] = [];
  const a = d.action.ability;
  if (a === "WAIT") return { ok: false, reason: "RIG chose to wait", notes };
  const allowed = allowedActions(ctx, st);
  if (!allowed.includes(a)) return { ok: false, reason: `${a} not allowed now`, notes };
  const cd = cooldowns(ctx, st)[a];
  if (cd !== undefined) return { ok: false, reason: `${a} cooling down (${cd}s)`, notes };
  const recent = st.history.slice(-3);
  if (recent.length === 3 && recent.every((h) => h.ability === a && h.side === d.action.side)) {
    return { ok: false, reason: "repetition: 4th identical attack vetoed", notes };
  }

  let intensity = Math.round(d.action.intensity) as 1 | 2 | 3;
  const cap = intensityCap(ctx);
  if (intensity > cap) {
    notes.push(`intensity ${intensity}→${cap}`);
    intensity = cap;
  }
  intensity = Math.max(1, intensity) as 1 | 2 | 3;

  let floor: number = MIN_TELEGRAPH[a];
  if (ctx.deathsHere >= 2) floor += 250;
  if (ctx.deathsHere >= 3) floor += 150;
  if ((ctx.reactionMs ?? 0) > 650) floor += 250;
  let telegraphMs = Math.round(d.action.telegraphMs);
  if (telegraphMs < floor) {
    notes.push(`telegraph ${telegraphMs}→${floor}ms`);
    telegraphMs = floor;
  }
  telegraphMs = Math.min(2200, telegraphMs);

  let side: Side = d.action.side ?? "C";
  if (a === "JAM" && side === "C") side = "R";

  const trig = d.action.trigger;
  const order: EffectOrder = {
    decisionId,
    ability: a,
    side,
    intensity,
    telegraphMs,
    trigger: {
      type: trig.type,
      lane: trig.type === "ball_enters" ? (trig.lane ?? side) : null,
      progress: trig.type === "progress" ? Math.max(ctx.progress + 0.05, Math.min(0.92, trig.progress ?? 0.5)) : null,
    },
    expiresMs: trig.type === "now" ? 4000 : 11000,
  };
  // the global gap applies at telegraph time too: delay "now" orders by arming them briefly
  return { ok: true, order, notes };
}

/** Bookkeeping once the engine actually starts the telegraph. */
export function recordStart(st: FairnessState, ability: Ability, side: Side, clock: number, chamber: number) {
  st.lastUse[ability] = clock;
  st.lastStart = clock;
  st.history.push({ ability, side });
  if (st.history.length > 12) st.history.shift();
  if (chamber === 0) st.calibrationProbes++;
  if (ability === "JAM") st.jamThisChamber++;
}

export function gapReady(ctx: FairnessContext, st: FairnessState) {
  return ctx.clock - st.lastStart >= globalGapMs(ctx) && ctx.clock >= ctx.protectedUntil;
}
