// Autopilot used for automated QA, agent evaluation and demo. It plays through
// the public Input interface only, with a configurable behavioural
// "personality" (lane preference, panic direction, caution) so RIG has
// something to learn.
//
// Architecture
//  1. PLANNER — a cost-weighted distance field (Dijkstra) from the exit over a
//     grid of ball-centre positions. Cells inside a hole's capture radius or
//     outside the walls are blocked; cells near holes are expensive; cells on
//     the non-preferred side cost a little more (lane personality).
//  2. MPC — every few ticks a small set of (tilt, climb-rate) commands is
//     rolled forward through a faithful copy of the bar/ball physics, each
//     followed by a braking tail ("can I still stop safely afterwards?"). The
//     cheapest rollout (distance-field value + hole-proximity penalty, death =
//     huge) is executed.
//  3. LOW LEVEL — converts (target slope, ball-height rate) into motor
//     up/down presses, pivoting the bar around the ball so tilting does not
//     move the ball vertically.
import { BALL_R, HALF_W, PHYS } from "./constants";
import { captureRadius, outerIntervalAt, type ChamberDef } from "./chambers";
import { intervalsAt, type Interval } from "./geometry";
import { hashString, makeRng } from "./rng";
import type { Game, GameEvent, Input } from "./game";

export interface BotProfile {
  name: string;
  lanePref: number; // -1 left … +1 right (how strongly it prefers a side)
  panic: -1 | 0 | 1; // where it flees when RIG telegraphs (0 = freezes)
  caution: number; // 0 aggressive … 1 very cautious
  switchAfterChamber?: number; // ADAPTER: flips lanePref/panic from this chamber index on
  skill: number; // 0..1 (1 = never sloppy)
}

export const PROFILES: Record<string, BotProfile> = {
  right: { name: "RIGHT-HUGGER", lanePref: 0.85, panic: 1, caution: 0.5, skill: 0.85 },
  left: { name: "LEFT-HUGGER", lanePref: -0.85, panic: -1, caution: 0.5, skill: 0.85 },
  cautious: { name: "CAUTIOUS", lanePref: 0.1, panic: 0, caution: 0.95, skill: 0.9 },
  aggressive: { name: "AGGRESSIVE", lanePref: -0.2, panic: 1, caution: 0.05, skill: 0.7 },
  adapter: { name: "ADAPTER", lanePref: 0.85, panic: 1, caution: 0.5, switchAfterChamber: 2, skill: 0.85 },
};

const NONE: Input = { lUp: false, lDown: false, rUp: false, rDown: false };
const SPAN = HALF_W * 2;
const MOTOR = PHYS.motorSpeed;
const MAX_SLOPE = (PHYS.maxDiff - 4) / SPAN;

// ------------------------------------------------------------------ physics copy
interface SimState {
  yL: number;
  yR: number;
  vL: number;
  vR: number;
  x: number;
  vx: number;
  y: number;
}

interface Cmd {
  s: number; // target bar slope
  vy: number; // target ball-height rate (u/s)
}

interface Env {
  top: number;
  iv: (y: number) => Interval[];
  hx: number[];
  hy: number[];
  hcr: number[];
  ex: number;
  ey: number;
  ecr: number;
}

function motorMove(v: number, target: number, dt: number) {
  const accel = Math.abs(target) > Math.abs(v) && Math.sign(target) === Math.sign(v || target) ? PHYS.motorAccel : PHYS.motorDecel;
  const dv = target - v;
  const step = accel * dt;
  return Math.abs(dv) <= step ? target : v + Math.sign(dv) * step;
}

/** -1 / 0 / +1 press for one motor so its velocity tracks `vd`. */
function press(vd: number, v: number) {
  // slowing down = letting go (releasing brakes as hard as reversing), so
  // the opposite key is only pressed for a genuine change of direction
  if (vd > v + 9) return v < 0 && vd <= 4 ? 0 : 1;
  if (vd < v - 9) return v > 0 && vd >= -4 ? 0 : -1;
  if (Math.abs(vd) < 14) return 0;
  return Math.sign(vd);
}

/** Motor drive (-1/0/1 each) realising a slope / climb-rate command, pivoting around the ball. */
function control(st: SimState, cmd: Cmd): [number, number] {
  const slope = (st.yR - st.yL) / SPAN;
  const L = st.x + HALF_W;
  const R = HALF_W - st.x;
  // Pivot around the ball when possible; when a big tilt change is needed far
  // off-centre, accept some vertical ball motion (the vBar clamp below).
  const dsMax = (2 * MOTOR) / SPAN;
  const err = cmd.s - slope;
  // small deadband: hands rest when the tilt is "about right" (no jitter)
  const ds = Math.abs(err) < 0.008 ? 0 : clamp(err * 7, -dsMax, dsMax);
  const pL = -ds * L;
  const pR = ds * R;
  let vBar = cmd.vy === 0 && ds === 0 ? 0 : cmd.vy - slope * st.vx;
  const lo = Math.max(-MOTOR - pL, -MOTOR - pR);
  const hi = Math.min(MOTOR - pL, MOTOR - pR);
  vBar = lo > hi ? (lo + hi) / 2 : clamp(vBar, lo, hi);
  return [press(vBar + pL, st.vL), press(vBar + pR, st.vR)];
}

function simStep(st: SimState, dL: number, dR: number, dt: number, env: Env) {
  st.vL = motorMove(st.vL, dL * MOTOR, dt);
  st.vR = motorMove(st.vR, dR * MOTOR, dt);
  let yL = st.yL + st.vL * dt;
  let yR = st.yR + st.vR * dt;
  if (yL < PHYS.barMinY || yL > env.top) (yL = clamp(yL, PHYS.barMinY, env.top)), (st.vL = 0);
  if (yR < PHYS.barMinY || yR > env.top) (yR = clamp(yR, PHYS.barMinY, env.top)), (st.vR = 0);
  const diff = yR - yL;
  if (Math.abs(diff) > PHYS.maxDiff) {
    const excess = Math.abs(diff) - PHYS.maxDiff;
    const sgn = Math.sign(diff);
    const rightPushing = sgn * st.vR > 0;
    const leftPushing = -sgn * st.vL > 0;
    if (rightPushing && (!leftPushing || Math.abs(st.vR) >= Math.abs(st.vL))) (yR -= sgn * excess), (st.vR = 0);
    else (yL += sgn * excess), (st.vL = 0);
  }
  st.yL = yL;
  st.yR = yR;
  const slope = (yR - yL) / SPAN;
  let ext = 0;
  const lipW = PHYS.lipBand + BALL_R * 0.5;
  for (let i = 0; i < env.hx.length; i++) {
    const dx = env.hx[i] - st.x;
    const d = Math.hypot(dx, env.hy[i] - st.y);
    const cr = env.hcr[i];
    if (d > cr && d < cr + lipW) ext += Math.sign(dx) * PHYS.lipPull * (1 - (d - cr) / lipW);
  }
  const edx = env.ex - st.x;
  if (Math.hypot(edx, env.ey - st.y) < PHYS.exitAssistR) ext += Math.sign(edx) * PHYS.exitAssistPull * clamp(Math.abs(edx) / 10, 0, 1);
  const force = -PHYS.gravity * slope + ext;
  if (Math.abs(slope) < PHYS.deadzoneSlope && Math.abs(st.vx) < PHYS.deadzoneVx && Math.abs(ext) < 1) st.vx = 0;
  else {
    st.vx += force * dt;
    st.vx *= 1 - PHYS.damping * dt;
    st.vx = clamp(st.vx, -PHYS.maxVx, PHYS.maxVx);
  }
  st.x += st.vx * dt;
  st.y = yL + ((st.x + HALF_W) / SPAN) * (yR - yL) + BALL_R;
  const ivs = env.iv(st.y);
  if (ivs.length) {
    let iv = ivs.find((q) => st.x >= q.a && st.x <= q.b);
    if (!iv) iv = ivs.reduce((b, q) => (distTo(q, st.x) < distTo(b, st.x) ? q : b), ivs[0]);
    const lo = iv.a + BALL_R;
    const hi = iv.b - BALL_R;
    if (st.x < lo || st.x > hi) {
      st.x = clamp(st.x, lo, Math.max(lo, hi));
      if ((st.x <= lo && st.vx < 0) || (st.x >= hi && st.vx > 0)) st.vx = -st.vx * PHYS.wallRestitution;
      st.y = yL + ((st.x + HALF_W) / SPAN) * (yR - yL) + BALL_R;
    }
  }
}

// ------------------------------------------------------------------ planner
const CELL = 6;

interface FieldOpts {
  lane: number; // signed lane preference
  margin: number; // hole proximity band that costs extra
  prox: number; // proximity cost weight
}

class Field {
  cols = Math.ceil(SPAN / CELL);
  rows: number;
  D: Float32Array;
  constructor(
    public def: ChamberDef,
    opts: FieldOpts,
  ) {
    const { cols } = this;
    const rows = (this.rows = Math.ceil(def.H / CELL) + 1);
    const n = cols * rows;
    const mult = new Float32Array(n).fill(-1); // -1 blocked
    const holes = def.holes.map((h) => ({ x: h.x, y: h.y, cr: captureRadius(h) }));
    const yMin = PHYS.barMinY + BALL_R - 2;
    const yMax = def.H - PHYS.barTopMargin + BALL_R;
    for (let r = 0; r < rows; r++) {
      const y = r * CELL;
      if (y < yMin || y > yMax) continue;
      const ivs = intervalsAt(def.outer, def.islands, y);
      const o = outerIntervalAt(def.outer, y);
      for (let c = 0; c < cols; c++) {
        const x = -HALF_W + c * CELL + CELL / 2;
        if (!ivs.some((iv) => x >= iv.a + BALL_R - 1 && x <= iv.b - BALL_R + 1)) continue;
        let clr = 999;
        for (const h of holes) clr = Math.min(clr, Math.hypot(h.x - x, h.y - y) - h.cr);
        if (clr < 2) continue;
        const p = Math.max(0, 1 - clr / opts.margin);
        const u = (x - o.cx) / Math.max(1, o.hw);
        const lane = (Math.abs(opts.lane) * (1 - Math.sign(opts.lane) * u)) / 2;
        mult[r * cols + c] = 1 + opts.prox * p * p + 1.6 * lane;
      }
    }
    const D = (this.D = new Float32Array(n).fill(Infinity));
    const heap = new Heap(n);
    const ex = def.exit;
    const ecr = captureRadius(ex) - 2;
    let seeded = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const x = -HALF_W + c * CELL + CELL / 2;
        if (Math.hypot(ex.x - x, ex.y - r * CELL) < ecr) {
          if (mult[i] < 0) mult[i] = 1;
          D[i] = 0;
          heap.push(i, 0);
          seeded = true;
        }
      }
    }
    if (!seeded) return;
    const dc = [-1, 1, 0, 0, -1, 1, -1, 1];
    const dr = [0, 0, -1, 1, -1, -1, 1, 1];
    while (heap.size) {
      const [i, d] = heap.pop();
      if (d > D[i]) continue;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (let k = 0; k < 8; k++) {
        const cc = c + dc[k];
        const rr = r + dr[k];
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
        const j = rr * cols + cc;
        if (mult[j] < 0) continue;
        if (k >= 4 && (mult[r * cols + cc] < 0 || mult[rr * cols + c] < 0)) continue;
        const nd = d + (k < 4 ? CELL : CELL * Math.SQRT2) * 0.5 * (mult[i] + mult[j]);
        if (nd < D[j]) {
          D[j] = nd;
          heap.push(j, nd);
        }
      }
    }
  }

  at(x: number, y: number): number {
    const { cols, rows, D } = this;
    const fx = (x + HALF_W - CELL / 2) / CELL;
    const fy = y / CELL;
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const tx = fx - c0;
    const ty = fy - r0;
    let s = 0;
    let w = 0;
    for (let k = 0; k < 4; k++) {
      const c = c0 + (k & 1);
      const r = r0 + (k >> 1);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const v = D[r * cols + c];
      if (!Number.isFinite(v)) continue;
      const wk = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty) + 1e-4;
      s += v * wk;
      w += wk;
    }
    if (w > 0) return s / w;
    // off-field (hugging a wall or a hole): nearest finite cell + penalty
    const ci = Math.round(fx);
    const ri = Math.round(fy);
    let best = Infinity;
    for (let rad = 1; rad <= 4 && best === Infinity; rad++) {
      for (let r = ri - rad; r <= ri + rad; r++) {
        for (let c = ci - rad; c <= ci + rad; c++) {
          if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
          const v = D[r * cols + c];
          if (Number.isFinite(v)) best = Math.min(best, v + 6 + rad * CELL * 1.5);
        }
      }
    }
    return Number.isFinite(best) ? best : 1e4;
  }
}

class Heap {
  idx: Int32Array;
  key: Float32Array;
  size = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(cap * 4 + 16);
    this.key = new Float32Array(cap * 4 + 16);
  }
  push(i: number, k: number) {
    if (this.size >= this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2);
      ni.set(this.idx);
      const nk = new Float32Array(this.key.length * 2);
      nk.set(this.key);
      this.idx = ni;
      this.key = nk;
    }
    let p = this.size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q];
      this.key[p] = this.key[q];
      p = q;
    }
    this.idx[p] = i;
    this.key[p] = k;
  }
  pop(): [number, number] {
    const ri = this.idx[0];
    const rk = this.key[0];
    const li = this.idx[--this.size];
    const lk = this.key[this.size];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c];
      this.key[p] = this.key[c];
      p = c;
    }
    this.idx[p] = li;
    this.key[p] = lk;
    return [ri, rk];
  }
}

// ------------------------------------------------------------------ the bot
type Mode = "path" | "hold" | "flee";

export class Bot {
  private rng: () => number;
  private field: Field | null = null;
  private fieldDef: ChamberDef | null = null;
  private fieldKey = "";
  private fieldLane = 0;
  private ivTable: Interval[][] = [];
  private cmd: Cmd = { s: 0, vy: 0 };
  private tick = 0;
  private mode: Mode = "path";
  private modeUntil = 0;
  private holdAt = { x: 0, y: 0 };
  private parkX: number | null = null;
  private parkDir = 0;
  private fleeX = 0;
  private panicAt = -1;
  private panicDir = 0;
  private nextPause = 0;
  private bestD = Infinity;
  private bestAt = 0;
  private stuckUntil = 0;
  private sloppy = 0;
  private sloppyUntil = 0;
  private lastLife = -1;
  // personality-derived tuning
  private maxS: number;
  private vMax: number;
  private margin: number;
  private tail: number;
  private dwell: number; // ms before a released key's opposite is pressed
  private overconf: number; // aggressive players think gaps are wider than they are

  constructor(public profile: BotProfile) {
    this.rng = makeRng(hashString(profile.name) ^ 0x5eed);
    const c = profile.caution;
    this.maxS = MAX_SLOPE * (0.4 + 0.6 * (1 - c));
    this.vMax = MOTOR * (0.25 + 0.75 * Math.pow(1 - c, 1.5));
    this.margin = 4 + 20 * c;
    this.tail = Math.round(12 + 24 * c);
    this.dwell = 160 + 200 * profile.skill;
    this.overconf = Math.max(0, 0.5 - c) * 6 * (1 - profile.skill) * 2;
  }

  private pref(game: Game) {
    const p = this.profile;
    const flipped = p.switchAfterChamber !== undefined && game.chamber.index >= p.switchAfterChamber;
    return { lane: flipped ? -p.lanePref : p.lanePref, panic: flipped ? -p.panic : p.panic };
  }

  onEvent(e: GameEvent, game: Game) {
    if (e.type === "telegraph") {
      const { panic } = this.pref(game);
      this.panicDir = panic;
      // reaction time: cautious players are slower to commit
      this.panicAt = game.clock + 140 + 220 * this.profile.caution + this.rng() * 120;
    }
  }

  private ensureField(game: Game) {
    const def = game.chamber;
    const lane = game.clock < this.stuckUntil ? 0 : this.pref(game).lane;
    const key = def.holes.map((h) => `${Math.round(h.x / 4)},${Math.round(h.y / 4)}`).join(";") + `|${lane}`;
    if (def !== this.fieldDef) {
      this.fieldDef = def;
      this.ivTable = [];
      for (let y = 0; y <= def.H + 4; y += 2) this.ivTable.push(intervalsAt(def.outer, def.islands, y));
      this.field = null;
      this.bestD = Infinity;
      this.bestAt = game.clock;
      this.nextPause = game.clock + this.pauseGap();
    }
    if (!this.field || (key !== this.fieldKey && this.tick % 30 === 0) || lane !== this.fieldLane) {
      this.field = new Field(def, { lane, margin: 20 + 22 * this.profile.caution, prox: 3 + 4 * this.profile.caution });
      this.fieldKey = key;
      this.fieldLane = lane;
    }
    return this.field;
  }

  private pauseGap() {
    // cautious players stop and look; steady ones occasionally; aggressive never
    const c = this.profile.caution;
    if (c < 0.3) return Infinity;
    return c > 0.8 ? 1200 + this.rng() * 1000 : 2500 + this.rng() * 2000;
  }

  decide(game: Game): Input {
    if (game.phase !== "playing") return { ...NONE };
    this.tick++;
    const field = this.ensureField(game);
    const { ball, bar } = game;
    const st: SimState = { yL: bar.yL, yR: bar.yR, vL: bar.vL, vR: bar.vR, x: ball.x, vx: ball.vx, y: ball.y };

    if (game.life !== this.lastLife) {
      this.lastLife = game.life;
      this.mode = "path";
      this.bestD = Infinity;
      this.bestAt = game.clock;
      this.nextPause = game.clock + this.pauseGap();
    }

    // stuck detector: no progress along the field for a while → drop lane bias
    const dNow = field.at(ball.x, ball.y);
    if (dNow < this.bestD - 12) {
      this.bestD = dNow;
      this.bestAt = game.clock;
    } else if (this.mode === "path" && game.clock - this.bestAt > 9000) {
      this.stuckUntil = game.clock + 6000;
      this.bestAt = game.clock;
      this.bestD = dNow;
    }

    // startle: between a telegraph and the reaction, hands come off the keys
    // (unless that would roll the ball into a hole)
    if (this.panicAt >= 0 && game.clock < this.panicAt) {
      if (clearance(this.env(game), ball.x + ball.vx * 0.3, ball.y) > this.margin + 4) return { ...NONE };
    }

    // mode switches
    if (this.panicAt >= 0 && game.clock >= this.panicAt) {
      this.panicAt = -1;
      this.parkX = null;
      if (this.panicDir === 0) {
        this.mode = "hold";
        this.holdAt = { x: ball.x, y: ball.y };
      } else {
        this.mode = "flee";
        const ivs = game.intervals(ball.y);
        const iv = ivs.find((q) => ball.x >= q.a - 1 && ball.x <= q.b + 1) ?? ivs[0];
        this.fleeX = iv ? (this.panicDir > 0 ? iv.b - BALL_R - 3 : iv.a + BALL_R + 3) : ball.x + this.panicDir * 120;
        this.holdAt = { x: ball.x, y: ball.y };
      }
      this.modeUntil = game.clock + 1300;
    } else if (this.mode !== "path" && game.clock >= this.modeUntil) {
      this.mode = "path";
      this.nextPause = game.clock + this.pauseGap();
    } else if (this.mode === "path" && game.clock >= this.nextPause && game.progress < 0.9) {
      const env = this.env(game);
      if (Math.abs(ball.vx) < 45 && clearance(env, ball.x, ball.y) > this.margin + 6) {
        this.mode = "hold";
        this.holdAt = { x: ball.x, y: ball.y };
        this.parkX = null;
        this.modeUntil = game.clock + (this.profile.caution > 0.8 ? 1000 + this.rng() * 800 : 600 + this.rng() * 400);
        // lane-huggers rest against their wall when the way there is clear
        const lane = this.pref(game).lane;
        if (Math.abs(lane) > 0.5) {
          const ivs = game.intervals(ball.y);
          const iv = ivs.find((q) => ball.x >= q.a - 1 && ball.x <= q.b + 1);
          if (iv) {
            const wx = lane > 0 ? iv.b - BALL_R : iv.a + BALL_R;
            let ok = Math.abs(wx - ball.x) < 160;
            for (let k = 0; k <= 8 && ok; k++) ok = clearance(env, ball.x + ((wx - ball.x) * k) / 8, ball.y) > this.margin + 4;
            if (ok) {
              this.parkX = wx;
              this.parkDir = Math.sign(lane);
              this.holdAt = { x: wx, y: ball.y };
              this.modeUntil += 600;
            }
          }
        }
      } else this.nextPause = game.clock + 300;
    }

    // a cautious hold that has settled: hands off the buttons
    if (this.mode === "hold") {
      const slope = game.slope;
      const still = bar.vL === 0 && bar.vR === 0;
      if (still && Math.abs(ball.vx) < PHYS.deadzoneVx && Math.abs(slope) < PHYS.deadzoneSlope * 0.9) return { ...NONE };
      // parked against the wall, tilted into it: hands off
      if (still && this.parkX !== null && Math.abs(ball.x - this.parkX) < 3 && Math.abs(ball.vx) < 15 && -slope * this.parkDir >= -0.002)
        return { ...NONE };
    }

    if (this.tick % 4 === 1 || this.tick < 2) this.cmd = this.plan(game, st, field);
    let [dL, dR] = control(st, this.cmd);
    // human hands: a key is not reversed right after being released unless it matters
    const urgent = clearance(this.env(game), ball.x + ball.vx * 0.25, ball.y) < this.margin;
    dL = this.hand(0, dL, game.clock, urgent);
    dR = this.hand(1, dR, game.clock, urgent);
    return { lUp: dL > 0, lDown: dL < 0, rUp: dR > 0, rDown: dR < 0 };
  }

  private lastDir = [0, 0];
  private releasedAt = [-1e9, -1e9];
  private hand(m: number, d: number, now: number, urgent: boolean) {
    const last = this.lastDir[m];
    if (d !== 0 && last !== 0 && d === -last && !urgent && now - this.releasedAt[m] < this.dwell) d = 0;
    if (d === 0 && last !== 0 && this.releasedAt[m] < 0) this.releasedAt[m] = now;
    if (d !== 0) {
      this.lastDir[m] = d;
      this.releasedAt[m] = -1;
    }
    return d;
  }

  private env(game: Game): Env {
    const def = game.chamber;
    const crushed = game.crush.L > 0 || game.crush.R > 0;
    const table = this.ivTable;
    const iv = crushed
      ? (y: number) => game.intervals(y)
      : (y: number) => table[clamp(Math.round(y / 2), 0, table.length - 1)];
    const hx: number[] = [];
    const hy: number[] = [];
    const hcr: number[] = [];
    for (const h of def.holes) {
      if (Math.abs(h.y - game.ball.y) > 240) continue;
      hx.push(h.x);
      hy.push(h.y);
      hcr.push(captureRadius(h));
    }
    return { top: def.H - PHYS.barTopMargin, iv, hx, hy, hcr, ex: def.exit.x, ey: def.exit.y, ecr: captureRadius(def.exit) };
  }

  private plan(game: Game, st0: SimState, field: Field): Cmd {
    const env = this.env(game);
    const p = this.profile;
    const S = this.maxS;
    const V = this.vMax;
    let vys = [-0.6 * V, -0.25 * V, 0, 0.5 * V, V];
    const mode = this.mode;
    const slopes = (mode === "hold" ? [0, 0.12, -0.12, 0.3, -0.3] : [0, 0.15, -0.15, 0.35, -0.35, 0.6, -0.6, 1, -1]).map((k) => k * S);
    if (mode === "hold") vys = [-0.3 * V, 0, 0.2 * V];
    const margin = this.margin;
    const W = 0.9 + 2.2 * p.caution;
    const dt = 1 / 60;
    // 0.4 s command; look further ahead when progress has stalled
    const n1 = game.clock - this.bestAt > 2500 ? 54 : 24;
    const n2 = this.tail; // braking tail (aggressive players look less far ahead)
    const objective = (s: SimState) => {
      if (mode === "path") return field.at(s.x, s.y);
      if (mode === "flee") return 2.2 * Math.abs(s.x - this.fleeX) + 1.5 * Math.abs(s.y - this.holdAt.y) + 0.1 * field.at(s.x, s.y);
      return 3 * Math.hypot(s.x - this.holdAt.x, s.y - this.holdAt.y) + 0.5 * Math.abs(s.vx);
    };
    let best: Cmd = { s: 0, vy: 0 };
    let bestCost = Infinity;
    const st: SimState = { ...st0 };
    for (const s of slopes) {
      for (const vy of vys) {
        Object.assign(st, st0);
        const cmd: Cmd = { s, vy };
        const brake: Cmd = { s: 0, vy: 0 };
        let cost = 0;
        let o1 = 0;
        let done = false;
        for (let k = 0; k < n1 + n2; k++) {
          let c = cmd;
          if (k >= n1) {
            brake.s = clamp(st.vx * 0.0035, -S, S);
            c = brake;
          }
          const [dL, dR] = control(st, c);
          simStep(st, dL, dR, dt, env);
          if (Math.hypot(env.ex - st.x, env.ey - st.y) < env.ecr - 1) {
            cost = -1e5 + k;
            done = true;
            break;
          }
          const clr = clearance(env, st.x, st.y) + this.overconf;
          if (clr < 0.5) {
            cost = 1e6 + (n1 + n2 - k) * 1e4;
            done = true;
            break;
          }
          if (clr < margin) cost += W * (margin - clr) * (margin - clr) * dt * (k < n1 ? 1 : 0.6);
          if (k === n1 - 1) o1 = objective(st);
        }
        if (!done) cost += 0.45 * o1 + 0.55 * objective(st) + 0.05 * Math.abs(st.vx);
        // humans do not flip the tilt every frame: changing plans has a price
        cost += 18 * Math.abs(s - this.cmd.s) + 0.02 * Math.abs(vy - this.cmd.vy);
        if (cost < bestCost) {
          bestCost = cost;
          best = cmd;
        }
      }
    }
    // sloppiness: imprecise players over/under-steer now and then
    if (game.clock > this.sloppyUntil && this.rng() < (1 - p.skill) * 0.04) {
      this.sloppy = (this.rng() - 0.5) * 2 * (1 - p.skill) * S * 1.6;
      this.sloppyUntil = game.clock + 250 + this.rng() * 300;
    }
    if (game.clock < this.sloppyUntil) best = { s: clamp(best.s + this.sloppy, -MAX_SLOPE, MAX_SLOPE), vy: best.vy };
    return best;
  }
}

function clearance(env: Env, x: number, y: number) {
  let m = 999;
  for (let i = 0; i < env.hx.length; i++) {
    const d = Math.hypot(env.hx[i] - x, env.hy[i] - y) - env.hcr[i];
    if (d < m) m = d;
  }
  return m;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function distTo(iv: Interval, x: number) {
  return x < iv.a ? iv.a - x : x > iv.b ? x - iv.b : 0;
}
