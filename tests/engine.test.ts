import { describe, expect, it } from "vitest";
import { buildChamber, isSolvable, laneOf } from "../src/engine/chambers";
import { BALL_R, PHYS, TIMING } from "../src/engine/constants";
import { Game, type EffectOrder, type Input } from "../src/engine/game";
import { PlayerModel } from "../src/engine/playerModel";

const calib = (seed = 1) => buildChamber(0, "CALIBRATION", { pressureSide: null, density: 1, exitSide: "C", seed });
const hold = (game: Game, input: Partial<Input>, seconds: number, model?: PlayerModel) => {
  const i: Input = { lUp: false, lDown: false, rUp: false, rDown: false, ...input };
  for (let t = 0; t < seconds; t += PHYS.dt) {
    game.setInput(i);
    game.step();
    if (model && game.phase === "playing") model.sample(game, PHYS.dt);
    for (const e of game.drainEvents()) model?.onEvent(e, game);
  }
};
const order = (o: Partial<EffectOrder>): EffectOrder => ({
  decisionId: "t",
  ability: "CRUSH",
  side: "R",
  intensity: 2,
  telegraphMs: 1000,
  trigger: { type: "now", lane: null, progress: null },
  expiresMs: 9000,
  ...o,
});

describe("bar + ball physics", () => {
  it("level bar keeps a resting ball still (deadzone)", () => {
    const g = new Game(calib());
    hold(g, {}, 2);
    expect(Math.abs(g.ball.x)).toBeLessThan(0.5);
    expect(g.ball.vx).toBe(0);
  });

  it("ball rolls toward the lower end", () => {
    const g = new Game(calib());
    hold(g, { rUp: true }, 0.8); // right end up → ball rolls left
    expect(g.ball.x).toBeLessThan(-5);
    const g2 = new Game(calib());
    hold(g2, { lUp: true }, 0.8);
    expect(g2.ball.x).toBeGreaterThan(5);
  });

  it("motors never exceed the max tilt difference", () => {
    const g = new Game(calib());
    hold(g, { rUp: true, lDown: true }, 4);
    expect(Math.abs(g.bar.yR - g.bar.yL)).toBeLessThanOrEqual(PHYS.maxDiff + 1e-6);
  });

  it("ball stays inside the walls", () => {
    const g = new Game(calib());
    hold(g, { lUp: true }, 3);
    const ivs = g.intervals(g.ball.y);
    expect(ivs.some((iv) => g.ball.x - BALL_R >= iv.a - 0.01 && g.ball.x + BALL_R <= iv.b + 0.01)).toBe(true);
  });

  it("is deterministic for identical input", () => {
    const run = () => {
      const g = new Game(calib(7));
      hold(g, { lUp: true, rUp: true }, 1);
      hold(g, { lUp: true }, 0.7);
      hold(g, { rUp: true }, 1.3);
      return [g.ball.x, g.ball.y, g.bar.yL, g.bar.yR];
    };
    expect(run()).toEqual(run());
  });
});

describe("holes, death and checkpoints", () => {
  it("dropping onto a hole kills and resets to the chamber start quickly", () => {
    const def = calib();
    const h = def.holes[0];
    const g = new Game(def);
    // teleport the ball just under the hole and raise the bar into it
    g.bar.yL = g.bar.yR = h.y - BALL_R - 6;
    g.ball.x = h.x;
    hold(g, { lUp: true, rUp: true }, 0.3);
    expect(["dying", "resetting"]).toContain(g.phase);
    expect(g.totalDeaths).toBe(1);
    hold(g, {}, (TIMING.deathFallMs + TIMING.deathHoldMs + TIMING.resetMs) / 1000 + 0.05);
    expect(g.phase).toBe("playing");
    expect(g.bar.yL).toBe(PHYS.barMinY);
    expect(g.ball.x).toBe(0);
    expect(g.chamber.index).toBe(0); // checkpoint = current chamber
  });

  it("reaching the exit advances to the next chamber", () => {
    const def = calib();
    const g = new Game(def);
    const next = buildChamber(1, "FUNNEL", { pressureSide: null, density: 1, exitSide: "C", seed: 2 });
    g.nextChamber = () => next;
    g.bar.yL = g.bar.yR = def.exit.y - BALL_R - 4;
    g.ball.x = def.exit.x;
    hold(g, { lUp: true, rUp: true }, 0.2);
    expect(g.phase).toBe("checkpoint");
    hold(g, {}, (TIMING.checkpointHoldMs + TIMING.transitionMs) / 1000 + 0.1);
    expect(g.chamber.template).toBe("FUNNEL");
    expect(g.phase).toBe("playing");
  });
});

describe("RIG effects execute deterministically and fairly", () => {
  it("respects spawn protection, then telegraphs before acting", () => {
    const g = new Game(calib());
    g.enqueue(order({}));
    hold(g, {}, 1);
    expect(g.effects[0].phase).toBe("armed"); // still protected
    hold(g, {}, TIMING.spawnProtectMs / 1000);
    expect(["telegraph", "active", "release"]).toContain(g.effects[0].phase);
  });

  it("PULSE shoves the ball in the chosen direction", () => {
    const g = new Game(calib());
    g.protectedUntil = 0;
    g.enqueue(order({ ability: "PULSE", side: "R" }));
    hold(g, {}, 4.6); // ≤ 3 s leverage wait + telegraph + shove
    expect(g.ball.x).toBeGreaterThan(20);
  });

  it("PULSE holds for leverage: fires early when a hole lies in its direction", () => {
    const def = calib();
    const h = def.holes[0];
    const g = new Game(def);
    g.protectedUntil = 0;
    g.bar.yL = g.bar.yR = h.y - 80;
    g.ball.x = h.x - 90; // hole up and to the right
    const e = g.enqueue(order({ ability: "PULSE", side: "R" }));
    hold(g, {}, 0.05);
    expect(e.phase).toBe("telegraph");
    const g2 = new Game(calib());
    g2.protectedUntil = 0;
    const e2 = g2.enqueue(order({ ability: "PULSE", side: "R" }));
    hold(g2, {}, 1);
    expect(e2.phase).toBe("armed"); // nothing to push the ball into yet
  });

  it("telegraph is never shorter than the ability floor", () => {
    const g = new Game(calib());
    g.protectedUntil = 0;
    const e = g.enqueue(order({ telegraphMs: 10 }));
    hold(g, {}, 0.05);
    expect(e.order.telegraphMs).toBeGreaterThanOrEqual(950);
  });

  it("ball_enters trigger waits for the lane", () => {
    const g = new Game(calib());
    g.protectedUntil = 0;
    const e = g.enqueue(order({ trigger: { type: "ball_enters", lane: "L", progress: null } }));
    hold(g, {}, 1);
    expect(e.phase).toBe("armed");
    hold(g, { rUp: true }, 1.5); // roll left
    expect(e.phase).not.toBe("armed");
  });

  it("CRUSH never squeezes the gap below 7 ball radii", () => {
    const def = buildChamber(1, "HOURGLASS", { pressureSide: null, density: 1, exitSide: "R", seed: 3 });
    const g = new Game(def);
    g.crush = { L: 500, R: 500 };
    const waist = def.H * 0.5;
    const ivs = g.intervals(waist);
    const width = ivs.reduce((s, iv) => s + iv.b - iv.a, 0);
    expect(width).toBeGreaterThanOrEqual(7 * BALL_R - 0.01);
  });

  it("SHIFT keeps the chamber solvable and never lands on the ball", () => {
    const def = buildChamber(1, "SPLITTER", { pressureSide: "R", density: 3, exitSide: "L", seed: 9 });
    const g = new Game(def);
    g.protectedUntil = 0;
    const e = g.enqueue(order({ ability: "SHIFT", side: "R", intensity: 3 }));
    hold(g, {}, 5);
    if (!e.fizzled) {
      expect(isSolvable(def, def.holes, 0)).toBe(true);
      const h = def.holes.find((q) => q.id === e.holeId)!;
      expect(Math.hypot(h.x - g.ball.x, h.y - g.ball.y)).toBeGreaterThan(h.r);
    }
  });

  it("death cancels pending effects", () => {
    const def = calib();
    const g = new Game(def);
    g.protectedUntil = 0;
    const e = g.enqueue(order({ trigger: { type: "progress", lane: null, progress: 0.9 } }));
    const h = def.holes[0];
    g.bar.yL = g.bar.yR = h.y - BALL_R - 6;
    g.ball.x = h.x;
    hold(g, { lUp: true, rUp: true }, 0.3);
    expect(e.phase).toBe("done");
    expect(e.fizzled).toBe("death");
  });
});

describe("player model", () => {
  it("separates a right-parker from a left-parker", () => {
    const a = new PlayerModel();
    const ga = new Game(calib());
    hold(ga, { lUp: true }, 0.6, a);
    hold(ga, {}, 8, a);
    const b = new PlayerModel();
    const gb = new Game(calib());
    hold(gb, { rUp: true }, 0.6, b);
    hold(gb, {}, 8, b);
    const sa = a.snapshot();
    const sb = b.snapshot();
    expect(sa.wallPark.v.side).toBe("R");
    expect(sb.wallPark.v.side).toBe("L");
    expect(sa.laneBias.v.R).toBeGreaterThan(0.7);
    expect(sb.laneBias.v.L).toBeGreaterThan(0.7);
    expect(sa.wallPark.c).toBeGreaterThan(0.6);
  });

  it("measures panic direction and reaction after telegraphs", () => {
    const m = new PlayerModel();
    const g = new Game(calib());
    g.protectedUntil = 0;
    for (let k = 0; k < 3; k++) {
      g.enqueue(order({ ability: "JAM", side: "L", trigger: { type: "now", lane: null, progress: null } }));
      hold(g, {}, 0.3, m);
      hold(g, { lUp: true }, 0.6, m); // flee right (left end up)
      hold(g, { rUp: true }, 0.6, m);
      hold(g, {}, 3, m);
      hold(g, { lUp: true }, 0.3, m);
      hold(g, { rUp: true }, 0.3, m);
    }
    const s = m.snapshot();
    expect(s.panicDirection.n).toBeGreaterThanOrEqual(2);
    expect(s.reactionMs.v).not.toBeNull();
    expect(s.reactionMs.v!).toBeGreaterThan(200);
  });

  it("counts corrections (quick motor reversals)", () => {
    const m = new PlayerModel();
    const g = new Game(calib());
    for (let k = 0; k < 6; k++) {
      hold(g, { lUp: true }, 0.15, m);
      hold(g, {}, 0.1, m);
      hold(g, { lDown: true }, 0.15, m);
      hold(g, {}, 0.1, m);
    }
    expect(m.reversals).toBeGreaterThanOrEqual(5);
  });

  it("lane is reported relative to the chamber shape", () => {
    const def = buildChamber(1, "TOWER", { pressureSide: null, density: 1, exitSide: "C", seed: 1 });
    // tower is shifted left around 30% height: x=-70 is its centre there
    expect(laneOf(def, -70, def.H * 0.3)).toBe("C");
  });
});
