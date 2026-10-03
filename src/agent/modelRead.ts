// Pure helpers that turn the raw PlayerModelSnapshot into comparable "reads":
// how far each tendency deviates from neutral, which side it points to, and
// how much RIG should care (confidence x deviation). Shared by the local RIG,
// the validator (taunt grounding) and the server (memory summaries).
import type { Ability, ModelField, PlayerModelSnapshot, Side } from "../shared/rig";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const SIDE_WORD: Record<Side, string> = { L: "left", C: "center", R: "right" };

/** Key with the largest value; null when everything is zero / empty. */
export function argmax<K extends string>(o: Partial<Record<K, number>>, keys: readonly K[]): K | null {
  let best: K | null = null;
  let bv = 0;
  for (const k of keys) {
    const v = num(o[k], 0);
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

export interface FieldRead {
  field: ModelField;
  dev: number; // 0..1 deviation from a neutral player
  c: number; // metric confidence
  n: number;
  score: number; // c * dev — "how exploitable / interesting"
  side: Side | null; // the direction the tendency points to
  pct: number | null; // share of the dominant side, 0..100
  value: number | null; // scalar metric (ms, rate) when relevant
  ability?: Ability; // abilityWeakness: the ability that works best
  label?: string; // style label
}

const share = (max: number, total: number) => (total > 0 ? max / total : 0);

/** Dominant direction of a field, or null if the field has no direction / no data. */
export function dominantSide(model: PlayerModelSnapshot, field: ModelField): Side | null {
  switch (field) {
    case "laneBias": {
      // after a detected switch, the recent window is the truth
      const lb = model.laneBias.v;
      return argmax(lb.changed && lb.recent ? lb.recent : lb, ["L", "C", "R"] as const);
    }
    case "wallPark":
      return model.wallPark.v.side ?? argmax(model.wallPark.v, ["L", "R"] as const);
    case "panicDirection": {
      const p = model.panicDirection.v;
      if (p.side) return p.side;
      return num(p.hold, 0) > Math.max(num(p.L, 0), num(p.R, 0)) ? null : argmax(p, ["L", "R"] as const);
    }
    case "motorShare":
      return argmax(model.motorShare.v, ["L", "R"] as const);
    case "exitApproach":
      return model.exitApproach.v.side ?? argmax(model.exitApproach.v, ["L", "C", "R"] as const);
    default:
      return null;
  }
}

function read(field: ModelField, m: { c: number; n: number }, dev: number, extra: Partial<FieldRead> = {}): FieldRead {
  const c = clamp(num(m.c, 0), 0, 1);
  const d = clamp(num(dev, 0), 0, 1);
  return { field, dev: d, c, n: num(m.n, 0), score: c * d, side: null, pct: null, value: null, ...extra };
}

/** One read per model field, unsorted. Never throws on odd input. */
export function readModel(model: PlayerModelSnapshot): FieldRead[] {
  const out: FieldRead[] = [];
  const lb = model.laneBias.v.changed && model.laneBias.v.recent ? model.laneBias.v.recent : model.laneBias.v;
  {
    const tot = num(lb.L, 0) + num(lb.C, 0) + num(lb.R, 0);
    const side = dominantSide(model, "laneBias");
    const s = side ? share(num(lb[side], 0), tot) : 0;
    out.push(read("laneBias", model.laneBias, (s - 1 / 3) / (2 / 3), { side, pct: Math.round(s * 100) }));
  }
  {
    const w = model.wallPark.v;
    const tot = num(w.L, 0) + num(w.R, 0);
    const side = dominantSide(model, "wallPark");
    const s = side && side !== "C" ? share(num(w[side], 0), tot) : 0;
    out.push(read("wallPark", model.wallPark, Math.min(1, tot / 10) * s, { side, pct: Math.round(s * 100), value: tot }));
  }
  {
    const p = model.panicDirection.v;
    const tot = num(p.L, 0) + num(p.R, 0) + num(p.hold, 0);
    const side = dominantSide(model, "panicDirection");
    const s = side && side !== "C" ? share(num(p[side], 0), tot) : 0;
    out.push(read("panicDirection", model.panicDirection, (s - 1 / 3) / (2 / 3), { side, pct: Math.round(s * 100), value: tot }));
  }
  {
    const ms = model.reactionMs.v;
    out.push(read("reactionMs", model.reactionMs, ms == null ? 0 : (ms - 300) / 500, { value: ms == null ? null : Math.round(ms) }));
  }
  {
    const st = model.style.v;
    const still = num(st.stationaryPct, 0) > 1 ? num(st.stationaryPct, 0) / 100 : num(st.stationaryPct, 0);
    const dev = st.label === "aggressive" ? 0.7 : st.label === "cautious" ? 0.35 + 0.5 * still : 0.1;
    out.push(read("style", model.style, dev, { label: st.label, pct: Math.round(still * 100), value: num(st.climbRate, 0) }));
  }
  {
    const r = num(model.correctionRate.v, 4);
    // Low correction = commits to a tilt and doesn't fix it -> MAGNET bait.
    out.push(read("correctionRate", model.correctionRate, (4 - r) / 4, { value: Math.round(r * 10) / 10 }));
  }
  {
    const ms = model.motorShare.v;
    const tot = num(ms.L, 0) + num(ms.R, 0);
    const side = dominantSide(model, "motorShare");
    const s = side && side !== "C" ? share(num(ms[side], 0), tot) : 0;
    out.push(read("motorShare", model.motorShare, Math.abs(num(ms.L, 0) - num(ms.R, 0)) / (tot || 1), { side, pct: Math.round(s * 100) }));
  }
  {
    const e = model.exitApproach.v;
    const tot = num(e.L, 0) + num(e.C, 0) + num(e.R, 0);
    const side = dominantSide(model, "exitApproach");
    const s = side ? share(num(e[side], 0), tot) : 0;
    out.push(read("exitApproach", model.exitApproach, side ? (s - 1 / 3) / (2 / 3) : 0, { side, pct: Math.round(s * 100) }));
  }
  {
    let best: Ability | undefined;
    let rate = 0;
    for (const [ab, st] of Object.entries(model.abilityWeakness.v ?? {}) as [Ability, { used: number; kills: number }][]) {
      const used = num(st?.used, 0);
      if (used < 2) continue;
      const r = num(st.kills, 0) / used;
      if (r > rate) {
        rate = r;
        best = ab;
      }
    }
    out.push(read("abilityWeakness", model.abilityWeakness, rate, { ability: best, pct: Math.round(rate * 100) }));
  }
  {
    const a = model.adaptation.v;
    out.push(read("adaptation", model.adaptation, a.changed ? 0.6 : 0));
  }
  return out;
}

/** Tiny deterministic string hash (FNV-1a) + mulberry32 RNG for tie-breaks. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seededRng(seed: string): () => number {
  let a = hashString(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
