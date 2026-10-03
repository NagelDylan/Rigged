// Turns raw play into the handful of behavioural features RIG actually uses.
// Fed every fixed step while playing, plus game events. Pure TS, no DOM.
import type { Ability, ModelField, PlayerModelSnapshot, Side } from "../shared/rig";
import { BALL_R } from "./constants";
import { normalizedX, outerIntervalAt } from "./chambers";
import type { Effect, Game, GameEvent, Input } from "./game";

const HALF_LIFE_S = 75; // recency weighting for lane share
const PANIC_WINDOW_MS = 1200;
const PANIC_DX = 22;

type Tri = { L: number; C: number; R: number };
const tri = (): Tri => ({ L: 0, C: 0, R: 0 });

interface PanicSample {
  side: Side | "hold";
  ability: Ability;
  at: number;
}

export interface DeathRecord {
  chamber: number;
  template: string;
  holeSide: Side;
  cause: Ability | null;
  at: number;
}

export class PlayerModel {
  seconds = 0; // playing seconds observed
  lane = tri(); // decayed seconds per lane
  laneRun = tri(); // total seconds per lane (run)
  laneChamber = tri();
  wall = { L: 0, R: 0 }; // seconds parked against an outer wall
  wallChamber = { L: 0, R: 0 };
  resting = new Array(12).fill(0); // seconds stationary per normalized-x bin
  motor = { L: 0, R: 0 }; // seconds each motor is driven
  stationary = 0; // seconds with no input
  speedSum = 0;
  climbSum = 0;
  reversals = 0;
  exitLane = tri();
  exitChambers = new Set<number>();
  panic: PanicSample[] = [];
  reactions: number[] = [];
  abilities: Partial<Record<Ability, { used: number; kills: number; evaded: number }>> = {};
  deaths: DeathRecord[] = [];
  // adaptation tracking (what changed after RIG called something out)
  callout: { field: ModelField; before: number; at: number; lane: Tri; wall: { L: number; R: number }; panicFrom: number } | null =
    null;

  private lastRelease: { L: { dir: number; at: number }; R: { dir: number; at: number } } = {
    L: { dir: 0, at: -1e9 },
    R: { dir: 0, at: -1e9 },
  };
  private pressStart = { L: -1e9, R: -1e9 };
  private prevInput: Input = { lUp: false, lDown: false, rUp: false, rDown: false };
  private prevY = 0;
  private pendingPanic: { effect: Effect; x0: number; startedAt: number }[] = [];

  /** Call once per fixed step while game.phase === 'playing'. */
  sample(game: Game, dt: number) {
    const { ball, chamber } = game;
    const now = game.clock;
    this.seconds += dt;
    const decay = Math.pow(0.5, dt / HALF_LIFE_S);
    this.lane.L *= decay;
    this.lane.C *= decay;
    this.lane.R *= decay;
    const lane = game.lane;
    this.lane[lane] += dt;
    this.laneRun[lane] += dt;
    this.laneChamber[lane] += dt;
    if (this.callout) this.callout.lane[lane] += dt;

    const i = game.input;
    const anyInput = i.lUp || i.lDown || i.rUp || i.rDown;
    if (!anyInput) this.stationary += dt;
    if (i.lUp || i.lDown) this.motor.L += dt;
    if (i.rUp || i.rDown) this.motor.R += dt;
    this.speedSum += Math.abs(ball.vx) * dt;
    const dy = ball.y - this.prevY;
    if (dy > 0 && dy < 20) this.climbSum += dy;
    this.prevY = ball.y;

    // wall parking: touching an OUTER wall, nearly still
    const o = outerIntervalAt(chamber.outer, ball.y);
    const crushL = game.crush.L;
    const crushR = game.crush.R;
    if (Math.abs(ball.vx) < 18) {
      if (ball.x - BALL_R <= o.a + crushL + 2.5) {
        this.wall.L += dt;
        this.wallChamber.L += dt;
        if (this.callout) this.callout.wall.L += dt;
      } else if (ball.x + BALL_R >= o.b - crushR - 2.5) {
        this.wall.R += dt;
        this.wallChamber.R += dt;
        if (this.callout) this.callout.wall.R += dt;
      }
    }
    if (Math.abs(ball.vx) < 8 && !anyInput) {
      const u = normalizedX(chamber, ball.x, ball.y);
      const bin = Math.min(11, Math.max(0, Math.floor(((u + 1) / 2) * 12)));
      this.resting[bin] += dt;
    }

    if (game.progress > 0.82) {
      this.exitLane[lane] += dt;
      this.exitChambers.add(chamber.index);
    }

    // corrections: a motor reversed direction within 450 ms of releasing
    for (const side of ["L", "R"] as const) {
      const up = side === "L" ? i.lUp : i.rUp;
      const down = side === "L" ? i.lDown : i.rDown;
      const pUp = side === "L" ? this.prevInput.lUp : this.prevInput.rUp;
      const pDown = side === "L" ? this.prevInput.lDown : this.prevInput.rDown;
      const dir = up ? 1 : down ? -1 : 0;
      const pdir = pUp ? 1 : pDown ? -1 : 0;
      // a release only counts if the press was deliberate (≥ 60 ms), so key-chatter isn't "correction"
      if (pdir !== 0 && dir !== pdir && now - this.pressStart[side] >= 60) this.lastRelease[side] = { dir: pdir, at: now };
      if (dir !== 0 && pdir !== dir) {
        const rel = this.lastRelease[side];
        if (rel.dir === -dir && now - rel.at < 450) this.reversals++;
        this.pressStart[side] = now;
      }
    }
    this.prevInput = { ...i };

    // panic direction: where did the ball go in the 1.2 s after a telegraph?
    for (const p of this.pendingPanic) {
      if (now - p.startedAt >= PANIC_WINDOW_MS) {
        const dx = ball.x - p.x0;
        this.panic.push({
          side: dx < -PANIC_DX ? "L" : dx > PANIC_DX ? "R" : "hold",
          ability: p.effect.order.ability,
          at: now,
        });
      }
    }
    this.pendingPanic = this.pendingPanic.filter((p) => now - p.startedAt < PANIC_WINDOW_MS);
  }

  onEvent(e: GameEvent, game: Game) {
    switch (e.type) {
      case "telegraph":
        this.pendingPanic.push({ effect: e.effect, x0: game.ball.x, startedAt: game.clock });
        break;
      case "effect_end": {
        const a = e.effect.order.ability;
        const rec = (this.abilities[a] ??= { used: 0, kills: 0, evaded: 0 });
        rec.used++;
        if (e.effect.killed) rec.kills++;
        else rec.evaded++;
        // < 120 ms is not a reaction, the player was already pressing keys
        if (e.effect.firstInputMs !== null && e.effect.firstInputMs >= 120 && e.effect.firstInputMs < 2500) {
          this.reactions.push(e.effect.firstInputMs);
          if (this.reactions.length > 8) this.reactions.shift();
        }
        break;
      }
      case "death": {
        const cause = e.cause !== null ? game.effects.find((q) => q.id === e.cause) : null;
        const u = normalizedX(game.chamber, e.x, e.y);
        this.deaths.push({
          chamber: game.chamber.index,
          template: game.chamber.template,
          holeSide: u < -0.25 ? "L" : u > 0.25 ? "R" : "C",
          cause: cause ? cause.order.ability : null,
          at: game.clock,
        });
        this.pendingPanic = [];
        break;
      }
      case "chamber_start":
        this.laneChamber = tri();
        this.wallChamber = { L: 0, R: 0 };
        break;
    }
  }

  /** RIG called out a behaviour: remember the baseline to measure adaptation. */
  noteCallout(field: ModelField, now: number) {
    this.callout = {
      field,
      before: this.scalar(field),
      at: now,
      lane: tri(),
      wall: { L: 0, R: 0 },
      panicFrom: this.panic.length,
    };
  }

  /** A signed scalar (-1 = left … +1 = right) for directional fields. */
  scalar(field: ModelField, src?: { lane: Tri; wall: { L: number; R: number }; panic: PanicSample[] }): number {
    const lane = src?.lane ?? this.lane;
    const wall = src?.wall ?? this.wall;
    const panic = src?.panic ?? this.panic;
    const share = (l: number, r: number) => (l + r > 0 ? (r - l) / (l + r) : 0);
    switch (field) {
      case "laneBias":
        return share(lane.L, lane.R);
      case "wallPark":
        return share(wall.L, wall.R);
      case "panicDirection": {
        const l = panic.filter((p) => p.side === "L").length;
        const r = panic.filter((p) => p.side === "R").length;
        return share(l, r);
      }
      case "motorShare":
        return share(this.motor.L, this.motor.R);
      default:
        return 0;
    }
  }

  snapshot(): PlayerModelSnapshot {
    const laneTot = this.lane.L + this.lane.C + this.lane.R || 1;
    const laneV = { L: r2(this.lane.L / laneTot), C: r2(this.lane.C / laneTot), R: r2(this.lane.R / laneTot) };
    const laneDom = Math.max(laneV.L, laneV.R);

    const wallTot = this.wall.L + this.wall.R;
    const wallSide: Side | null =
      wallTot < 2 ? null : this.wall.L >= this.wall.R * 1.8 ? "L" : this.wall.R >= this.wall.L * 1.8 ? "R" : null;

    const pl = this.panic.filter((p) => p.side === "L").length;
    const pr = this.panic.filter((p) => p.side === "R").length;
    const ph = this.panic.filter((p) => p.side === "hold").length;
    const pn = this.panic.length;
    const panicSide: Side | null =
      pn < 2 ? null : pl / pn >= 0.6 ? "L" : pr / pn >= 0.6 ? "R" : ph / pn >= 0.6 ? "C" : null;

    const reaction = this.reactions.length ? Math.round(avg(this.reactions)) : null;

    const secs = Math.max(1, this.seconds);
    const climbRate = this.climbSum / secs;
    const stationaryPct = this.stationary / secs;
    const meanSpeed = this.speedSum / secs;
    const label: "cautious" | "steady" | "aggressive" =
      stationaryPct > 0.42 || meanSpeed < 30
        ? "cautious"
        : stationaryPct < 0.18 && (meanSpeed > 62 || climbRate > 55)
          ? "aggressive"
          : "steady";

    const motorTot = this.motor.L + this.motor.R || 1;
    const exitTot = this.exitLane.L + this.exitLane.C + this.exitLane.R;
    const exitSide: Side | null =
      exitTot < 1 ? null : (["L", "C", "R"] as const).reduce((a, b) => (this.exitLane[b] > this.exitLane[a] ? b : a), "C");

    let adaptation: PlayerModelSnapshot["adaptation"]["v"] = { calledOut: null, before: null, after: null, changed: false };
    let adaptC = 0;
    if (this.callout) {
      const c = this.callout;
      const after = this.scalar(c.field, { lane: c.lane, wall: c.wall, panic: this.panic.slice(c.panicFrom) });
      const observed = c.lane.L + c.lane.C + c.lane.R;
      adaptC = clamp01(observed / 20);
      const changed = adaptC > 0.5 && Math.abs(c.before) > 0.2 && Math.sign(after) !== Math.sign(c.before) && Math.abs(after - c.before) > 0.35;
      adaptation = { calledOut: c.field, before: r2(c.before), after: r2(after), changed };
    }

    return {
      laneBias: { v: laneV, c: r2(clamp01(this.seconds / 18) * (laneDom > 0.5 ? 1 : 0.6)), n: Math.round(this.seconds) },
      wallPark: { v: { L: r1(this.wall.L), R: r1(this.wall.R), side: wallSide }, c: r2(clamp01(wallTot / 6)), n: Math.round(wallTot) },
      panicDirection: { v: { L: pl, R: pr, hold: ph, side: panicSide }, c: r2(clamp01(pn / 4)), n: pn },
      reactionMs: { v: reaction, c: r2(clamp01(this.reactions.length / 3)), n: this.reactions.length },
      style: {
        v: { label, climbRate: Math.round(climbRate), stationaryPct: r2(stationaryPct) },
        c: r2(clamp01(this.seconds / 20)),
        n: Math.round(this.seconds),
      },
      correctionRate: { v: r1((this.reversals / secs) * 10), c: r2(clamp01(this.seconds / 20)), n: this.reversals },
      motorShare: {
        v: { L: r2(this.motor.L / motorTot), R: r2(this.motor.R / motorTot) },
        c: r2(clamp01((this.motor.L + this.motor.R) / 12)),
        n: Math.round(this.motor.L + this.motor.R),
      },
      exitApproach: {
        v: { side: exitSide, L: r1(this.exitLane.L), C: r1(this.exitLane.C), R: r1(this.exitLane.R) },
        c: r2(clamp01(this.exitChambers.size / 2)),
        n: this.exitChambers.size,
      },
      abilityWeakness: {
        v: JSON.parse(JSON.stringify(this.abilities)),
        c: r2(clamp01(Object.values(this.abilities).reduce((s, a) => s + (a?.used ?? 0), 0) / 4)),
        n: Object.values(this.abilities).reduce((s, a) => s + (a?.used ?? 0), 0),
      },
      adaptation: { v: adaptation, c: r2(adaptC), n: this.callout ? 1 : 0 },
    };
  }

  /** Small live readout for the RIG terminal (proof it's watching). */
  tally() {
    const laneTot = this.laneRun.L + this.laneRun.C + this.laneRun.R || 1;
    return {
      wallL: this.wall.L,
      wallR: this.wall.R,
      laneL: this.laneRun.L / laneTot,
      laneC: this.laneRun.C / laneTot,
      laneR: this.laneRun.R / laneTot,
      motorL: this.motor.L,
      motorR: this.motor.R,
      panic: this.panic.map((p) => p.side),
      reaction: this.reactions.length ? Math.round(avg(this.reactions)) : null,
      seconds: this.seconds,
    };
  }

  restingSpots() {
    return this.resting.map((v) => r1(v));
  }
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
