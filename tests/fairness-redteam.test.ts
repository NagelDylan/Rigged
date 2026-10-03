// Red-team fairness invariants. Each test sets up a concrete situation in the
// real engine and checks a property a human player would call "fair".
// Invariants found broken were fixed in game code; all of these must hold.
import { describe, expect, test } from "vitest";
import { allowedActions, intensityCap, rule, newFairnessState, type FairnessContext } from "../src/agent/fairness";
import { buildChamber, captureRadius, isSolvable, type ChamberDef, type Hole } from "../src/engine/chambers";
import { BALL_R, HALF_W, HOLE_R, MIN_TELEGRAPH, PHYS } from "../src/engine/constants";
import { Game, MAGNET_K, type EffectOrder } from "../src/engine/game";
import { intervalsAt } from "../src/engine/geometry";
import type { TemplateName } from "../src/shared/rig";

/** Human budget: ~300 ms to see the telegraph + ~700 ms to understand it and start the right maneuver. */
const HUMAN_REACT_MS = 1000;
/** World units visible above the ball when the view is height-limited (renderer: viewH = 330, ball at 40%). */
const VISIBLE_ABOVE_BALL = 0.6 * 330;
const MIDDLE: TemplateName[] = ["FUNNEL", "SPLITTER", "EYE", "HOURGLASS", "TOWER"];

const hole = (id: string, x: number, y: number): Hole => ({ id, x, y, r: HOLE_R, baseX: x, baseY: y, kind: "hole", residue: 0 });

/** Open box (calibration walls, no holes except the given ones) with the ball resting on a level bar. */
function lab(holes: Hole[], ballX: number, barY = 200, vx = 0) {
  const def = buildChamber(0, "CALIBRATION", { pressureSide: null, density: 1, exitSide: "C", seed: 1 });
  def.holes = holes;
  const g = new Game(def);
  g.protectedUntil = 0;
  g.bar.yL = g.bar.yR = barY;
  g.ball.x = ballX;
  g.ball.y = barY + BALL_R;
  g.ball.vx = vx;
  return g;
}

const order = (ability: EffectOrder["ability"], side: "L" | "R", intensity: 1 | 2 | 3): EffectOrder => ({
  decisionId: "rt",
  ability,
  side,
  intensity,
  telegraphMs: 0, // engine raises it to MIN_TELEGRAPH
  trigger: { type: "now", lane: null, progress: null },
  expiresMs: 4000,
});

/** Run: no input until `reactMs` after the telegraph starts, then hold one key combo. Returns death info. */
function play(g: Game, o: EffectOrder | null, reactMs: number, dL: number, dR: number, seconds = 5) {
  if (o) g.enqueue(o);
  let t0: number | null = o ? null : 0;
  for (let i = 0; i < seconds / PHYS.dt; i++) {
    if (t0 === null && g.effects.some((e) => e.startedAt !== null)) t0 = g.clock;
    const act = t0 !== null && g.clock - t0 >= reactMs;
    g.setInput(act ? { lUp: dL > 0, lDown: dL < 0, rUp: dR > 0, rDown: dR < 0 } : { lUp: false, lDown: false, rUp: false, rDown: false });
    g.step();
    for (const e of g.drainEvents()) {
      if (e.type === "death") return { died: true, fired: t0 !== null, cause: e.cause, at: g.clock - (t0 ?? 0) };
    }
  }
  return { died: false, fired: t0 !== null, cause: null, at: -1 };
}

const COMBOS: [number, number][] = [];
for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) COMBOS.push([a, b]);
/** Some single held key combo, started HUMAN_REACT_MS after the telegraph, survives. */
const escapable = (mk: () => Game, o: () => EffectOrder) => COMBOS.some(([a, b]) => !play(mk(), o(), HUMAN_REACT_MS, a, b).died);

/** Flood fill like isSolvable but seeded at the ball (clearance 4 like SHIFT's own check). */
function reachableFrom(def: ChamberDef, holes: Hole[], bx: number, by: number, clearance = 4) {
  const CELL = 6;
  const cols = Math.ceil((HALF_W * 2) / CELL);
  const rows = Math.ceil(def.H / CELL);
  const ivRow: ReturnType<typeof intervalsAt>[] = [];
  for (let r = 0; r < rows; r++) ivRow.push(intervalsAt(def.outer, def.islands, r * CELL + CELL / 2));
  const free = (c: number, r: number) => {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
    const x = -HALF_W + c * CELL + CELL / 2;
    const y = r * CELL + CELL / 2;
    if (!ivRow[r].some((iv) => x - BALL_R >= iv.a - 0.01 && x + BALL_R <= iv.b + 0.01)) return false;
    return !holes.some((h) => Math.hypot(h.x - x, h.y - y) < captureRadius(h) + clearance);
  };
  const atExit = (c: number, r: number) =>
    Math.hypot(def.exit.x - (-HALF_W + c * CELL + CELL / 2), def.exit.y - (r * CELL + CELL / 2)) < captureRadius(def.exit);
  const c0 = Math.round((bx + HALF_W - CELL / 2) / CELL);
  const r0 = Math.round((by - CELL / 2) / CELL);
  const seen = new Uint8Array(cols * rows);
  const q: number[] = [];
  for (let d = 0; d < 4 && !q.length; d++)
    for (let dc = -d; dc <= d; dc++)
      for (let dr = -d; dr <= d; dr++)
        if (free(c0 + dc, r0 + dr) && !seen[(r0 + dr) * cols + c0 + dc]) {
          seen[(r0 + dr) * cols + c0 + dc] = 1;
          q.push((r0 + dr) * cols + c0 + dc);
        }
  while (q.length) {
    const i = q.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (atExit(c, r)) return true;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
      const j = rr * cols + cc;
      if (seen[j] || !(free(cc, rr) || atExit(cc, rr))) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return false;
}

function* builds(seeds = 6) {
  for (let seed = 1; seed <= seeds; seed++) {
    yield buildChamber(0, "CALIBRATION", { pressureSide: null, density: 2, exitSide: seed % 2 ? "L" : "R", seed });
    for (const t of MIDDLE)
      for (const density of [1, 2, 3] as const)
        for (const pressureSide of ["L", "R", null] as const)
          yield buildChamber(1 + (seed % 3), t, { pressureSide, density, exitSide: seed % 2 ? "L" : "R", seed });
    yield buildChamber(4, "MODEL", { pressureSide: "R", density: 2, exitSide: "L", seed }, {
      trapSide: seed % 2 ? "L" : "R",
      exitSide: seed % 2 ? "R" : "L",
      restingSpots: Array.from({ length: 12 }, (_, i) => ((seed * 7 + i * 3) % 5) + (i === seed % 12 ? 9 : 0)),
      useRestingSpots: true,
    });
  }
}

describe("geometry", () => {
  test("no hole near spawn; a passive ball survives the spawn-protection window", () => {
    for (const def of builds(4)) {
      for (const h of def.holes) expect(Math.hypot(h.x, h.y - (PHYS.barMinY + BALL_R))).toBeGreaterThan(130);
      const g = new Game(def);
      expect(play(g, null, 0, 0, 0, 2.5).died).toBe(false);
    }
  });

  test("every chamber has a route with >= 20u of hole clearance (not just a 1-cell thread)", () => {
    for (const def of builds(4)) expect(isSolvable(def, def.holes, 20), `${def.template} d${def.params.density} s${def.params.seed}`).toBe(true);
  });

  test("ball dropped onto the SPLITTER divider tip is pushed into a lane, never wedged", () => {
    const def = buildChamber(1, "SPLITTER", { pressureSide: null, density: 1, exitSide: "L", seed: 3 });
    def.holes = [];
    const tip = def.islands[0].points[0].y;
    for (const dy of [1, 8, 20, 33]) {
      for (const x of [-3, 0, 3]) {
        const g = new Game(def);
        g.protectedUntil = 0;
        g.bar.yL = g.bar.yR = tip + dy - BALL_R;
        g.ball.x = x;
        g.ball.y = tip + dy;
        play(g, null, 0, 1, 1, 0.6); // keep climbing through the wedge
        const ivs = g.intervals(g.ball.y);
        expect(ivs.some((iv) => g.ball.x - BALL_R >= iv.a - 0.5 && g.ball.x + BALL_R <= iv.b + 0.5)).toBe(true);
      }
    }
  });
});

describe("RIG abilities leave a human-sized escape window", () => {
  test("PULSE (any intensity, ball resting at any distance inside the leverage window) is escapable after a 1 s reaction", () => {
    for (const I of [1, 2, 3] as const)
      for (const dx of [26, 40, 80, 150, 185])
        expect(escapable(() => lab([hole("H", dx, 200 + BALL_R)], 0), () => order("PULSE", "R", I)), `i${I} dx${dx}`).toBe(true);
  });

  test("CRUSH against a wall-parked ball with a hole beside it is escapable after a 1 s reaction", () => {
    for (const I of [1, 2, 3] as const)
      for (const hx of [-222, -200, -185, -170, -150])
        expect(escapable(() => lab([hole("H", hx, 200 + BALL_R)], -275 + BALL_R), () => order("CRUSH", "L", I)), `i${I} hx${hx}`).toBe(true);
  });

  test("MAGNET at its minimum allowed distance is escapable after a 1 s reaction", () => {
    for (const I of [1, 2, 3] as const)
      for (const d of [70, 85, 110])
        expect(escapable(() => lab([hole("H", d, 200 + BALL_R)], 0), () => order("MAGNET", "R", I)), `i${I} d${d}`).toBe(true);
  });

  test("MAGNET + lip pull stays below 90% of the strongest counter-tilt (otherwise the lip becomes a one-way door)", () => {
    // engine constants (game.ts): MAGNET_K, reach 230; lip pull at the capture edge = PHYS.lipPull
    const lipOuter = PHYS.lipBand + BALL_R * 0.5;
    const magnetAtLip = MAGNET_K[2] * (1 - (captureRadius({ r: HOLE_R }) + lipOuter) / 230);
    const counter = PHYS.gravity * (PHYS.maxDiff / (HALF_W * 2));
    expect(magnetAtLip + PHYS.lipPull).toBeLessThan(0.9 * counter);
  });

  test("telegraph floors exceed the human reaction budget", () => {
    for (const ms of Object.values(MIN_TELEGRAPH)) expect(ms).toBeGreaterThanOrEqual(900);
  });
});

describe("SHIFT", () => {
  // Sample ball positions across chambers; SHIFT every side.
  function shifts() {
    const out: { def: ChamberDef; x: number; y: number; to: { x: number; y: number }; holeId: string }[] = [];
    for (const t of ["FUNNEL", "SPLITTER", "HOURGLASS", "TOWER"] as const)
      for (const seed of [2, 5])
        for (const side of ["L", "R", "C"] as const)
          for (let by = 80; by < 800; by += 90)
            for (const u of [-0.6, 0, 0.6]) {
              const def = buildChamber(1, t, { pressureSide: "R", density: 3, exitSide: "L", seed });
              const ivs = intervalsAt(def.outer, def.islands, by);
              if (!ivs.length) continue;
              const iv = u < 0 ? ivs[0] : ivs[ivs.length - 1];
              const x = iv.a + BALL_R + ((u + 1) / 2) * (iv.b - iv.a - 2 * BALL_R);
              if (def.holes.some((h) => Math.hypot(h.x - x, h.y - by) < captureRadius(h) + 20)) continue;
              if (!reachableFrom(def, def.holes, x, by)) continue;
              const g = new Game(def);
              g.protectedUntil = 0;
              g.bar.yL = g.bar.yR = by - BALL_R;
              g.ball.x = x;
              g.ball.y = by;
              g.enqueue(order("SHIFT", side === "C" ? "L" : side, 3));
              g.step();
              const e = g.effects[0];
              if (e?.phase === "telegraph" && e.to && e.holeId) out.push({ def, x, y: by, to: e.to, holeId: e.holeId });
            }
    return out;
  }
  const sample = shifts();

  test("SHIFT never cuts the ball off from the exit", () => {
    expect(sample.length).toBeGreaterThan(50);
    for (const s of sample) {
      const moved = s.def.holes.map((h) => (h.id === s.holeId ? { ...h, x: s.to.x } : h));
      expect(reachableFrom(s.def, moved, s.x, s.y), `${s.def.template} ball(${s.x.toFixed(0)},${s.y})`).toBe(true);
    }
  });

  // KNOWN ISSUE: SHIFT may pick holes up to 380u above the ball, but a height-limited view
  // shows only ~198u above it (≈33% of SHIFTs in sampling). The telegraph (bracket + ghost)
  // is then off-screen and there is no edge indicator. Fix: limit to h.y < ball.y + 190
  // in resolveTargets, or add an off-screen arrow.
  test("SHIFT target hole is on-screen when the telegraph starts", () => {
    for (const s of sample) expect(s.to.y - s.y).toBeLessThanOrEqual(VISIBLE_ABOVE_BALL);
  });
});

describe("kill credit / committed ball", () => {
  // KNOWN ISSUE: a telegraph may start while the ball is already rolling into a hole
  // (death ~250 ms later, before the effect has done anything and before a human
  // could even perceive it). Game.die() credits the kill to the effect, the eye
  // goes "smug", and RIG's abilityWeakness model learns from a kill it didn't make.
  // Fix: in startTelegraph skip/hold when the ball's passive time-to-capture < ~700 ms,
  // and in die() only credit effects whose active phase has begun (or ended < 1.5 s ago).
  test("CRUSH is not credited with a death that happens before it acts (ball already committed)", () => {
    const g = lab([hole("H", 30, 200 + BALL_R)], 0, 200, 60); // dies ~250 ms later with no RIG at all
    const r = play(g, order("CRUSH", "L", 1), 1e9, 0, 0);
    expect(r.died).toBe(true);
    expect(r.cause).toBeNull();
  });

  test("PULSE leverage does not fire into a ball that is already committed to a hole", () => {
    const g = lab([hole("H", 40, 200 + BALL_R)], 0, 200, 60); // passive death ~600 ms later
    const r = play(g, order("PULSE", "R", 1), 1e9, 0, 0);
    expect(r.died).toBe(true);
    expect(r.cause).toBeNull();
  });
});

describe("director relief", () => {
  const ctx = (o: Partial<FairnessContext>): FairnessContext => ({
    chamber: 2,
    isFinal: false,
    clock: 100000,
    deathsHere: 0,
    lastDeathAt: null,
    cleanChambers: 0,
    progress: 0.3,
    reactionMs: null,
    protectedUntil: 0,
    ...o,
  });

  test("a death streak forces WAIT, caps intensity and lengthens telegraphs", () => {
    const st = newFairnessState();
    expect(allowedActions(ctx({ deathsHere: 5, lastDeathAt: 95000 }), st)).toEqual(["WAIT"]);
    expect(intensityCap(ctx({ deathsHere: 3 }))).toBe(1);
    const r = rule(
      {
        action: { ability: "PULSE", side: "L", intensity: 3, telegraphMs: 500, trigger: { type: "now", lane: null, progress: null } },
      } as never,
      "d1",
      ctx({ deathsHere: 3 }),
      st,
    );
    expect(r.ok && r.order.intensity).toBe(1);
    expect(r.ok && r.order.telegraphMs).toBeGreaterThanOrEqual(MIN_TELEGRAPH.PULSE + 400);
  });
});
