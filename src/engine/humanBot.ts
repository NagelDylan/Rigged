// Human-like controller for QA. Wraps the competent planning Bot (bot.ts) and
// degrades it the way a keyboard player is degraded:
//   - PERCEPTION DELAY: the bot plans on a delayed snapshot of the world
//     (ball, holes, crush walls, phase, telegraphs). Own bar motion is partially
//     known ("efference copy"); ball motion is only partially extrapolated.
//   - DECISION CADENCE: a new intent is adopted only every ~120–220 ms.
//   - KEY QUANTIZATION: a pressed key is held for at least `minHoldMs`; reversing
//     a motor needs a short release gap.
//   - OVERSHOOT / HESITATION: releases are sometimes late (key held too long),
//     presses are sometimes late (hesitation).
// Telegraph events are delivered to the bot only once the delayed view reaches
// them, so the bot's own startle (~140–480 ms) stacks on top of perception.
import { BALL_R, HALF_W, PHYS } from "./constants";
import { laneOf, outerIntervalAt, type ChamberDef, type Hole } from "./chambers";
import { Bot, type BotProfile } from "./bot";
import { clamp, intervalsAt, type Interval } from "./geometry";
import type { Game, GameEvent, Input, Phase } from "./game";
import { hashString, makeRng } from "./rng";

export type HumanSkill = "novice" | "average" | "good";

export interface HumanParams {
  delayMs: number; // perception latency
  decideMin: number; // ms between intent updates
  decideMax: number;
  minHoldMs: number; // shortest key tap
  reverseGapMs: number; // release gap before pressing the opposite key
  overshootP: number; // chance a release comes late
  overshootMs: [number, number];
  hesitateP: number; // chance a press comes late
  hesitateMs: [number, number];
  efference: number; // 0..1 how well own bar motion is known (bar extrapolation)
  predict: number; // 0..1 how much of the delay the ball is extrapolated over
  caution: number; // passed to the planner
  skill: number; // planner sloppiness (bot.ts)
}

export const HUMAN: Record<HumanSkill, HumanParams> = {
  novice: {
    delayMs: 360,
    decideMin: 170,
    decideMax: 240,
    minHoldMs: 110,
    reverseGapMs: 70,
    overshootP: 0.35,
    overshootMs: [60, 240],
    hesitateP: 0.25,
    hesitateMs: [80, 260],
    efference: 0.35,
    predict: 0.2,
    caution: 0.55,
    skill: 0.35,
  },
  average: {
    delayMs: 290,
    decideMin: 140,
    decideMax: 200,
    minHoldMs: 90,
    reverseGapMs: 50,
    overshootP: 0.2,
    overshootMs: [40, 160],
    hesitateP: 0.15,
    hesitateMs: [60, 180],
    efference: 0.6,
    predict: 0.5,
    caution: 0.45,
    skill: 0.6,
  },
  good: {
    delayMs: 240,
    decideMin: 115,
    decideMax: 160,
    minHoldMs: 80,
    reverseGapMs: 35,
    overshootP: 0.1,
    overshootMs: [20, 90],
    hesitateP: 0.08,
    hesitateMs: [40, 120],
    efference: 0.85,
    predict: 0.75,
    caution: 0.4,
    skill: 0.85,
  },
};

interface Snap {
  clock: number;
  chamber: ChamberDef;
  phase: Phase;
  life: number;
  ballX: number;
  ballVx: number;
  yL: number;
  yR: number;
  vL: number;
  vR: number;
  holes: Float64Array; // x,y pairs in chamber.holes order
  crushL: number;
  crushR: number;
}

/** Read-only, delayed view of a Game with the members Bot uses. */
class DelayedView {
  phase: Phase = "playing";
  clock = 0;
  life = 0;
  chamber!: ChamberDef;
  ball = { x: 0, vx: 0, y: 0 };
  bar = { yL: PHYS.barMinY, yR: PHYS.barMinY, vL: 0, vR: 0 };
  crush = { L: 0, R: 0 };
  private views = new Map<ChamberDef, ChamberDef>();

  viewOf(def: ChamberDef): ChamberDef {
    let v = this.views.get(def);
    if (!v) {
      v = { ...def, holes: def.holes.map((h) => ({ ...h })) };
      this.views.set(def, v);
    }
    return v;
  }

  get slope() {
    return (this.bar.yR - this.bar.yL) / (HALF_W * 2);
  }
  get progress() {
    return clamp((this.ball.y - PHYS.barMinY) / Math.max(1, this.chamber.exit.y - PHYS.barMinY), 0, 1);
  }
  get lane() {
    return laneOf(this.chamber, this.ball.x, this.ball.y);
  }
  barY(x: number) {
    return this.bar.yL + ((x + HALF_W) / (HALF_W * 2)) * (this.bar.yR - this.bar.yL);
  }
  intervals(y: number): Interval[] {
    const base = intervalsAt(this.chamber.outer, this.chamber.islands, y);
    if (this.crush.L <= 0 && this.crush.R <= 0) return base;
    const o = outerIntervalAt(this.chamber.outer, y);
    const room = Math.max(0, o.b - o.a - 7 * BALL_R);
    const a = o.a + Math.min(this.crush.L, room / 2);
    const b = o.b - Math.min(this.crush.R, room / 2);
    return base.map((iv) => ({ a: Math.max(iv.a, a), b: Math.min(iv.b, b) })).filter((iv) => iv.b - iv.a > 2 * BALL_R + 1);
  }
}

function motorMove(v: number, target: number, dt: number) {
  const accel = Math.abs(target) > Math.abs(v) && Math.sign(target) === Math.sign(v || target) ? PHYS.motorAccel : PHYS.motorDecel;
  const dv = target - v;
  const step = accel * dt;
  return Math.abs(dv) <= step ? target : v + Math.sign(dv) * step;
}

export class HumanBot {
  readonly bot: Bot;
  readonly p: HumanParams;
  private rng: () => number;
  private snaps: Snap[] = [];
  private view = new DelayedView();
  private pendingEvents: { at: number; e: GameEvent }[] = [];
  private nextDecision = 0;
  private intent: [number, number] = [0, 0]; // desired drive per motor
  private key: [number, number] = [0, 0]; // actual drive per motor
  private keySince: [number, number] = [0, 0];
  private releaseAt: [number, number] = [-1, -1]; // scheduled (late) release
  private pressAt: [number, number] = [-1, -1]; // scheduled (late) press
  private pressDir: [number, number] = [0, 0];
  private inputLog: { at: number; dL: number; dR: number }[] = [];

  constructor(
    public skill: HumanSkill,
    seed: number,
    profile?: Partial<BotProfile>,
    overrides: Partial<HumanParams> = {},
  ) {
    this.p = { ...HUMAN[skill], ...overrides };
    this.rng = makeRng(hashString(`${skill}:${seed}`) ^ 0xbadc0de);
    const r = makeRng(seed * 31 + 7);
    const panicRoll = r();
    this.bot = new Bot({
      name: `HUMAN-${skill}-${seed}`,
      lanePref: (r() - 0.5) * 1.2,
      panic: panicRoll < 0.33 ? -1 : panicRoll < 0.66 ? 1 : 0,
      caution: this.p.caution,
      skill: this.p.skill,
      ...profile,
    });
  }

  /** Feed every engine event (the bot sees them only after the perception delay). */
  onEvent(e: GameEvent, game: Game) {
    this.pendingEvents.push({ at: game.clock, e });
  }

  private record(game: Game) {
    const hs = game.chamber.holes;
    const holes = new Float64Array(hs.length * 2);
    hs.forEach((h, i) => {
      holes[i * 2] = h.x;
      holes[i * 2 + 1] = h.y;
    });
    this.snaps.push({
      clock: game.clock,
      chamber: game.chamber,
      phase: game.phase,
      life: game.life,
      ballX: game.ball.x,
      ballVx: game.ball.vx,
      yL: game.bar.yL,
      yR: game.bar.yR,
      vL: game.bar.vL,
      vR: game.bar.vR,
      holes,
      crushL: game.crush.L,
      crushR: game.crush.R,
    });
    const horizon = game.clock - this.p.delayMs - 200;
    while (this.snaps.length > 2 && this.snaps[1].clock <= horizon) this.snaps.shift();
  }

  private buildView(game: Game): DelayedView {
    const target = game.clock - this.p.delayMs;
    let s = this.snaps[0];
    for (const q of this.snaps) {
      if (q.clock <= target) s = q;
      else break;
    }
    const v = this.view;
    v.clock = s.clock;
    v.phase = s.phase;
    v.life = s.life;
    v.chamber = v.viewOf(s.chamber);
    const hs: Hole[] = v.chamber.holes;
    for (let i = 0; i < hs.length && i * 2 < s.holes.length; i++) {
      hs[i].x = s.holes[i * 2];
      hs[i].y = s.holes[i * 2 + 1];
    }
    v.crush.L = s.crushL;
    v.crush.R = s.crushR;
    // bar: delayed view blended toward what own key presses must have done since (efference copy)
    let yL = s.yL;
    let yR = s.yR;
    let vL = s.vL;
    let vR = s.vR;
    if (s.chamber === game.chamber && s.phase === "playing") {
      const dt = PHYS.dt;
      for (const q of this.inputLog) {
        if (q.at <= s.clock) continue;
        vL = motorMove(vL, q.dL * PHYS.motorSpeed, dt);
        vR = motorMove(vR, q.dR * PHYS.motorSpeed, dt);
        yL += vL * dt;
        yR += vR * dt;
      }
      const top = s.chamber.H - PHYS.barTopMargin;
      yL = clamp(yL, PHYS.barMinY, top);
      yR = clamp(yR, PHYS.barMinY, top);
      const e = this.p.efference;
      yL = s.yL + (yL - s.yL) * e;
      yR = s.yR + (yR - s.yR) * e;
      vL = s.vL + (vL - s.vL) * e;
      vR = s.vR + (vR - s.vR) * e;
    }
    v.bar.yL = yL;
    v.bar.yR = yR;
    v.bar.vL = vL;
    v.bar.vR = vR;
    const lag = (game.clock - s.clock) / 1000;
    let x = s.ballX + s.ballVx * lag * this.p.predict;
    const ivs = intervalsAt(s.chamber.outer, s.chamber.islands, v.barY(s.ballX) + BALL_R);
    const iv = ivs.find((q) => s.ballX >= q.a && s.ballX <= q.b);
    if (iv) x = clamp(x, iv.a + BALL_R, iv.b - BALL_R);
    v.ball.x = x;
    v.ball.vx = s.ballVx;
    v.ball.y = v.barY(x) + BALL_R;
    return v;
  }

  decide(game: Game): Input {
    this.record(game);
    const view = this.buildView(game);
    // deliver events the human has now "seen"
    while (this.pendingEvents.length && this.pendingEvents[0].at <= view.clock) {
      const { e } = this.pendingEvents.shift()!;
      this.bot.onEvent(e, view as unknown as Game);
    }
    // the planner runs every frame on the delayed view (keeps its internal clocks sane) …
    const want = this.bot.decide(view as unknown as Game);
    const now = game.clock;
    // … but its output is only adopted at human decision instants
    if (now >= this.nextDecision) {
      this.intent = [(want.lUp ? 1 : 0) - (want.lDown ? 1 : 0), (want.rUp ? 1 : 0) - (want.rDown ? 1 : 0)];
      this.nextDecision = now + this.p.decideMin + this.rng() * (this.p.decideMax - this.p.decideMin);
    }
    if (game.phase !== "playing") {
      this.key = [0, 0];
      this.releaseAt = [-1, -1];
      this.pressAt = [-1, -1];
      this.logInput(now);
      return { lUp: false, lDown: false, rUp: false, rDown: false };
    }
    for (let m = 0; m < 2; m++) this.finger(m, now);
    this.logInput(now);
    const [dL, dR] = this.key;
    return { lUp: dL > 0, lDown: dL < 0, rUp: dR > 0, rDown: dR < 0 };
  }

  private logInput(now: number) {
    this.inputLog.push({ at: now, dL: this.key[0], dR: this.key[1] });
    while (this.inputLog.length && this.inputLog[0].at < now - this.p.delayMs - 50) this.inputLog.shift();
  }

  private finger(m: number, now: number) {
    const want = this.intent[m];
    const cur = this.key[m];
    const held = now - this.keySince[m];
    const set = (d: number) => {
      if (d !== this.key[m]) {
        this.key[m] = d;
        this.keySince[m] = now;
      }
    };
    if (cur !== 0) {
      if (want === cur) {
        this.releaseAt[m] = -1;
        return;
      }
      if (held < this.p.minHoldMs) return; // taps are never shorter than this
      if (this.releaseAt[m] < 0) {
        const late = this.rng() < this.p.overshootP ? this.rand(this.p.overshootMs) : 0;
        this.releaseAt[m] = now + late;
      }
      if (now >= this.releaseAt[m]) {
        this.releaseAt[m] = -1;
        set(0);
      }
      return;
    }
    // key is up
    if (want === 0) {
      this.pressAt[m] = -1;
      return;
    }
    if (this.pressAt[m] < 0 || this.pressDir[m] !== want) {
      const gap = held < this.p.reverseGapMs ? this.p.reverseGapMs - held : 0;
      const late = this.rng() < this.p.hesitateP ? this.rand(this.p.hesitateMs) : 0;
      this.pressAt[m] = now + gap + late;
      this.pressDir[m] = want;
    }
    if (now >= this.pressAt[m]) {
      this.pressAt[m] = -1;
      set(want);
    }
  }

  private rand([a, b]: [number, number]) {
    return a + this.rng() * (b - a);
  }
}
