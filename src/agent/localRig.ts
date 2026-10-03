// Deterministic local RIG. Used when the live model is unavailable (server
// fallback) and by the client when the server is unreachable. It follows the
// same loop the prompt asks of Claude: observe -> hypothesize -> act ->
// predict -> update, and its output goes through the same validators.
import { hashString, makeRng } from "../engine/rng";
import type {
  Ability,
  FinalPlan,
  Intent,
  LedgerEntry,
  MiddleTemplate,
  ModelField,
  Observation,
  RunEnd,
  Side,
  TacticalDecision,
} from "../shared/rig";
import { SIDE_WORD, clamp, readModel, seededRng, type FieldRead } from "./modelRead";
import { groundedTaunt, isRecentTaunt } from "./taunts";
import { validateFinal, validateRunEnd, validateTactical, type Validated } from "./validate";

const PROBE_BELOW = 0.45;
const THIN_EVIDENCE = 0.12; // best score below this -> just watch
// Spatial habits are the most legible thing RIG can be right about; abstract ones rank lower.
const SALIENCE: Partial<Record<string, number>> = {
  wallPark: 1.35,
  laneBias: 1.2,
  panicDirection: 1.25,
  motorShare: 0.9,
  exitApproach: 0.3, // confounded: the director places exits on the weak side
  reactionMs: 0.8,
  style: 0.7,
  correctionRate: 0.55,
};
const opposite = (s: Side | null): Side => (s === "L" ? "R" : s === "R" ? "L" : "L");
const lr = (s: Side | null): "L" | "R" | null => (s === "L" || s === "R" ? s : null);
const pct = (r: FieldRead) => (r.pct != null ? `${r.pct}%` : "");

/** Ability options per tendency, in preference order, with side + trigger + prediction. */
interface Plan {
  ability: Ability;
  side: Side;
  trigger: TacticalDecision["action"]["trigger"];
  prediction: NonNullable<TacticalDecision["prediction"]>;
  telegraphMs?: number;
}

const NOW = { type: "now", lane: null, progress: null } as const;
const enters = (lane: Side) => ({ type: "ball_enters" as const, lane, progress: null });
const pred = (p: Partial<Plan["prediction"]> & Pick<Plan["prediction"], "event">): Plan["prediction"] => ({
  side: null,
  ms: null,
  result: null,
  windowMs: 3000,
  pRig: 0.55,
  pBaseline: 0.35,
  ...p,
});

function plansFor(r: FieldRead, obs: Observation, reads: FieldRead[]): Plan[] {
  const favored = reads.find((x) => x.field === "laneBias")?.side ?? null;
  const share = (r.pct ?? 50) / 100;
  switch (r.field) {
    case "laneBias": {
      const s = r.side ?? "R";
      const p = pred({ event: "enter_lane", side: s, windowMs: 4000, pRig: clamp(share + 0.1, 0.3, 0.9), pBaseline: 0.34 });
      return [
        { ability: "SHIFT", side: s, trigger: enters(s), prediction: p },
        { ability: "MAGNET", side: s, trigger: enters(s), prediction: p },
      ];
    }
    case "wallPark": {
      const s = r.side ?? "R";
      // a true wall-parker goes back to its wall once the pressure lifts
      const p = pred({ event: "enter_lane", side: s, pRig: clamp(0.35 + share * 0.35, 0.35, 0.85), pBaseline: 0.34, windowMs: 5500 });
      const trig = obs.ball.lane === s ? NOW : enters(s);
      return [
        { ability: "CRUSH", side: s, trigger: trig, prediction: p },
        { ability: "PULSE", side: opposite(s) === "C" ? "L" : opposite(s), trigger: trig, prediction: p },
      ];
    }
    case "panicDirection": {
      const s = r.side ?? "R";
      const p = pred({ event: "flee", side: s, windowMs: 1800, pRig: clamp(share, 0.4, 0.9), pBaseline: 0.5 });
      return [
        { ability: "PULSE", side: s, trigger: enters("C"), prediction: p },
        { ability: "MAGNET", side: s, trigger: NOW, prediction: p },
      ];
    }
    case "reactionMs": {
      const ms = r.value ?? 600;
      const s = favored ?? "R";
      const p = pred({ event: "react_within", ms: Math.round(ms * 1.1), windowMs: 2500, pRig: 0.6, pBaseline: 0.5 });
      return [
        { ability: "PULSE", side: s, trigger: NOW, prediction: p, telegraphMs: 700 },
        { ability: "JAM", side: lr(s) ?? "R", trigger: NOW, prediction: p, telegraphMs: 800 },
      ];
    }
    case "style": {
      if (r.label === "aggressive") {
        const s = reads.find((x) => x.field === "exitApproach")?.side ?? favored ?? "R";
        return [
          { ability: "MAGNET", side: s, trigger: NOW, prediction: pred({ event: "outcome", result: "dies", pRig: 0.3 + 0.3 * r.c, pBaseline: 0.2 }) },
          { ability: "SHIFT", side: s, trigger: enters(s), prediction: pred({ event: "enter_lane", side: s, pRig: 0.55, pBaseline: 0.34 }) },
        ];
      }
      const s = opposite(favored ?? obs.ball.lane);
      return [
        { ability: "PULSE", side: s, trigger: NOW, prediction: pred({ event: "stall", pRig: 0.5 + 0.2 * r.dev, pBaseline: 0.3 }) },
        { ability: "CRUSH", side: lr(favored) ?? "R", trigger: NOW, prediction: pred({ event: "stall", pRig: 0.55, pBaseline: 0.3 }) },
      ];
    }
    case "correctionRate": {
      const s = reads.find((x) => x.field === "exitApproach")?.side ?? favored ?? "R";
      const p = pred({ event: "outcome", result: "dies", pRig: clamp(0.25 + 0.4 * r.dev, 0.25, 0.7), pBaseline: 0.2 });
      return [
        { ability: "MAGNET", side: s, trigger: NOW, prediction: p },
        { ability: "SHIFT", side: s, trigger: enters(s), prediction: p },
      ];
    }
    case "motorShare": {
      const s = lr(r.side) ?? "R";
      const p = pred({ event: "stall", pRig: clamp(share, 0.4, 0.85), pBaseline: 0.3, windowMs: 2500 });
      return [
        { ability: "JAM", side: s, trigger: NOW, prediction: p },
        { ability: "PULSE", side: opposite(s), trigger: NOW, prediction: p },
      ];
    }
    case "exitApproach": {
      const s = r.side ?? "R";
      const progress = { type: "progress" as const, lane: null, progress: clamp(Math.max(obs.chamber.progress + 0.15, 0.6), 0, 0.95) };
      const p = pred({ event: "enter_lane", side: s, windowMs: 5000, pRig: clamp(share + 0.1, 0.35, 0.9), pBaseline: 0.34 });
      return [
        { ability: "SHIFT", side: s, trigger: progress, prediction: p },
        { ability: "MAGNET", side: s, trigger: progress, prediction: p },
      ];
    }
    case "abilityWeakness": {
      if (!r.ability) return [];
      const s = favored ?? "R";
      return [{ ability: r.ability, side: r.ability === "JAM" ? lr(s) ?? "R" : s, trigger: NOW, prediction: pred({ event: "outcome", result: "dies", pRig: clamp((r.pct ?? 30) / 100, 0.2, 0.8), pBaseline: 0.2 }) }];
    }
    default:
      return [];
  }
}

function claimFor(r: FieldRead): string {
  const dir = r.side ? SIDE_WORD[r.side] : "";
  switch (r.field) {
    case "laneBias": return `Favors the ${dir} lane (${pct(r)}).`;
    case "wallPark": return `Parks on the ${dir} wall (${pct(r)} of wall time).`;
    case "panicDirection": return r.side ? `Flees ${dir} when threatened (${pct(r)}).` : "Freezes when threatened.";
    case "reactionMs": return `Reacts slowly: about ${r.value}ms to a telegraph.`;
    case "style": return r.label === "aggressive" ? "Aggressive: climbs fast, corrects late." : `Cautious: still ${pct(r)} of the time.`;
    case "correctionRate": return `Rarely corrects: ${r.value} reversals per 10s.`;
    case "motorShare": return `Leans on the ${dir} motor (${pct(r)}).`;
    case "exitApproach": return `Approaches exits from the ${dir}.`;
    case "abilityWeakness": return `${r.ability ?? "Something"} kills this player (${pct(r)}).`;
    case "adaptation": return "Changes behavior after being called out.";
  }
}

function ledgerFor(obs: Observation, field: ModelField): LedgerEntry | undefined {
  return obs.ledger.find((e) => e.field === field && e.status === "active");
}

function hypothesisFor(obs: Observation, r: FieldRead): TacticalDecision["hypothesis"] {
  const entry = ledgerFor(obs, r.field);
  const last = obs.lastOutcome;
  let confidence = r.c * (0.5 + 0.5 * r.dev);
  let status: TacticalDecision["hypothesis"]["status"] = "new";
  if (entry) {
    confidence = 0.5 * confidence + 0.5 * entry.confidence + 0.05 * (entry.supported - entry.weakened);
    status = "reinforce";
    if (last?.hypothesisId === entry.id) {
      if (last.verdict === "SUPPORTED") confidence += 0.1;
      if (last.verdict === "WEAKENED") {
        confidence -= 0.15;
        status = "revise";
      }
    }
  }
  return { ref: entry?.id ?? "new", status, field: r.field, claim: claimFor(r), confidence: clamp(confidence, 0.05, 0.95) };
}

const describe = (r: FieldRead) =>
  `${r.field} ${r.label ?? r.side ?? r.ability ?? ""} ${pct(r) || (r.value ?? "")}`.replace(/\s+/g, " ").trim();

const HABIT: Record<ModelField, string> = {
  laneBias: "lane habit",
  wallPark: "wall parking",
  panicDirection: "panic reflex",
  reactionMs: "slow reactions",
  style: "play style",
  correctionRate: "late corrections",
  motorShare: "one-hand habit",
  exitApproach: "exit route",
  abilityWeakness: "known weakness",
  adaptation: "adaptation",
};

function observationLine(obs: Observation, r: FieldRead): string {
  const last = obs.lastOutcome ? ` Last: ${obs.lastOutcome.verdict} (${obs.lastOutcome.observed}).` : "";
  return `${describe(r)}, c${r.c.toFixed(2)} n${Math.round(r.n)}.${last}`;
}

function pickChamber(obs: Observation, reads: FieldRead[]): TacticalDecision["nextChamber"] {
  const remaining = obs.chamber.remainingTemplates;
  if (!obs.wantNextChamber || remaining.length === 0) return null;
  const by = (f: ModelField) => reads.find((r) => r.field === f)!;
  const corr = by("correctionRate");
  const wants: [MiddleTemplate, number, string][] = [
    ["SPLITTER", by("laneBias").score, "Two lanes. Make the lane choice visible."],
    ["FUNNEL", by("wallPark").score, "No walls worth resting on."],
    ["HOURGLASS", (corr.value ?? 0) > 6 ? corr.c * 0.6 : 0, "A pinch point punishes constant correction."],
    ["EYE", by("panicDirection").score, "Round room. Panic has nowhere to go."],
    ["TOWER", 0.05, "Tall and narrow. Watch the climb."],
  ];
  wants.sort((a, b) => b[1] - a[1]);
  const [template, , reason] = wants.find(([t]) => remaining.includes(t)) ?? [remaining[0], 0, "What is left."];
  const favored = lr(by("laneBias").side) ?? lr(by("wallPark").side);
  const density = obs.pressure.deathStreak >= 2 ? 1 : obs.chamber.n >= 3 ? 3 : 2;
  return { template, pressureSide: favored, density, reason };
}

function waitDecision(obs: Observation, r: FieldRead, intent: Intent, strategy: string, taunt: string, tauntRef: ModelField | null): TacticalDecision {
  return {
    observation: observationLine(obs, r),
    hypothesis: hypothesisFor(obs, r),
    intent,
    strategy,
    action: { ability: "WAIT", side: null, intensity: 1, telegraphMs: 1400, trigger: { ...NOW } },
    prediction: null,
    taunt,
    tauntRef,
    nextChamber: null,
  };
}

/** The local RIG's tactical brain. Pure and deterministic for a given observation. */
export function localTactical(obs: Observation): Validated<TacticalDecision> {
  return validateTactical(rawTactical(obs), obs);
}

function rawTactical(obs: Observation): TacticalDecision {
  const rng = seededRng(`${obs.epoch}|${obs.trigger}|${obs.callsLeft}`);
  const reads = readModel(obs.model);
  const last = obs.lastOutcome;
  const lastEntry = last ? obs.ledger.find((e) => e.id === last.hypothesisId) : undefined;
  const abandoned = new Set(obs.ledger.filter((e) => e.status === "abandoned").map((e) => e.field));
  const recent = (t: string) => isRecentTaunt(t, obs.variety.recentTaunts);
  let decision: TacticalDecision;

  // 1. A hypothesis that has now failed twice is dropped, out loud.
  if (last?.verdict === "WEAKENED" && lastEntry && lastEntry.status === "active" && lastEntry.weakened >= 2) {
    const r = reads.find((x) => x.field === lastEntry.field)!;
    decision = waitDecision(obs, r, "hold", "Drop it. Re-read before acting again.", recent("Oh. You can learn.") ? "Fine. Adjusting." : "Oh. You can learn.", "adaptation");
    decision.hypothesis = { ref: lastEntry.id, status: "abandon", field: lastEntry.field, claim: `Wrong about ${lastEntry.field}. Dropping it.`, confidence: 0.1 };
    decision.nextChamber = pickChamber(obs, reads);
    return decision;
  }

  // 2. Rank tendencies: confidence x deviation, minus abandoned ones and a variety
  //    penalty on whatever was just tested.
  const ranked = reads
    .filter((r) => !abandoned.has(r.field) && r.field !== "adaptation")
    .map((r) => {
      let s = r.score * (SALIENCE[r.field] ?? 1);
      if (lastEntry?.field === r.field) s *= last?.verdict === "SUPPORTED" ? 0.85 : 0.5;
      return { r, s: s + rng() * 1e-6 };
    })
    .sort((a, b) => b.s - a.s);
  const best = ranked[0]?.r ?? reads[0];

  // 3. Mercy and patience.
  if (obs.pressure.deathStreak >= 3) {
    decision = waitDecision(obs, best, "relief", "Back off. A broken subject teaches nothing.", recent("Breathe. I can wait.") ? "Take your time." : "Breathe. I can wait.", null);
  } else if (obs.trigger === "death" && rng() < 0.5) {
    decision = waitDecision(obs, best, "hold", "Let the death sink in. Watch the restart.", groundedTaunt(obs, null, rng()), null);
    if (!recent("Again?")) decision.taunt = "Again?";
  } else if (best.score < THIN_EVIDENCE || best.c < 0.2) {
    const memTaunt = obs.memory && obs.memory.runs > 0 && !recent("I remember you.") ? "I remember you." : groundedTaunt(obs, null, rng());
    decision = waitDecision(obs, best, "hold", "Evidence is thin. Watch before touching anything.", memTaunt, null);
  } else {
    decision = actOn(obs, ranked.map((x) => x.r), rng) ?? waitDecision(obs, best, "hold", "Nothing legal fits the read. Watch.", groundedTaunt(obs, best.field, rng()), best.field);
  }
  decision.nextChamber = pickChamber(obs, reads);
  return decision;
}

/** Choose the strongest tendency that has a legal, not-yet-failed ability. */
function actOn(obs: Observation, ranked: FieldRead[], rng: () => number): TacticalDecision | null {
  const last = obs.lastOutcome;
  const legal = (a: Ability) => obs.pressure.allowed.includes(a) && !(obs.pressure.cooldowns[a] ?? 0);
  for (const r of ranked.slice(0, 4)) {
    if (r.score < THIN_EVIDENCE) break;
    const hyp = hypothesisFor(obs, r);
    const failedHere = hyp.status === "revise" && last ? last.ability : null; // never repeat what just failed
    const uses = (a: Ability) => obs.variety.abilityUses[a] ?? 0;
    const options = plansFor(r, obs, ranked).filter((p) => legal(p.ability) && p.ability !== failedHere);
    if (!options.length) continue;
    // prefer variety: take the alternative if the first choice is clearly overused
    const plan = options.length > 1 && uses(options[0].ability) >= uses(options[1].ability) + 2 ? options[1] : options[0];
    const probing = hyp.confidence < PROBE_BELOW || obs.chamber.n === 1 || hyp.status === "revise";
    const intensity = probing ? 1 : hyp.confidence > 0.75 && obs.pressure.budget > 0.6 ? 3 : 2;
    const telegraphMs = plan.telegraphMs ?? (probing ? 1800 : intensity === 3 ? 1000 : 1300);
    const dir = SIDE_WORD[plan.side];
    return {
      observation: observationLine(obs, r),
      hypothesis: hyp,
      intent: probing ? "probe" : "exploit",
      strategy: probing ? `Probe ${r.field} with a gentle ${plan.ability}; see if it holds.` : `${plan.trigger.type === "now" ? "Fire" : "Pre-arm"} ${plan.ability} ${dir}; punish the ${HABIT[r.field]}.`,
      action: { ability: plan.ability, side: plan.side, intensity, telegraphMs, trigger: plan.trigger },
      prediction: plan.prediction,
      taunt: groundedTaunt(obs, r.field, rng()),
      tauntRef: r.field,
      nextChamber: null,
    };
  }
  return null;
}

// ----------------------------------------------------------------- final plan
const FIELD_ABILITY: Partial<Record<ModelField, Ability>> = {
  laneBias: "SHIFT",
  wallPark: "CRUSH",
  panicDirection: "PULSE",
  correctionRate: "MAGNET",
  motorShare: "JAM",
  exitApproach: "SHIFT",
  reactionMs: "PULSE",
};

export function localFinalPlan(obs: Observation): Validated<FinalPlan> {
  const reads = readModel(obs.model)
    .filter((r) => r.field !== "adaptation")
    .sort((a, b) => b.score - a.score);
  const strong = reads.filter((r) => r.score >= THIN_EVIDENCE).slice(0, 3);
  const targets = (strong.length ? strong : reads.slice(0, 1)).map((r) => r.field);
  const sided = strong.find((r) => lr(r.side));
  const trapSide = lr(sided?.side ?? null) ?? lr(obs.memory?.prior.wallParkSide ?? null) ?? "R";
  const loadout = [...new Set(targets.map((f) => (f === "abilityWeakness" ? reads.find((r) => r.field === f)?.ability : FIELD_ABILITY[f])).filter((a): a is Ability => !!a))].slice(0, 2);
  const wall = reads.find((r) => r.field === "wallPark")!;
  const style = reads.find((r) => r.field === "style")!;
  const top = strong[0] ?? reads[0];
  const raw: FinalPlan = {
    observation: `Strongest: ${targets.join(", ")}. ${top ? claimFor(top) : ""}`,
    claim: top ? claimFor(top) : "Nothing stands out. That is a pattern too.",
    targets,
    trapSide,
    exitSide: opposite(trapSide),
    loadout: loadout.length ? loadout : ["SHIFT"],
    useRestingSpots: wall.score > 0.2 || (style.label === "cautious" && style.c > 0.3),
    revealLine: `This room is built from you.`,
    taunt: groundedTaunt(obs, top?.field ?? null, 0),
  };
  return validateFinal(raw, obs);
}

// -------------------------------------------------------------------- run end
export function localRunEnd(obs: Observation, extra?: Record<string, unknown>): Validated<RunEnd> {
  const reads = readModel(obs.model)
    .filter((r) => r.score >= THIN_EVIDENCE && r.field !== "adaptation" && r.field !== "exitApproach")
    .sort((a, b) => b.score - a.score);
  const notes = reads.slice(0, 3).map((r) => claimFor(r));
  const n = (k: string) => (typeof extra?.[k] === "number" ? (extra[k] as number) : 0);
  const right = n("predictionsRight");
  const wrong = n("predictionsWrong");
  const kills = n("abilityKills");
  const deaths = n("deaths");
  const escaped = extra?.result !== "abandoned";
  const rng = makeRng(hashString(`${obs.epoch}|${right}|${wrong}|${deaths}`));
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  // the verdict is built from the real scorecard, never a boast it didn't earn
  const verdict =
    right + wrong === 0
      ? "You gave me nothing to test. Clever, or lucky."
      : right > wrong
        ? `${right} of ${right + wrong} calls correct. You are readable.`
        : obs.model.adaptation.v.changed
          ? `${right} of ${right + wrong} calls correct. You changed. Annoying.`
          : `${right} of ${right + wrong} calls correct. Lucky, or learning.`;
  if (kills === 0 && deaths === 0) notes.push("Single traps never landed. Stack them.");
  const priorWrong =
    obs.memory?.prior.wallParkSide && obs.model.wallPark.v.side && obs.memory.prior.wallParkSide !== obs.model.wallPark.v.side;
  if (priorWrong) notes.unshift(`Memory was wrong: wall moved to ${obs.model.wallPark.v.side === "L" ? "left" : "right"}.`);
  const raw: RunEnd = {
    verdict: escaped ? verdict : `${deaths} deaths. ${verdict}`,
    memoryNotes: notes.length ? notes.slice(0, 3) : ["Too little data. Watch longer next time."],
    taunt: escaped
      ? pick(["Next time, I start ahead.", "Enjoy it. I kept the data.", "Again. I want more of you.", "That room was a draft."])
      : pick(["I will remember this.", "Come back. I'm not done."]),
  };
  return validateRunEnd(raw, obs);
}
