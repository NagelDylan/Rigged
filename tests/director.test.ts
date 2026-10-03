import { describe, expect, it } from "vitest";
import { Director, type RigTransport } from "../src/agent/director";
import { allowedActions, newFairnessState, recordStart, rule, type FairnessContext } from "../src/agent/fairness";
import { evaluate, type PredictionWatch } from "../src/agent/outcome";
import { LocalTransport, localDecide } from "../src/agent/transport";
import { PHYS } from "../src/engine/constants";
import { Game } from "../src/engine/game";
import { PlayerModel } from "../src/engine/playerModel";
import type { DecideRequest, DecideResponse, TacticalDecision } from "../src/shared/rig";

const decision = (o: Partial<TacticalDecision> = {}): TacticalDecision => ({
  observation: "test",
  hypothesis: { ref: "new", status: "new", field: "laneBias", claim: "Likes the right.", confidence: 0.7 },
  intent: "exploit",
  strategy: "s",
  action: { ability: "PULSE", side: "R", intensity: 3, telegraphMs: 800, trigger: { type: "now", lane: null, progress: null } },
  prediction: { event: "flee", side: "R", ms: null, result: null, windowMs: 1500, pRig: 0.7, pBaseline: 0.4 },
  taunt: "Right again.",
  tauntRef: "laneBias",
  nextChamber: null,
  ...o,
});

const ctx = (o: Partial<FairnessContext> = {}): FairnessContext => ({
  chamber: 2,
  isFinal: false,
  clock: 60000,
  deathsHere: 0,
  lastDeathAt: null,
  cleanChambers: 0,
  progress: 0.3,
  reactionMs: 500,
  protectedUntil: 0,
  ...o,
});

describe("fairness director", () => {
  it("clamps intensity and telegraph floors", () => {
    const r = rule(decision(), "d1", ctx(), newFairnessState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order.intensity).toBe(2);
      expect(r.order.telegraphMs).toBeGreaterThanOrEqual(950);
    }
  });

  it("calibration allows only one gentle probe", () => {
    const st = newFairnessState();
    expect(allowedActions(ctx({ chamber: 0 }), st)).toEqual(["CRUSH", "PULSE", "WAIT"]);
    const r = rule(decision(), "d1", ctx({ chamber: 0 }), st);
    expect(r.ok && r.order.intensity).toBe(1);
    recordStart(st, "PULSE", "R", 1000, 0);
    expect(allowedActions(ctx({ chamber: 0 }), st)).toEqual(["WAIT"]);
  });

  it("vetoes abilities on cooldown and a 4th identical attack", () => {
    const st = newFairnessState();
    recordStart(st, "PULSE", "R", 59000, 2);
    const r = rule(decision(), "d1", ctx(), st);
    expect(r.ok).toBe(false);
    const st2 = newFairnessState();
    for (const t of [1000, 20000, 40000]) recordStart(st2, "PULSE", "R", t, 2);
    const r2 = rule(decision(), "d2", ctx({ clock: 90000 }), st2);
    expect(r2.ok).toBe(false);
  });

  it("relief: struggling players get intensity 1, then forced waits", () => {
    const r = rule(decision(), "d1", ctx({ deathsHere: 3 }), newFairnessState());
    expect(r.ok && r.order.intensity).toBe(1);
    expect(allowedActions(ctx({ deathsHere: 5, lastDeathAt: 59000 }), newFairnessState())).toEqual(["WAIT"]);
  });

  it("JAM only from chamber 4, once per chamber", () => {
    expect(allowedActions(ctx({ chamber: 2 }), newFairnessState())).not.toContain("JAM");
    const st = newFairnessState();
    expect(allowedActions(ctx({ chamber: 3 }), st)).toContain("JAM");
    recordStart(st, "JAM", "L", 1000, 3);
    expect(allowedActions(ctx({ chamber: 3 }), st)).not.toContain("JAM");
  });
});

describe("prediction grading", () => {
  const watch = (o: Partial<PredictionWatch>): PredictionWatch => ({
    decisionId: "d1",
    prediction: decision().prediction!,
    anchorAt: 0,
    x0: 0,
    lane0: "C",
    samples: [],
    firstInputMs: null,
    diedAtMs: null,
    effectId: 1,
    fizzled: null,
    ...o,
  });
  const samples = (xs: number[]) => xs.map((x, i) => ({ t: i * 100, x, lane: (x < -60 ? "L" : x > 60 ? "R" : "C") as "L" | "C" | "R", vx: 0, input: true }));

  it("flee right supported / weakened", () => {
    expect(evaluate(watch({ samples: samples([0, 20, 60, 90]) })).verdict).toBe("SUPPORTED");
    expect(evaluate(watch({ samples: samples([0, -20, -60, -90]) })).verdict).toBe("WEAKENED");
  });

  it("obvious predictions earn TRIVIAL", () => {
    const p = { ...decision().prediction!, pBaseline: 0.9 };
    expect(evaluate(watch({ prediction: p, samples: samples([0, 50, 90]) })).verdict).toBe("TRIVIAL");
  });

  it("fizzled actions are inconclusive", () => {
    expect(evaluate(watch({ fizzled: "no fair shift" })).verdict).toBe("INCONCLUSIVE");
  });

  it("react_within uses first input", () => {
    const p = { ...decision().prediction!, event: "react_within" as const, ms: 500, side: null };
    expect(evaluate(watch({ prediction: p, firstInputMs: 320, samples: samples([0, 0]) })).verdict).toBe("SUPPORTED");
    expect(evaluate(watch({ prediction: p, firstInputMs: 900, samples: samples([0, 0]) })).verdict).toBe("WEAKENED");
  });
});

class ScriptedTransport implements RigTransport {
  resolve: ((r: DecideResponse<unknown>) => void) | null = null;
  requests: DecideRequest[] = [];
  decide<T>(req: DecideRequest): Promise<DecideResponse<T>> {
    this.requests.push(req);
    return new Promise((res) => {
      this.resolve = res as (r: DecideResponse<unknown>) => void;
    });
  }
}

describe("director", () => {
  const setup = (transport: RigTransport) => {
    const game = new Game(Director.firstChamber(3));
    const model = new PlayerModel();
    const director = new Director({ game, model, transport, memory: null, seed: 3, now: () => game.clock });
    const step = (s: number, input = {}) => {
      for (let t = 0; t < s; t += PHYS.dt) {
        game.setInput({ lUp: false, lDown: false, rUp: false, rDown: false, ...input });
        game.step();
        if (game.phase === "playing") model.sample(game, PHYS.dt);
        const ev = game.drainEvents();
        for (const e of ev) model.onEvent(e, game);
        director.tick(ev);
      }
    };
    return { game, model, director, step };
  };

  it("makes its first read in calibration from real telemetry, not a timer only", async () => {
    const tr = new ScriptedTransport();
    const { step } = setup(tr);
    step(0.6, { lUp: true }); // roll to the right wall
    step(9);
    expect(tr.requests.length).toBe(1);
    expect(tr.requests[0].observation.trigger).toBe("first_read");
    expect(tr.requests[0].observation.model.wallPark.v.side).toBe("R");
  });

  it("drops a stale action that arrives after the player died", async () => {
    const tr = new ScriptedTransport();
    const { game, director, step } = setup(tr);
    step(0.6, { lUp: true });
    step(9);
    const req = tr.requests[0];
    // the player dies while RIG is thinking
    const h = game.chamber.holes[0];
    game.bar.yL = game.bar.yR = h.y - 15;
    game.ball.x = h.x;
    step(0.2, { lUp: true, rUp: true });
    expect(game.totalDeaths).toBe(1);
    const res = localDecide<TacticalDecision>(req, null);
    res.decision = decision({ action: { ...decision().action, intensity: 1 } });
    tr.resolve!(res);
    await Promise.resolve();
    await Promise.resolve();
    const log = director.log.at(-1)!;
    expect(log.ruling).toMatch(/STALE/);
    expect(game.effects.filter((e) => e.phase !== "done").length).toBe(0);
    expect(director.ledger.length).toBe(1); // belief still recorded
  });

  it("runs end-to-end with the local RIG and grades predictions", async () => {
    const { game, director, step } = setup(new LocalTransport());
    for (let k = 0; k < 40; k++) {
      step(0.5, k % 4 === 0 ? { lUp: true } : {});
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(director.log.length).toBeGreaterThan(0);
    expect(director.lines.some((l) => l.kind === "say")).toBe(true);
    expect(game.clock).toBeGreaterThan(15000);
  });
});
