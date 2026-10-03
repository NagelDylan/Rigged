// Deterministic real-time game simulation. No DOM, no network, no randomness
// outside seeded chamber builds. The LLM never touches this loop: it only
// enqueues validated EffectOrders which execute here deterministically.
import type { Ability, LR, Side } from "../shared/rig";
import { BALL_R, HALF_W, MIN_TELEGRAPH, PHYS, TIMING } from "./constants";
import { captureRadius, isSolvable, laneOf, outerIntervalAt, type ChamberDef, type Hole } from "./chambers";
import { clamp, intervalsAt, type Interval } from "./geometry";

export interface Input {
  lUp: boolean;
  lDown: boolean;
  rUp: boolean;
  rDown: boolean;
}
export const NO_INPUT: Input = { lUp: false, lDown: false, rUp: false, rDown: false };

export type Phase = "playing" | "dying" | "resetting" | "checkpoint" | "transition" | "won" | "paused";

export interface EffectOrder {
  decisionId: string;
  ability: Ability;
  side: Side;
  intensity: 1 | 2 | 3;
  telegraphMs: number;
  trigger: { type: "now" | "ball_enters" | "progress"; lane: Side | null; progress: number | null };
  expiresMs: number;
}

export interface TraceSample {
  t: number; // ms since telegraph start
  x: number;
  lane: Side;
  vx: number;
}

export interface Effect {
  id: number;
  order: EffectOrder;
  phase: "armed" | "telegraph" | "active" | "release" | "done";
  t: number; // ms in current phase
  armedAt: number; // run clock ms
  startedAt: number | null; // telegraph start (run clock ms)
  activeMs: number;
  // resolved targets
  holeId?: string;
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  dir?: -1 | 1;
  depth?: number;
  motor?: LR;
  crushSide?: LR;
  metAt?: number; // run clock when the trigger condition first held
  progress: number; // 0..1 animation helper for renderer
  // outcome tracing
  trace: TraceSample[];
  firstInputMs: number | null;
  killed: boolean;
  fizzled: string | null;
}

export type GameEvent =
  | { type: "death"; holeId: string; cause: number | null; x: number; y: number }
  | { type: "checkpoint"; chamber: number }
  | { type: "chamber_start"; chamber: number }
  | { type: "respawn" }
  | { type: "telegraph"; effect: Effect }
  | { type: "activate"; effect: Effect }
  | { type: "effect_end"; effect: Effect }
  | { type: "fizzle"; effect: Effect; reason: string }
  | { type: "wall_hit"; speed: number }
  | { type: "motor_limit"; side: LR }
  | { type: "lip"; holeId: string }
  | { type: "won" };

export interface BarState {
  yL: number;
  yR: number;
  vL: number;
  vR: number;
  strainL: number; // seconds of strain (decays)
  strainR: number;
}

export interface BallState {
  x: number;
  vx: number;
  y: number;
  fallingInto: Hole | null;
  fallT: number;
  capture: Record<string, number>;
  lastWallHit: number;
}

let effectSeq = 1;
const LEVERAGE_WAIT_MS = 3000;
/** MAGNET pull by intensity (u/s²); must stay escapable at full counter-tilt (see fairness red-team test). */
export const MAGNET_K = [110, 150, 185] as const;

export class Game {
  chamber!: ChamberDef;
  bar: BarState = { yL: PHYS.barMinY, yR: PHYS.barMinY, vL: 0, vR: 0, strainL: 0, strainR: 0 };
  ball: BallState = { x: 0, vx: 0, y: 0, fallingInto: null, fallT: 0, capture: {}, lastWallHit: 0 };
  phase: Phase = "playing";
  phaseT = 0; // ms in phase
  clock = 0; // run clock ms (advances while not paused)
  chamberClock = 0; // ms since chamber start
  life = 0; // increments on every death
  deathsHere = 0;
  totalDeaths = 0;
  protectedUntil = 0; // run clock ms
  effects: Effect[] = [];
  events: GameEvent[] = [];
  input: Input = { ...NO_INPUT };
  prevInput: Input = { ...NO_INPUT };
  crush = { L: 0, R: 0 };
  /** Director veto applied when an armed effect wants to start (global gap etc). */
  gate: ((e: Effect) => boolean) | null = null;
  /** Supplies the next chamber at checkpoint time; null means run complete. */
  nextChamber: ((index: number) => ChamberDef | null) | null = null;
  pendingChamber: ChamberDef | null = null;
  previousChamber: ChamberDef | null = null;
  readonly totalChambers: number;
  lastDeath: { holeId: string; cause: number | null; x: number; y: number } | null = null;

  constructor(first: ChamberDef, totalChambers = 5) {
    this.totalChambers = totalChambers;
    this.loadChamber(first);
  }

  get epoch() {
    return `c${this.chamber.index + 1}.l${this.life}`;
  }

  get progress() {
    return clamp((this.ball.y - PHYS.barMinY) / Math.max(1, this.chamber.exit.y - PHYS.barMinY), 0, 1);
  }

  get lane(): Side {
    return laneOf(this.chamber, this.ball.x, this.ball.y);
  }

  get slope() {
    return (this.bar.yR - this.bar.yL) / (HALF_W * 2);
  }

  barY(x: number) {
    return this.bar.yL + ((x + HALF_W) / (HALF_W * 2)) * (this.bar.yR - this.bar.yL);
  }

  loadChamber(def: ChamberDef) {
    this.chamber = def;
    this.resetChamberState();
    this.deathsHere = 0;
    this.chamberClock = 0;
    this.events.push({ type: "chamber_start", chamber: def.index });
  }

  private resetChamberState() {
    for (const h of this.chamber.holes) {
      h.x = h.baseX;
      h.y = h.baseY;
    }
    this.bar = { yL: PHYS.barMinY, yR: PHYS.barMinY, vL: 0, vR: 0, strainL: 0, strainR: 0 };
    this.ball = { x: 0, vx: 0, y: PHYS.barMinY + BALL_R, fallingInto: null, fallT: 0, capture: {}, lastWallHit: 0 };
    this.crush = { L: 0, R: 0 };
    for (const e of this.effects) if (e.phase !== "done") this.endEffect(e, true);
    this.effects = [];
    this.protectedUntil = this.clock + TIMING.spawnProtectMs;
  }

  /** RIG's validated order enters the machine here. */
  enqueue(order: EffectOrder): Effect {
    const e: Effect = {
      id: effectSeq++,
      order,
      phase: "armed",
      t: 0,
      armedAt: this.clock,
      startedAt: null,
      activeMs: activeDuration(order.ability),
      progress: 0,
      trace: [],
      firstInputMs: null,
      killed: false,
      fizzled: null,
    };
    this.effects.push(e);
    return e;
  }

  cancelArmed() {
    for (const e of this.effects) if (e.phase === "armed") this.fizzle(e, "cancelled");
  }

  setInput(i: Input) {
    this.input = { ...i };
  }

  drainEvents(): GameEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /** Advance the simulation by dt seconds (call with fixed PHYS.dt). */
  step(dt = PHYS.dt) {
    if (this.phase === "paused" || this.phase === "won") return;
    const ms = dt * 1000;
    this.clock += ms;
    this.phaseT += ms;
    this.chamberClock += ms;

    switch (this.phase) {
      case "playing":
        this.stepPlaying(dt);
        break;
      case "dying":
        this.ball.fallT += ms;
        this.stepEffects(dt, false);
        if (this.phaseT >= TIMING.deathFallMs + TIMING.deathHoldMs) this.setPhase("resetting");
        break;
      case "resetting":
        if (this.phaseT >= TIMING.resetMs) {
          this.resetChamberState();
          this.setPhase("playing");
          this.events.push({ type: "respawn" });
        }
        break;
      case "checkpoint":
        this.ball.fallT += ms;
        if (this.phaseT >= TIMING.checkpointHoldMs) {
          if (!this.pendingChamber) {
            this.setPhase("won");
            this.events.push({ type: "won" });
          } else {
            this.setPhase("transition");
          }
        }
        break;
      case "transition":
        if (this.phaseT >= TIMING.transitionMs && this.pendingChamber) {
          this.previousChamber = this.chamber;
          this.loadChamber(this.pendingChamber);
          this.pendingChamber = null;
          this.setPhase("playing");
        }
        break;
    }
    this.prevInput = { ...this.input };
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  pause(on: boolean) {
    if (on && this.phase === "playing") this.setPhase("paused");
    else if (!on && this.phase === "paused") {
      this.phase = "playing";
      // brief grace so a returning player is never ambushed
      this.protectedUntil = Math.max(this.protectedUntil, this.clock + 1200);
    }
  }

  // ------------------------------------------------------------------ playing
  private stepPlaying(dt: number) {
    const jam = this.jamFactors();
    this.stepBar(dt, jam);
    this.stepEffects(dt, true);
    this.stepHoles(dt);
    this.stepBall(dt);
  }

  private jamFactors() {
    const f = { L: 1, R: 1 };
    for (const e of this.effects) {
      if (e.order.ability === "JAM" && e.phase === "active" && e.motor) {
        f[e.motor] = [0.55, 0.42, 0.32][e.order.intensity - 1];
      }
    }
    return f;
  }

  private stepBar(dt: number, jam: { L: number; R: number }) {
    const b = this.bar;
    const i = this.input;
    const drive = (up: boolean, down: boolean) => (up ? 1 : 0) - (down ? 1 : 0);
    const move = (v: number, target: number) => {
      const accel = Math.abs(target) > Math.abs(v) && Math.sign(target) === Math.sign(v || target) ? PHYS.motorAccel : PHYS.motorDecel;
      const dv = target - v;
      const step = accel * dt;
      return Math.abs(dv) <= step ? target : v + Math.sign(dv) * step;
    };
    b.vL = move(b.vL, drive(i.lUp, i.lDown) * PHYS.motorSpeed * jam.L);
    b.vR = move(b.vR, drive(i.rUp, i.rDown) * PHYS.motorSpeed * jam.R);
    const top = this.chamber.H - PHYS.barTopMargin;
    let yL = b.yL + b.vL * dt;
    let yR = b.yR + b.vR * dt;
    if (yL < PHYS.barMinY || yL > top) (yL = clamp(yL, PHYS.barMinY, top)), (b.vL = 0);
    if (yR < PHYS.barMinY || yR > top) (yR = clamp(yR, PHYS.barMinY, top)), (b.vR = 0);
    const diff = yR - yL;
    if (Math.abs(diff) > PHYS.maxDiff) {
      // the side that is pushing the tilt further is blocked; it strains
      const excess = Math.abs(diff) - PHYS.maxDiff;
      const sgn = Math.sign(diff);
      const rightPushing = sgn * b.vR > 0;
      const leftPushing = -sgn * b.vL > 0;
      if (rightPushing && (!leftPushing || Math.abs(b.vR) >= Math.abs(b.vL))) {
        yR -= sgn * excess;
        b.vR = 0;
        if (b.strainR <= 0) this.events.push({ type: "motor_limit", side: "R" });
        b.strainR = 0.25;
      } else {
        yL += sgn * excess;
        b.vL = 0;
        if (b.strainL <= 0) this.events.push({ type: "motor_limit", side: "L" });
        b.strainL = 0.25;
      }
    }
    b.strainL = Math.max(0, b.strainL - dt);
    b.strainR = Math.max(0, b.strainR - dt);
    b.yL = yL;
    b.yR = yR;
  }

  /** Allowed intervals at y including RIG's crush, never squeezing below 6 ball radii. */
  intervals(y: number): Interval[] {
    const base = intervalsAt(this.chamber.outer, this.chamber.islands, y);
    if (this.crush.L <= 0 && this.crush.R <= 0) return base;
    const o = outerIntervalAt(this.chamber.outer, y);
    const room = Math.max(0, o.b - o.a - 7 * BALL_R);
    const cl = Math.min(this.crush.L, room / 2);
    const cr = Math.min(this.crush.R, room / 2);
    const a = o.a + cl;
    const b = o.b - cr;
    return base
      .map((iv) => ({ a: Math.max(iv.a, a), b: Math.min(iv.b, b) }))
      .filter((iv) => iv.b - iv.a > 2 * BALL_R + 1);
  }

  private stepBall(dt: number) {
    const ball = this.ball;
    let force = -PHYS.gravity * this.slope;
    let external = 0;

    for (const e of this.effects) {
      if (e.phase !== "active") continue;
      if (e.order.ability === "PULSE" && e.dir) {
        const k = [330, 450, 520][e.order.intensity - 1];
        const env = Math.sin(Math.PI * clamp(e.t / e.activeMs, 0, 1));
        external += e.dir * k * (0.5 + env);
      }
      if (e.order.ability === "MAGNET" && e.holeId) {
        const h = this.chamber.holes.find((q) => q.id === e.holeId);
        if (h) {
          const dx = h.x - ball.x;
          const d = Math.hypot(dx, h.y - ball.y);
          const reach = 230;
          if (d < reach) {
            const k = MAGNET_K[e.order.intensity - 1];
            external += Math.sign(dx) * k * (1 - d / reach) * clamp(Math.abs(dx) / 12, 0, 1);
          }
        }
      }
    }

    // hole lips & exit assist (horizontal component; the ball lives on the bar)
    for (const h of this.chamber.holes) {
      const dx = h.x - ball.x;
      const d = Math.hypot(dx, h.y - ball.y);
      const cr = captureRadius(h);
      if (d > cr && d < cr + PHYS.lipBand + BALL_R * 0.5) {
        external += Math.sign(dx) * PHYS.lipPull * (1 - (d - cr) / (PHYS.lipBand + BALL_R * 0.5));
      }
    }
    const ex = this.chamber.exit;
    const de = Math.hypot(ex.x - ball.x, ex.y - ball.y);
    if (de < PHYS.exitAssistR) external += Math.sign(ex.x - ball.x) * PHYS.exitAssistPull * clamp(Math.abs(ex.x - ball.x) / 10, 0, 1);

    force += external;
    if (Math.abs(this.slope) < PHYS.deadzoneSlope && Math.abs(ball.vx) < PHYS.deadzoneVx && Math.abs(external) < 1) {
      ball.vx = 0;
    } else {
      ball.vx += force * dt;
      ball.vx *= 1 - PHYS.damping * dt;
      ball.vx = clamp(ball.vx, -PHYS.maxVx, PHYS.maxVx);
    }
    ball.x += ball.vx * dt;
    ball.y = this.barY(ball.x) + BALL_R;

    // walls
    const ivs = this.intervals(ball.y);
    if (ivs.length) {
      let iv = ivs.find((q) => ball.x >= q.a && ball.x <= q.b);
      if (!iv) {
        iv = ivs.reduce((best, q) => (distTo(q, ball.x) < distTo(best, ball.x) ? q : best), ivs[0]);
      }
      const lo = iv.a + BALL_R;
      const hi = iv.b - BALL_R;
      if (ball.x < lo || ball.x > hi) {
        const speed = Math.abs(ball.vx);
        ball.x = clamp(ball.x, lo, Math.max(lo, hi));
        const intoWall = (ball.x <= lo && ball.vx < 0) || (ball.x >= hi && ball.vx > 0);
        if (intoWall) {
          ball.vx = -ball.vx * PHYS.wallRestitution;
          if (speed > 40 && this.clock - ball.lastWallHit > 120) {
            this.events.push({ type: "wall_hit", speed });
            ball.lastWallHit = this.clock;
          }
        }
        ball.y = this.barY(ball.x) + BALL_R;
      }
    }

    // holes
    for (const h of this.chamber.holes) {
      const d = Math.hypot(h.x - ball.x, h.y - ball.y);
      if (d < captureRadius(h)) {
        ball.capture[h.id] = (ball.capture[h.id] ?? 0) + 1;
        if (ball.capture[h.id] >= PHYS.captureTicks) return this.die(h);
      } else ball.capture[h.id] = 0;
    }
    if (de < captureRadius(ex)) {
      ball.fallingInto = ex;
      ball.fallT = 0;
      for (const e of this.effects) if (e.phase !== "done") this.endEffect(e, true);
      this.setPhase("checkpoint");
      this.events.push({ type: "checkpoint", chamber: this.chamber.index });
      // resolve the next chamber now so the renderer can prepare it during the hold
      this.pendingChamber = this.nextChamber?.(this.chamber.index + 1) ?? null;
    }
  }

  private die(h: Hole) {
    // RIG only gets the kill if its effect was actually acting (not merely telegraphing)
    const cause = this.effects.find(
      (e) =>
        e.startedAt !== null &&
        this.clock - e.startedAt >= e.order.telegraphMs &&
        (e.phase !== "done" || this.clock - (e.startedAt + e.order.telegraphMs + e.activeMs) < 1500),
    );
    if (cause) cause.killed = true;
    this.ball.fallingInto = h;
    this.ball.fallT = 0;
    this.life++;
    this.deathsHere++;
    this.totalDeaths++;
    this.lastDeath = { holeId: h.id, cause: cause?.id ?? null, x: this.ball.x, y: this.ball.y };
    this.events.push({ type: "death", holeId: h.id, cause: cause?.id ?? null, x: this.ball.x, y: this.ball.y });
    for (const e of this.effects) {
      if (e.phase === "done") continue;
      if (e.phase === "armed") this.fizzle(e, "death");
      else this.endEffect(e, true);
    }
    this.setPhase("dying");
  }

  private stepHoles(dt: number) {
    const ball = this.ball;
    for (const h of this.chamber.holes) {
      if (!h.follow) continue;
      if (Math.abs(ball.y - h.y) > 280) continue;
      const dx = ball.x - h.x;
      const safe = captureRadius(h) + BALL_R + 22;
      if (Math.hypot(dx, ball.y - h.y) < safe) continue;
      const nx = h.x + Math.sign(dx) * Math.min(Math.abs(dx), h.follow * dt);
      if (this.holeInside(nx, h.y, h.r)) h.x = nx;
    }
  }

  private holeInside(x: number, y: number, r: number) {
    return intervalsAt(this.chamber.outer, this.chamber.islands, y).some((iv) => x - r * 0.4 >= iv.a && x + r * 0.4 <= iv.b);
  }

  // ------------------------------------------------------------------ effects
  private stepEffects(dt: number, live: boolean) {
    const ms = dt * 1000;
    const pressed =
      (this.input.lUp && !this.prevInput.lUp) ||
      (this.input.lDown && !this.prevInput.lDown) ||
      (this.input.rUp && !this.prevInput.rUp) ||
      (this.input.rDown && !this.prevInput.rDown);

    this.crush = { L: 0, R: 0 };
    for (const e of this.effects) {
      if (e.phase === "done") continue;
      e.t += ms;
      if (e.phase === "armed") {
        if (!live) continue;
        if (this.clock - e.armedAt > e.order.expiresMs) {
          this.fizzle(e, "expired");
          continue;
        }
        if (this.clock < this.protectedUntil) continue;
        if (this.busy(e)) continue;
        if (this.progress > 0.95) continue;
        if (!this.triggerMet(e)) continue;
        if (this.gate && !this.gate(e)) continue;
        if (this.doomedSoon()) continue; // don't claim a ball that is already falling in
        this.startTelegraph(e);
        continue;
      }
      // trace for the outcome evaluator
      if (e.startedAt !== null) {
        const since = this.clock - e.startedAt;
        if (pressed && e.firstInputMs === null) e.firstInputMs = since;
        const last = e.trace[e.trace.length - 1];
        if (!last || since - last.t >= 100) e.trace.push({ t: since, x: this.ball.x, lane: this.lane, vx: this.ball.vx });
      }
      if (e.phase === "telegraph") {
        e.progress = clamp(e.t / e.order.telegraphMs, 0, 1);
        if (e.t >= e.order.telegraphMs) {
          e.phase = "active";
          e.t = 0;
          this.events.push({ type: "activate", effect: e });
        }
      } else if (e.phase === "active") {
        e.progress = clamp(e.t / e.activeMs, 0, 1);
        this.applyActive(e, dt);
        if (e.t >= e.activeMs) {
          e.phase = "release";
          e.t = 0;
        }
      } else if (e.phase === "release") {
        // CRUSH retracts; trace continues 2s past activation for evaluation
        if (e.order.ability === "CRUSH" && e.crushSide) {
          const d = Math.max(0, (e.depth ?? 0) - (e.t / 1000) * 70);
          this.crush[e.crushSide] = Math.max(this.crush[e.crushSide], d);
        }
        if (e.t >= 1600) this.endEffect(e, false);
      }
    }
    this.effects = this.effects.filter((e) => e.phase !== "done" || this.clock - (e.startedAt ?? 0) < 4000);
  }

  /** Would the ball reach a hole on its own within ~700 ms at its current velocity? */
  private doomedSoon() {
    const { x, vx, y } = this.ball;
    for (let t = 0.05; t <= 0.7; t += 0.05) {
      const px = x + vx * t;
      if (this.chamber.holes.some((h) => Math.hypot(h.x - px, h.y - y) < captureRadius(h) + 2)) return true;
    }
    return false;
  }

  /** One hazard at a time (the director may allow two in MODEL). */
  maxConcurrent = 1;
  private busy(e: Effect) {
    const running = this.effects.filter((q) => q !== e && (q.phase === "telegraph" || q.phase === "active"));
    return running.length >= this.maxConcurrent;
  }

  private triggerMet(e: Effect) {
    const tr = e.order.trigger;
    let met = false;
    if (tr.type === "now") met = true;
    else if (tr.type === "ball_enters") met = tr.lane !== null && this.lane === tr.lane;
    else if (tr.type === "progress") met = tr.progress !== null && this.progress >= tr.progress;
    if (!met) return false;
    // Leverage: a shove or pull is held (≤ LEVERAGE_WAIT_MS) until a hole actually lies in
    // the direction it acts. RIG chooses what/where/why; the executor chooses the moment.
    if (e.order.ability !== "PULSE" && e.order.ability !== "MAGNET") return true;
    e.metAt ??= this.clock;
    if (this.clock - e.metAt >= LEVERAGE_WAIT_MS) return true;
    const side = this.sideOf(e);
    const dir = side === "L" ? -1 : 1;
    const ball = this.ball;
    return this.chamber.holes.some((h) => {
      const dy = h.y - ball.y;
      const dx = (h.x - ball.x) * dir;
      return dy > -12 && dy < 40 && dx >= 45 && dx < 190;
    });
  }

  private startTelegraph(e: Effect) {
    const reason = this.resolveTargets(e);
    if (reason) return this.fizzle(e, reason);
    e.phase = "telegraph";
    e.t = 0;
    e.startedAt = this.clock;
    e.order.telegraphMs = Math.max(e.order.telegraphMs, MIN_TELEGRAPH[e.order.ability]);
    e.trace.push({ t: 0, x: this.ball.x, lane: this.lane, vx: this.ball.vx });
    this.events.push({ type: "telegraph", effect: e });
  }

  private sideOf(e: Effect): Side {
    const s = e.order.side;
    if (s !== "C") return s;
    // centre target means "where the ball is now"
    return this.ball.x < 0 ? "L" : "R";
  }

  /** Resolve concrete targets at telegraph time; returns a fizzle reason if unfair/impossible. */
  private resolveTargets(e: Effect): string | null {
    const ball = this.ball;
    const side = this.sideOf(e);
    switch (e.order.ability) {
      case "PULSE":
        e.dir = side === "L" ? -1 : 1;
        return null;
      case "JAM":
        e.motor = side === "L" ? "L" : "R";
        return null;
      case "CRUSH": {
        e.crushSide = side === "L" ? "L" : "R";
        e.depth = [60, 85, 110][e.order.intensity - 1];
        return null;
      }
      case "MAGNET": {
        const cands = this.chamber.holes.filter(
          (h) => !h.follow && Math.abs(h.y - ball.y) < 200 && h.y > ball.y - 60 && laneOf(this.chamber, h.x, h.y) === side,
        );
        const pick = cands.sort((a, b) => Math.abs(a.y - ball.y) - Math.abs(b.y - ball.y))[0];
        if (!pick) return "no hole in range";
        if (Math.hypot(pick.x - ball.x, pick.y - ball.y) < captureRadius(pick) + BALL_R + 40) return "too close";
        e.holeId = pick.id;
        return null;
      }
      case "SHIFT": {
        // targets stay within ~1 screen above the ball so the telegraph is visible
        const holes = this.chamber.holes.filter((h) => !h.follow && h.y > ball.y + 45 && h.y < ball.y + 190);
        holes.sort((a, b) => a.y - b.y);
        for (const h of holes) {
          const o = outerIntervalAt(this.chamber.outer, h.y);
          const targetU = side === "L" ? -0.55 : side === "R" ? 0.55 : 0;
          let tx = o.cx + targetU * o.hw;
          // aim at the lane, nudged toward the ball's x if the ball is already in it
          if (laneOf(this.chamber, ball.x, h.y) === side) tx = clamp(ball.x, o.a + h.r + 6, o.b - h.r - 6);
          if (Math.abs(tx - h.x) < 30) continue;
          if (!this.holeInside(tx, h.y, h.r)) continue;
          if (Math.hypot(tx - ball.x, h.y - ball.y) < captureRadius(h) + BALL_R + 45) continue;
          const others = this.chamber.holes.filter((q) => q !== h);
          if (others.some((q) => Math.hypot(q.x - tx, q.y - h.y) < 2 * h.r + 2 * BALL_R + 4)) continue;
          const moved = [...others, { ...h, x: tx }];
          if (!isSolvable(this.chamber, moved, 4)) continue;
          e.holeId = h.id;
          e.from = { x: h.x, y: h.y };
          e.to = { x: tx, y: h.y };
          return null;
        }
        return "no fair shift";
      }
    }
  }

  private applyActive(e: Effect, dt: number) {
    if (e.order.ability === "CRUSH") {
      const s = e.crushSide!;
      const speed = 75;
      const d = Math.min(e.depth ?? 0, (e.t / 1000) * speed);
      this.crush[s] = Math.max(this.crush[s], d);
    }
    if (e.order.ability === "SHIFT" && e.holeId && e.to) {
      const h = this.chamber.holes.find((q) => q.id === e.holeId);
      if (!h) return;
      const speed = [55, 70, 85][e.order.intensity - 1];
      const dx = e.to.x - h.x;
      const nx = h.x + Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
      const safe = captureRadius(h) + BALL_R + 16;
      if (Math.hypot(nx - this.ball.x, h.y - this.ball.y) > safe) h.x = nx;
      if (Math.abs(e.to.x - h.x) < 0.5) e.t = Math.max(e.t, e.activeMs);
    }
  }

  private endEffect(e: Effect, interrupted: boolean) {
    if (e.phase === "done") return;
    const wasStarted = e.startedAt !== null;
    e.phase = "done";
    if (e.holeId) {
      const h = this.chamber.holes.find((q) => q.id === e.holeId);
      if (h) h.residue = Math.min(6, h.residue + 2);
    }
    if (wasStarted) this.events.push({ type: "effect_end", effect: e });
    void interrupted;
  }

  private fizzle(e: Effect, reason: string) {
    e.phase = "done";
    e.fizzled = reason;
    this.events.push({ type: "fizzle", effect: e, reason });
  }

  // ------------------------------------------------------------------ helpers
  /** Snapshot of currently running (telegraph/active) effects. */
  running() {
    return this.effects.filter((e) => e.phase === "telegraph" || e.phase === "active");
  }
}

function activeDuration(a: Ability) {
  switch (a) {
    case "PULSE":
      return 340;
    case "MAGNET":
      return 2600;
    case "CRUSH":
      return 2900;
    case "JAM":
      return 1700;
    case "SHIFT":
      return 3200;
  }
}

function distTo(iv: Interval, x: number) {
  return x < iv.a ? iv.a - x : x > iv.b ? x - iv.b : 0;
}

