// Authored chamber templates. RIG may choose a template and a few strategic
// parameters; it can never author raw geometry. Every build is checked for a
// passable route (flood fill) and optional holes are removed until it is.
import type { LR, Side, TemplateName } from "../shared/rig";
import { BALL_R, EXIT_R, HALF_W, HOLE_R, PHYS } from "./constants";
import { intervalsAt, sampleProfile, type Island, type ProfilePoint } from "./geometry";
import { makeRng } from "./rng";

export interface Hole {
  id: string;
  x: number;
  y: number;
  r: number;
  baseX: number;
  baseY: number;
  kind: "hole" | "exit";
  /** Follows the ball horizontally at this speed (EYE pupil). */
  follow?: number;
  /** Optional slot tag (for debugging / MODEL reveal ordering). */
  tag?: string;
  /** RIG residue pixels left on this hole after it was manipulated. */
  residue: number;
}

export interface ChamberParams {
  pressureSide: LR | null;
  density: 1 | 2 | 3;
  exitSide: Side;
  seed: number;
}

export interface ModelParams {
  trapSide: LR;
  exitSide: Side;
  restingSpots: number[]; // 12-bin histogram over normalized x
  useRestingSpots: boolean;
}

export interface ChamberDef {
  index: number; // 0-based position in run
  template: TemplateName;
  name: string;
  H: number;
  outer: ProfilePoint[];
  islands: Island[];
  holes: Hole[];
  exit: Hole;
  params: ChamberParams;
  /** Holes punched from the player's resting spots (MODEL reveal order). */
  revealHoles: string[];
}

interface Slot {
  u: number; // -1..1 across the outer interval at that height
  v: number; // 0..1 of chamber height
  tag?: "core" | "L" | "R" | "d2" | "d3" | "rest";
  abs?: boolean; // u is an absolute x
  follow?: number;
}

interface Blueprint {
  H: number;
  outer: ProfilePoint[];
  islands: Island[];
  slots: Slot[];
  exit: { u: number; v: number };
}

const P = (y: number, hw: number, cx = 0): ProfilePoint => ({ y, cx, hw });

function exitU(side: Side, spread = 0.55) {
  return side === "L" ? -spread : side === "R" ? spread : 0;
}

function sided(side: LR | null, slots: Slot[]): Slot[] {
  // optional slots are authored for the right side; mirror for left
  if (!side) return [];
  return slots.map((s) => ({ ...s, u: side === "R" ? s.u : -s.u, tag: side }));
}

/** A row of holes at height v across the outer interval (normalized u). */
function row(v: number, us: number[], tag?: Slot["tag"]): Slot[] {
  return us.map((u) => ({ u, v, tag }));
}

const BLUEPRINTS: Record<Exclude<TemplateName, "MODEL">, (p: ChamberParams) => Blueprint> = {
  CALIBRATION: (p) => {
    const H = 920;
    return {
      H,
      outer: [P(0, 275), P(H, 275)],
      islands: [],
      slots: [
        { u: 0, v: 0.27 },
        { u: -0.62, v: 0.43 },
        { u: 0.62, v: 0.43 },
        { u: 0.02, v: 0.6 },
        { u: -0.42, v: 0.77 },
        { u: 0.44, v: 0.77 },
        { u: -0.92, v: 0.62, tag: "d2" },
        { u: 0.92, v: 0.62, tag: "d2" },
      ],
      exit: { u: exitU(p.exitSide, 0.5), v: 0.93 },
    };
  },
  FUNNEL: (p) => {
    // Idea: commit to the centre. A wide centre gap invites you in at the
    // bottom; as the walls converge the side lanes pinch out against holes
    // hugging the walls, so a ball that drifted to a side must cross back.
    const H = 1060;
    return {
      H,
      outer: [P(0, 285), P(H * 0.3, 285), P(H * 0.88, 92), P(H, 92)],
      islands: [],
      slots: [
        // no holes hugging the walls low down: players brake against the wall (human playtest)
        ...row(0.17, [-0.52, -0.22, 0.22, 0.52]),
        ...row(0.36, [-0.45, 0, 0.45]),
        ...row(0.52, [-0.66, -0.2, 0.2, 0.66]),
        ...row(0.66, [-0.78, -0.3, 0.3, 0.78]),
        ...row(0.78, [-0.42, 0.42]),
        ...row(0.78, [-0.9, 0.9], "d2"),
        ...sided(p.pressureSide, [
          { u: 0.35, v: 0.27 },
          { u: 0.55, v: 0.72 },
        ]),
        { u: -0.45, v: 0.88, tag: "d2" },
        { u: 0.45, v: 0.88, tag: "d3" },
        { u: -0.35, v: 0.27, tag: "d3" },
      ],
      exit: { u: 0, v: 0.955 },
    };
  },
  SPLITTER: (p) => {
    // Idea: choose a lane before the divider. Each lane has its own rhythm
    // (left: tight-loose-medium, right: loose-tight-medium); once inside you
    // are committed until the divider ends.
    const H = 1150;
    const y0 = H * 0.3;
    const y1 = H * 0.74;
    return {
      H,
      outer: [P(0, 280), P(H, 280)],
      islands: [{ id: "divider", points: [P(y0, 0), P(y0 + 34, 38), P(y1 - 34, 38), P(y1, 0)] }],
      slots: [
        ...row(0.15, [-0.66, -0.2, 0.25, 0.7]),
        // left lane
        ...row(0.38, [-0.8, -0.57, -0.34]),
        ...row(0.5, [-0.57]),
        ...row(0.62, [-0.73, -0.39]),
        // right lane
        ...row(0.41, [0.57]),
        ...row(0.53, [0.34, 0.57, 0.8]),
        ...row(0.66, [0.43, 0.75]),
        // after the divider
        ...row(0.84, [-0.75, -0.25, 0.25, 0.75]),
        ...sided(p.pressureSide, [
          { u: 0.86, v: 0.47 },
          { u: 0.3, v: 0.6 },
        ]),
        { u: -0.62, v: 0.25, tag: "d2" },
        { u: 0.62, v: 0.25, tag: "d2" },
        { u: -0.6, v: 0.44, tag: "d3" },
        { u: 0.6, v: 0.6, tag: "d3" },
      ],
      exit: { u: exitU(p.exitSide, 0.6), v: 0.95 },
    };
  },
  EYE: (p) => {
    // Idea: a ring of holes with a pupil that follows you. Go through the eye
    // (the pupil chases you; leave through the open lid at the top) or around
    // the rim, which is narrower than it looks.
    const H = 980;
    const cy = H * 0.5;
    const ring: Slot[] = [];
    const n = 12;
    for (let i = 1; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / 2; // i = 0 (top) skipped: the eye's "lid"
      ring.push({ u: Math.cos(a) * 192, v: (cy + Math.sin(a) * 176) / H, abs: true });
    }
    return {
      H,
      outer: [
        P(0, 120),
        P(H * 0.12, 210),
        P(H * 0.3, 278),
        P(H * 0.5, 288),
        P(H * 0.7, 278),
        P(H * 0.88, 210),
        P(H, 120),
      ],
      islands: [],
      slots: [
        ...ring,
        { u: 0, v: 0.5, abs: true, follow: 30, tag: "core" },
        ...row(0.38, [-0.86, 0.86]),
        ...row(0.62, [-0.86, 0.86]),
        ...row(0.19, [-0.5, 0.5]),
        ...sided(p.pressureSide, [
          { u: 0.6, v: 0.8 },
          { u: 0.22, v: 0.24 },
        ]),
        { u: -0.6, v: 0.8, tag: "d2" },
        { u: -0.22, v: 0.24, tag: "d3" },
        { u: 0, v: 0.78, tag: "d3" },
      ],
      exit: { u: exitU(p.exitSide, 0.35), v: 0.94 },
    };
  },
  HOURGLASS: (p) => {
    // Idea: line up for the waist. Holes guard the converging walls just
    // below the neck, so a wall-hugger gets squeezed past them; a centred ball
    // enters cleanly. The neck itself is clean; a hole right above it forces
    // an immediate split toward the exit.
    const H = 1100;
    return {
      H,
      outer: [P(0, 280), P(H * 0.3, 280), P(H * 0.5, 74), P(H * 0.7, 280), P(H, 280)],
      islands: [],
      slots: [
        ...row(0.16, [-0.5, 0, 0.5]),
        ...row(0.3, [-0.62, -0.2, 0.2, 0.62]),
        ...row(0.46, [-0.6, 0.6]),
        { u: 0, v: 0.6 },
        ...row(0.7, [-0.62, -0.25, 0.25, 0.62]),
        ...row(0.82, [-0.8, -0.4, 0, 0.4, 0.8]),
        ...sided(p.pressureSide, [
          { u: 0.4, v: 0.23 },
          { u: 0.5, v: 0.64 },
        ]),
        { u: -0.4, v: 0.23, tag: "d2" },
        { u: 0.2, v: 0.9, tag: "d2" },
        { u: -0.5, v: 0.64, tag: "d3" },
        { u: 0, v: 0.38, tag: "d3" },
      ],
      exit: { u: exitU(p.exitSide === "C" ? "R" : p.exitSide, 0.68), v: 0.94 },
    };
  },
  TOWER: (p) => {
    // Idea: zigzag rhythm. Every row is a picket of holes with one wide gap,
    // and the wide gap alternates sides as the walls lean left and right.
    const H = 1240;
    const A = [-0.75, -0.32, 0.1];
    const B = A.map((u) => -u);
    const vs = [0.15, 0.28, 0.41, 0.54, 0.67, 0.8];
    const slots: Slot[] = [];
    vs.forEach((v, i) => {
      const odd = i % 2 === 1;
      slots.push(...row(v, odd ? B : A));
      // density closes the wide gap a little: d2 on every other row, d3 on all
      slots.push({ u: odd ? -0.72 : 0.72, v, tag: i % 2 === 0 ? "d2" : "d3" });
    });
    return {
      H,
      outer: [P(0, 165, 0), P(H * 0.3, 160, -70), P(H * 0.6, 160, 70), P(H * 0.85, 160, -40), P(H, 160, 0)],
      islands: [],
      slots: [...slots, ...sided(p.pressureSide, [{ u: 0.5, v: 0.6 }, { u: 0.5, v: 0.34 }])],
      exit: { u: 0, v: 0.95 },
    };
  },
};

export const CHAMBER_LABEL: Record<TemplateName, string> = {
  CALIBRATION: "CALIBRATION",
  FUNNEL: "FUNNEL",
  SPLITTER: "SPLITTER",
  EYE: "EYE",
  HOURGLASS: "HOURGLASS",
  TOWER: "TOWER",
  MODEL: "MODEL",
};

function modelBlueprint(m: ModelParams): Blueprint {
  const H = 1260;
  const y0 = H * 0.36;
  const y1 = H * 0.66;
  const trap = m.trapSide === "R" ? 1 : -1;
  // Core holes avoid the resting-spot bands (v ≈ .25/.31/.47/.88) so the
  // player's own spots can always be punched.
  const slots: Slot[] = [
    ...row(0.16, [-0.6, 0, 0.6], "core"),
    // the comfortable-looking trap lane: clean at the entrance, a double picket deep inside
    ...row(0.58, [trap * 0.3, trap * 0.62, trap * 0.9], "core"),
    { u: trap * 0.46, v: 0.65, tag: "core" },
    // the other lane is honest but busy from the start
    ...row(0.4, [-trap * 0.4, -trap * 0.85], "core"),
    ...row(0.53, [-trap * 0.25, -trap * 0.62], "core"),
    ...row(0.62, [-trap * 0.45, -trap * 0.85], "core"),
    // the narrowing top: one more decision before the exit
    ...row(0.76, [-0.75, -0.25, 0.25, 0.75], "core"),
    ...row(0.82, [-0.5, 0, 0.5], "core"),
  ];
  if (m.useRestingSpots) {
    // Holes where the player's ball habitually rested, strongest first.
    const bins = m.restingSpots.map((w, i) => ({ w, i })).filter((b) => b.w > 0);
    bins.sort((a, b) => b.w - a.w);
    const vs = [0.25, 0.31, 0.47, 0.88];
    bins.slice(0, 4).forEach((b, k) => {
      const u = -0.92 + (b.i + 0.5) * (1.84 / m.restingSpots.length);
      slots.push({ u, v: vs[k], tag: "rest" });
    });
  }
  return {
    H,
    outer: [P(0, 280), P(H * 0.7, 280), P(H * 0.92, 150), P(H, 150)],
    islands: [{ id: "divider", points: [P(y0, 0), P(y0 + 30, 34), P(y1 - 30, 34), P(y1, 0)] }],
    slots,
    exit: { u: exitU(m.exitSide, 0.5), v: 0.955 },
  };
}

function outerIntervalAt(outer: ProfilePoint[], y: number) {
  const s = sampleProfile(outer, Math.min(outer[outer.length - 1].y, Math.max(0, y)))!;
  return { a: Math.max(-HALF_W, s.cx - s.hw), b: Math.min(HALF_W, s.cx + s.hw), cx: s.cx, hw: s.hw };
}

function slotToXY(bp: Blueprint, s: Slot) {
  const y = s.v * bp.H;
  if (s.abs) return { x: s.u, y };
  const o = outerIntervalAt(bp.outer, y);
  return { x: o.cx + s.u * o.hw, y };
}

export function buildChamber(
  index: number,
  template: TemplateName,
  params: ChamberParams,
  model?: ModelParams,
): ChamberDef {
  const bp = template === "MODEL" ? modelBlueprint(model!) : BLUEPRINTS[template](params);
  const rng = makeRng(params.seed * 7919 + index * 104729);
  const exitXY = slotToXY(bp, { u: bp.exit.u, v: bp.exit.v });
  const exit: Hole = {
    id: "EXIT",
    x: exitXY.x,
    y: exitXY.y,
    r: EXIT_R,
    baseX: exitXY.x,
    baseY: exitXY.y,
    kind: "exit",
    residue: 0,
  };

  const enabled = bp.slots.filter((s) => {
    if (s.tag === "d2") return params.density >= 2;
    if (s.tag === "d3") return params.density >= 3;
    return true;
  });

  const holes: Hole[] = [];
  let n = 1;
  for (const s of enabled) {
    const { x: x0, y: y0 } = slotToXY(bp, s);
    const jitter = s.tag === "rest" || s.follow ? 0 : 1;
    const x = x0 + (rng() - 0.5) * 14 * jitter;
    const y = y0 + (rng() - 0.5) * 14 * jitter;
    if (!holeFits(bp, x, y, HOLE_R)) continue;
    if (Math.hypot(x - exit.x, y - exit.y) < EXIT_R + HOLE_R + 2 * BALL_R + 10) continue;
    if (holes.some((h) => Math.hypot(h.x - x, h.y - y) < 2 * HOLE_R + 2 * BALL_R + 8)) continue;
    holes.push({
      id: `H${String(n++).padStart(2, "0")}`,
      x,
      y,
      r: HOLE_R,
      baseX: x,
      baseY: y,
      kind: "hole",
      follow: s.follow,
      tag: s.tag,
      residue: 0,
    });
  }

  const def: ChamberDef = {
    index,
    template,
    name: CHAMBER_LABEL[template],
    H: bp.H,
    outer: bp.outer,
    islands: bp.islands,
    holes,
    exit,
    params,
    revealHoles: holes.filter((h) => h.tag === "rest").map((h) => h.id),
  };

  // Remove optional holes (latest first) until a route exists. Core holes are authored solvable.
  const removable = () => def.holes.filter((h) => h.tag && h.tag !== "core").reverse();
  let guard = 0;
  while (!isSolvable(def) && guard++ < 20) {
    const victim = removable()[0] ?? def.holes[def.holes.length - 1];
    if (!victim) break;
    def.holes = def.holes.filter((h) => h !== victim);
    def.revealHoles = def.revealHoles.filter((id) => id !== victim.id);
  }
  return def;
}

function holeFits(bp: Blueprint, x: number, y: number, r: number) {
  const ivs = intervalsAt(bp.outer, bp.islands, y);
  return ivs.some((iv) => x - r * 0.4 >= iv.a && x + r * 0.4 <= iv.b);
}

// ---------------------------------------------------------------- solvability
const CELL = 6;

export function captureRadius(h: { r: number }) {
  return h.r - PHYS.captureMargin;
}

/**
 * Grid flood fill over ball-centre positions: a cell is free when the ball fits
 * inside the walls there and is comfortably clear of every hole's capture radius.
 */
export function isSolvable(def: ChamberDef, holes: Hole[] = def.holes, clearance = 7): boolean {
  const cols = Math.ceil((HALF_W * 2) / CELL);
  const rows = Math.ceil(def.H / CELL);
  const free = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = r * CELL + CELL / 2;
    const ivs = intervalsAt(def.outer, def.islands, y);
    for (let c = 0; c < cols; c++) {
      const x = -HALF_W + c * CELL + CELL / 2;
      if (!ivs.some((iv) => x - BALL_R >= iv.a - 0.01 && x + BALL_R <= iv.b + 0.01)) continue;
      let blocked = false;
      for (const h of holes) {
        if (Math.hypot(h.x - x, h.y - y) < captureRadius(h) + clearance) {
          blocked = true;
          break;
        }
      }
      if (!blocked) free[r * cols + c] = 1;
    }
  }
  const startRow = Math.floor((PHYS.barMinY + BALL_R) / CELL);
  const queue: number[] = [];
  const seen = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    const i = startRow * cols + c;
    if (free[i]) {
      queue.push(i);
      seen[i] = 1;
    }
  }
  const goalR = captureRadius(def.exit);
  while (queue.length) {
    const i = queue.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = -HALF_W + c * CELL + CELL / 2;
    const y = r * CELL + CELL / 2;
    if (Math.hypot(def.exit.x - x, def.exit.y - y) < goalR) return true;
    const nb = [i - 1, i + 1, i - cols, i + cols];
    for (const j of nb) {
      if (j < 0 || j >= cols * rows) continue;
      if ((j === i - 1 || j === i + 1) && Math.floor(j / cols) !== r) continue;
      if (seen[j]) continue;
      // the goal cell may be inside the exit even if "free" is false near the top wall
      if (!free[j]) {
        const jr = Math.floor(j / cols);
        const jc = j % cols;
        const jx = -HALF_W + jc * CELL + CELL / 2;
        const jy = jr * CELL + CELL / 2;
        if (Math.hypot(def.exit.x - jx, def.exit.y - jy) >= goalR) continue;
      }
      seen[j] = 1;
      queue.push(j);
    }
  }
  return false;
}

/** Normalized lane of an x position within the chamber's outer interval at y. */
export function laneOf(def: ChamberDef, x: number, y: number): Side {
  const o = outerIntervalAt(def.outer, y);
  const u = (x - o.cx) / Math.max(1, o.hw);
  return u < -0.25 ? "L" : u > 0.25 ? "R" : "C";
}

export function normalizedX(def: ChamberDef, x: number, y: number): number {
  const o = outerIntervalAt(def.outer, y);
  return Math.max(-1, Math.min(1, (x - o.cx) / Math.max(1, o.hw)));
}

export { outerIntervalAt };
