// RIG's terse, data-grounded taunt bank. Every template that names a direction
// or number fills it from the live model, so a taunt is always checkable.
import type { ModelField, Observation } from "../shared/rig";
import { SIDE_WORD, readModel, type FieldRead } from "./modelRead";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Tpl = (r: FieldRead) => string | null;

const BANK: Partial<Record<ModelField, Tpl[]>> = {
  laneBias: [
    (r) => (r.side && r.pct ? `${cap(SIDE_WORD[r.side])} lane. ${r.pct}% of the time.` : null),
    (r) => (r.side ? `You live on the ${SIDE_WORD[r.side]}.` : null),
  ],
  wallPark: [
    (r) => (r.side && r.side !== "C" && r.pct ? `${cap(SIDE_WORD[r.side])} wall. ${r.pct}% of the time.` : null),
    (r) => (r.side && r.side !== "C" ? `You lean on the ${SIDE_WORD[r.side]} wall.` : null),
  ],
  panicDirection: [
    (r) => (r.side ? `You flee ${SIDE_WORD[r.side]}. Every time.` : null),
    (r) => (r.side && r.pct ? `Panic goes ${SIDE_WORD[r.side]}. ${r.pct}% of it.` : null),
  ],
  reactionMs: [
    (r) => (r.value ? `${r.value} milliseconds. Slow.` : null),
    (r) => (r.value ? `${r.value} ms. I counted.` : null),
  ],
  style: [
    (r) => (r.label === "cautious" && r.pct ? `Cautious. Still ${r.pct}% of the time.` : null),
    (r) => (r.label === "aggressive" ? "Fast hands. Careless ones." : null),
    (r) => (r.label === "steady" ? "Steady. For now." : null),
  ],
  correctionRate: [
    (r) => (r.value != null ? `${r.value} corrections per ten seconds.` : null),
    (r) => (r.value != null && r.value < 3 ? "You never correct. Noted." : null),
  ],
  motorShare: [(r) => (r.side && r.side !== "C" && r.pct ? `Your ${SIDE_WORD[r.side]} hand does ${r.pct}%.` : null)],
  exitApproach: [(r) => (r.side ? `You always come from the ${SIDE_WORD[r.side]}.` : null)],
  abilityWeakness: [(r) => (r.ability ? `${r.ability} works on you.` : null)],
  adaptation: [() => "Oh. You can learn.", () => "You did not change."],
};

export const GENERIC_TAUNTS = ["Noted.", "Predictable.", "Again?", "Still watching.", "Interesting."];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9% ]/g, "").trim();

export function isRecentTaunt(taunt: string, recent: string[]): boolean {
  const t = norm(taunt);
  return t.length > 0 && recent.some((r) => norm(r) === t);
}

/**
 * A taunt grounded in `field`'s current numbers, avoiding recent taunts.
 * Falls back to a generic line. `pick` (0..1) rotates deterministically.
 */
export function groundedTaunt(obs: Observation, field: ModelField | null, pick = 0): string {
  const recent = obs.variety?.recentTaunts ?? [];
  const candidates: string[] = [];
  if (field) {
    const r = readModel(obs.model).find((x) => x.field === field);
    for (const tpl of BANK[field] ?? []) {
      const s = r ? tpl(r) : null;
      if (s) candidates.push(s);
    }
  }
  const pool = [...rotate(candidates, pick), ...rotate(GENERIC_TAUNTS, pick)];
  return pool.find((s) => !isRecentTaunt(s, recent)) ?? "";
}

function rotate<T>(arr: T[], pick: number): T[] {
  if (arr.length < 2) return arr;
  const k = Math.floor(pick * arr.length) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}
