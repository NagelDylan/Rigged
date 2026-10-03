// Pure decision validators shared by server and client. They make any
// schema-valid model output safe and coherent against the observation it
// answered, recording every repair so the Agent View can show what was clamped.
import {
  ABILITIES,
  BOUNDS,
  FinalPlanSchema,
  RunEndSchema,
  TacticalDecisionSchema,
  type Ability,
  type FinalPlan,
  type ModelField,
  type Observation,
  type RunEnd,
  type Side,
  type TacticalDecision,
} from "../shared/rig";
import { clamp, dominantSide, num, readModel } from "./modelRead";
import { groundedTaunt, isRecentTaunt } from "./taunts";

export interface Validated<T> {
  decision: T;
  repairs: string[];
}

/** Thrown when raw output does not even match the schema (caller falls back). */
export class RigOutputError extends Error {}

export const TAUNT_MAX_WORDS = 8;
const LOW_CONFIDENCE = 0.45;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A decision is stale if the chamber/life changed since it was requested. */
export const isStale = (epochAtRequest: string, currentEpoch: string) => epochAtRequest !== currentEpoch;

// --------------------------------------------------------------- text helpers
const PROFANITY = ["fuck", "shit", "bitch", "cunt", "dick", "bastard", "asshole", "piss", "slut", "whore", "retard", "fag"];
export const hasProfanity = (s: string) => {
  const t = s.toLowerCase();
  return PROFANITY.some((w) => new RegExp(`\\b${w}`).test(t));
};

function truncChars(s: string, max: number, label: string, repairs: string[]): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  repairs.push(`${label} truncated to ${max} chars`);
  return t.slice(0, max - 1).trimEnd() + "…";
}

function truncWords(s: string, max: number, label: string, repairs: string[]): string {
  const words = String(s ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= max) return words.join(" ");
  repairs.push(`${label} cut to ${max} words`);
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "") + ".";
}

/** Generic terse-line cleanup: words cap, no "!", no profanity. */
function cleanLine(s: string, maxWords: number, label: string, repairs: string[]): string {
  let t = truncWords(s, maxWords, label, repairs);
  if (t.includes("!")) {
    t = t.replace(/!+/g, ".");
    repairs.push(`${label}: exclamation removed`);
  }
  if (hasProfanity(t)) {
    repairs.push(`${label}: profanity replaced`);
    return "Noted.";
  }
  return t;
}

const DIR_WORDS: [RegExp, Side][] = [
  [/\bleft\b/i, "L"],
  [/\bright\b/i, "R"],
];

/** Taunt rules: ≤8 words, clean, not a repeat, and directionally true to tauntRef. */
function validateTaunt(raw: string, ref: ModelField | null, obs: Observation, repairs: string[]): string {
  let t = cleanLine(raw, TAUNT_MAX_WORDS, "taunt", repairs);
  if (t === "") return t;
  const mentioned = DIR_WORDS.filter(([re]) => re.test(t)).map(([, s]) => s);
  if (mentioned.length) {
    // A taunt may mention several sides ("Right lane, exit left"); it is only a lie when
    // none of the sides it names is supported by the data it cites (or, uncited, by any directional read).
    const truth = ref ? dominantSide(obs.model, ref) : null;
    const supported = truth
      ? [truth]
      : (["laneBias", "wallPark", "panicDirection", "exitApproach"] as ModelField[])
          .map((f) => dominantSide(obs.model, f))
          .concat([obs.chamber.exitSide, obs.ball.lane]);
    if (!mentioned.some((s) => supported.includes(s))) {
      repairs.push(`taunt contradicts ${ref ?? "model"} (${truth ?? "no side"}); replaced`);
      return groundedTaunt(obs, ref, 0);
    }
  }
  if (isRecentTaunt(t, obs.variety?.recentTaunts ?? [])) {
    repairs.push("taunt repeated; replaced");
    return groundedTaunt(obs, ref, 0.5);
  }
  return t;
}

/** The side the model believes in most strongly (for abilities missing a side). */
function strongestSide(obs: Observation, prefer: ModelField | null): Side {
  if (prefer) {
    const s = dominantSide(obs.model, prefer);
    if (s) return s;
  }
  const best = readModel(obs.model)
    .filter((r) => r.side)
    .sort((a, b) => b.score - a.score)[0];
  return best?.side ?? "R";
}

function parseOrThrow<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new RigOutputError(`${what} schema: ${first ? `${first.path.join(".")} ${first.message}` : "invalid"}`);
  }
  return r.data;
}

// ------------------------------------------------------------------- tactical
export function validateTactical(raw: unknown, obs: Observation): Validated<TacticalDecision> {
  const d = structuredClone(parseOrThrow<TacticalDecision>(TacticalDecisionSchema, raw, "tactical"));
  const repairs: string[] = [];
  const calibration = obs.chamber.n === 1;

  d.observation = truncChars(d.observation, BOUNDS.observationChars, "observation", repairs);
  d.strategy = truncChars(d.strategy, BOUNDS.strategyChars, "strategy", repairs);

  // hypothesis
  const h = d.hypothesis;
  h.claim = truncChars(h.claim, BOUNDS.claimChars, "claim", repairs);
  const conf = round2(clamp(num(h.confidence, 0.3), ...BOUNDS.confidence));
  if (Math.abs(conf - h.confidence) > 0.006) repairs.push(`confidence clamped to ${conf}`);
  h.confidence = conf;
  if (h.ref !== "new" && !obs.ledger.some((e) => e.id === h.ref)) {
    repairs.push(`unknown hypothesis ref ${h.ref} -> new`);
    h.ref = "new";
  }
  if (h.ref === "new" && h.status !== "new") {
    repairs.push(`status ${h.status} on new hypothesis -> new`);
    h.status = "new";
  }

  // action legality
  const a = d.action;
  if (a.ability !== "WAIT") {
    const cd = num(obs.pressure.cooldowns?.[a.ability], 0);
    if (!obs.pressure.allowed.includes(a.ability) || cd > 0) {
      repairs.push(`${a.ability} not allowed${cd > 0 ? ` (cooldown ${cd}s)` : ""} -> WAIT`);
      a.ability = "WAIT";
    }
  }
  const intensity = clamp(Math.round(num(a.intensity, 1)), ...BOUNDS.intensity);
  if (intensity !== a.intensity) repairs.push(`intensity -> ${intensity}`);
  a.intensity = intensity;
  const tg = clamp(Math.round(num(a.telegraphMs, 1400)), ...BOUNDS.telegraphMs);
  if (tg !== a.telegraphMs) repairs.push(`telegraphMs -> ${tg}`);
  a.telegraphMs = tg;

  if (a.ability === "WAIT") {
    if (a.side !== null || a.trigger.type !== "now") repairs.push("WAIT normalized");
    a.side = null;
    a.trigger = { type: "now", lane: null, progress: null };
    if (d.intent === "exploit" || d.intent === "bait") {
      repairs.push(`intent ${d.intent} with WAIT -> hold`);
      d.intent = "hold";
    }
  } else {
    if (a.side === null) {
      a.side = strongestSide(obs, h.field);
      repairs.push(`missing side -> ${a.side}`);
    }
    if (a.ability === "JAM" && a.side === "C") {
      const m = dominantSide(obs.model, "motorShare");
      a.side = m === "L" ? "L" : "R";
      repairs.push(`JAM needs a motor -> ${a.side}`);
    }
    normalizeTrigger(d, obs, repairs);
  }

  // low-evidence exploitation and calibration are downgraded to a gentle probe
  if (d.intent === "exploit" && h.confidence < LOW_CONFIDENCE) {
    repairs.push(`exploit at confidence ${h.confidence} -> probe`);
    d.intent = "probe";
    a.intensity = 1;
  }
  const gentle = calibration || /calibration|struggling/.test(obs.pressure.note ?? "");
  if (gentle && a.ability !== "WAIT" && a.intensity > 1) {
    repairs.push(`${calibration ? "calibration" : "relief"}: intensity -> 1`);
    a.intensity = 1;
  }
  if (calibration && d.intent === "exploit") d.intent = "probe";

  d.prediction = validatePrediction(d.prediction, repairs);

  d.taunt = validateTaunt(d.taunt, d.tauntRef, obs, repairs);

  // next chamber only when asked, and only from the remaining set
  if (!obs.wantNextChamber || obs.chamber.remainingTemplates.length === 0) {
    if (d.nextChamber) repairs.push("nextChamber not requested -> null");
    d.nextChamber = null;
  } else {
    const remaining = obs.chamber.remainingTemplates;
    const nc = d.nextChamber ?? { template: remaining[0], pressureSide: null, density: 2, reason: "default pick" };
    if (!d.nextChamber) repairs.push(`nextChamber missing -> ${remaining[0]}`);
    if (!remaining.includes(nc.template)) {
      repairs.push(`template ${nc.template} unavailable -> ${remaining[0]}`);
      nc.template = remaining[0];
    }
    nc.density = clamp(Math.round(num(nc.density, 2)), 1, 3);
    nc.reason = truncChars(nc.reason, BOUNDS.strategyChars, "reason", repairs);
    d.nextChamber = nc;
  }
  return { decision: d, repairs };
}

function normalizeTrigger(d: TacticalDecision, obs: Observation, repairs: string[]) {
  const t = d.action.trigger;
  if (t.type === "now") {
    t.lane = null;
    t.progress = null;
  } else if (t.type === "ball_enters") {
    t.progress = null;
    if (!t.lane) {
      repairs.push("ball_enters without lane -> now");
      d.action.trigger = { type: "now", lane: null, progress: null };
    }
  } else {
    t.lane = null;
    if (t.progress == null || !Number.isFinite(t.progress)) {
      repairs.push("progress trigger without value -> now");
      d.action.trigger = { type: "now", lane: null, progress: null };
    } else {
      const p = clamp(t.progress, 0, 1);
      // A threshold already passed would fire instantly; arm it a little ahead.
      const fixed = p <= obs.chamber.progress ? clamp(obs.chamber.progress + 0.05, 0, 1) : p;
      if (fixed !== t.progress) repairs.push(`progress -> ${fixed.toFixed(2)}`);
      t.progress = fixed;
    }
  }
}

function validatePrediction(p: TacticalDecision["prediction"], repairs: string[]): TacticalDecision["prediction"] {
  if (!p) return null;
  const needsSide = p.event === "flee" || p.event === "enter_lane" || p.event === "avoid_lane";
  if ((needsSide && !p.side) || (p.event === "react_within" && p.ms == null) || (p.event === "outcome" && !p.result)) {
    repairs.push(`incoherent prediction (${p.event}) -> null`);
    return null;
  }
  const windowMs = clamp(Math.round(num(p.windowMs, 3000)), ...BOUNDS.windowMs);
  if (windowMs !== p.windowMs) repairs.push(`windowMs -> ${windowMs}`);
  return {
    event: p.event,
    side: needsSide ? p.side : null,
    ms: p.event === "react_within" ? clamp(Math.round(num(p.ms, 600)), 100, 5000) : null,
    result: p.event === "outcome" ? p.result : null,
    windowMs,
    pRig: round2(clamp(num(p.pRig, 0.5), 0.01, 0.99)),
    pBaseline: round2(clamp(num(p.pBaseline, 0.5), 0.01, 0.99)),
  };
}

// ---------------------------------------------------------------- final plan
export function validateFinal(raw: unknown, obs: Observation): Validated<FinalPlan> {
  const d = structuredClone(parseOrThrow<FinalPlan>(FinalPlanSchema, raw, "final"));
  const repairs: string[] = [];
  d.observation = truncChars(d.observation, BOUNDS.observationChars, "observation", repairs);
  d.claim = truncChars(d.claim, BOUNDS.claimChars, "claim", repairs);
  const targets = [...new Set(d.targets)].slice(0, 3);
  if (targets.length === 0) {
    const best = readModel(obs.model).sort((a, b) => b.score - a.score)[0];
    targets.push(best.field);
    repairs.push(`no targets -> ${best.field}`);
  }
  if (targets.length !== d.targets.length) repairs.push("targets deduped / capped at 3");
  d.targets = targets;
  const loadout = [...new Set(d.loadout)].filter((x): x is Ability => (ABILITIES as readonly string[]).includes(x)).slice(0, 2);
  if (loadout.length === 0) loadout.push("SHIFT");
  if (loadout.length !== d.loadout.length) repairs.push("loadout capped at 2");
  d.loadout = loadout;
  d.revealLine = cleanLine(d.revealLine, 10, "revealLine", repairs);
  d.taunt = validateTaunt(d.taunt, d.targets[0] ?? null, obs, repairs);
  return { decision: d, repairs };
}

// ------------------------------------------------------------------- run end
export function validateRunEnd(raw: unknown, obs: Observation): Validated<RunEnd> {
  const d = structuredClone(parseOrThrow<RunEnd>(RunEndSchema, raw, "run_end"));
  const repairs: string[] = [];
  d.verdict = cleanLine(d.verdict, 12, "verdict", repairs);
  const notes = d.memoryNotes
    .map((n) => truncChars(n, 80, "memory note", repairs))
    .filter((n) => n && !hasProfanity(n))
    .slice(0, 3);
  if (notes.length !== d.memoryNotes.length) repairs.push("memoryNotes capped at 3 clean notes");
  d.memoryNotes = notes;
  d.taunt = validateTaunt(d.taunt, null, obs, repairs);
  return { decision: d, repairs };
}
