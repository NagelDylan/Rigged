// Chamber QA: runs the autopilot profiles through every template (no RIG
// effects) and prints a template × profile table of clear time and deaths.
//   npx tsx scripts/chamber-check.ts                 quick table (density 2, a few param combos)
//   npx tsx scripts/chamber-check.ts --full          every density / pressureSide / exitSide, 3 seeds
//   npx tsx scripts/chamber-check.ts --detail        add min clearance, near-misses, lane share, stationary %
//   npx tsx scripts/chamber-check.ts --only EYE      restrict to one template
import { Bot, PROFILES } from "../src/engine/bot";
import { buildChamber, captureRadius, isSolvable, laneOf, type ChamberDef, type ChamberParams, type ModelParams } from "../src/engine/chambers";
import { BALL_R, HALF_W, PHYS } from "../src/engine/constants";
import { intervalsAt } from "../src/engine/geometry";
import { Game } from "../src/engine/game";
import { PlayerModel } from "../src/engine/playerModel";
import type { TemplateName } from "../src/shared/rig";

export const ALL_TEMPLATES: TemplateName[] = ["CALIBRATION", "FUNNEL", "SPLITTER", "EYE", "HOURGLASS", "TOWER", "MODEL"];

export interface ChamberRun {
  cleared: boolean;
  timeS: number; // time to clear (or the time limit)
  deaths: number;
  minClear: number; // smallest ball-centre distance outside any capture radius
  nearMiss: number; // separate approaches within 4 u of a capture radius
  lane: { L: number; C: number; R: number };
  stationary: number; // share of time without any motor input
  progress: number;
  style: string; // PlayerModel style label for this run
  wall: { L: number; R: number }; // seconds parked on each outer wall
}

export function modelParamsFor(seed: number, exitSide: "L" | "C" | "R", trapSide: "L" | "R"): ModelParams {
  const spots = new Array(12).fill(0);
  // a plausible resting histogram: mostly near the trap side wall, a bit in the middle
  const k = trapSide === "R" ? 10 + (seed % 2) : 1 - (seed % 2);
  spots[k] = 6;
  spots[5 + (seed % 3)] = 2;
  spots[trapSide === "R" ? 8 : 3] = 1;
  return { trapSide, exitSide, restingSpots: spots, useRestingSpots: true };
}

export function runChamber(
  template: TemplateName,
  params: ChamberParams,
  profileKey: string,
  opts: { maxSeconds?: number; index?: number; model?: ModelParams } = {},
): ChamberRun {
  const maxSeconds = opts.maxSeconds ?? 120;
  const index = opts.index ?? (template === "CALIBRATION" ? 0 : template === "MODEL" ? 4 : 1);
  const model = template === "MODEL" ? (opts.model ?? modelParamsFor(params.seed, params.exitSide, params.pressureSide ?? "R")) : undefined;
  const def = buildChamber(index, template, params, model);
  const game = new Game(def);
  game.nextChamber = () => null;
  const bot = new Bot(PROFILES[profileKey]);
  const pm = new PlayerModel();
  let deaths = 0;
  let minClear = Infinity;
  let nearMiss = 0;
  let inNear = false;
  let stationary = 0;
  let played = 0;
  const lane = { L: 0, C: 0, R: 0 };
  const steps = Math.round(maxSeconds / PHYS.dt);
  for (let i = 0; i < steps; i++) {
    const inp = bot.decide(game);
    game.setInput(inp);
    game.step(PHYS.dt);
    for (const e of game.drainEvents()) {
      if (e.type === "death") deaths++;
      bot.onEvent(e, game);
    }
    if (game.phase === "won") break;
    if (game.phase !== "playing") continue;
    played++;
    pm.sample(game, PHYS.dt);
    if (!inp.lUp && !inp.lDown && !inp.rUp && !inp.rDown) stationary++;
    lane[laneOf(game.chamber, game.ball.x, game.ball.y)]++;
    let c = Infinity;
    for (const h of game.chamber.holes) c = Math.min(c, Math.hypot(h.x - game.ball.x, h.y - game.ball.y) - captureRadius(h));
    minClear = Math.min(minClear, c);
    if (c < 4 && !inNear) nearMiss++;
    inNear = c < 8 && (inNear || c < 4);
  }
  const tot = Math.max(1, lane.L + lane.C + lane.R);
  return {
    cleared: game.phase === "won",
    timeS: game.clock / 1000,
    deaths,
    minClear: Math.max(0, minClear),
    nearMiss,
    lane: { L: lane.L / tot, C: lane.C / tot, R: lane.R / tot },
    stationary: stationary / Math.max(1, played),
    progress: game.progress,
    style: pm.snapshot().style.v.label,
    wall: { ...pm.wall },
  };
}

/**
 * Route tightness: the largest clearance (ball centre to any hole's capture
 * radius) that a path from the bar's start to the exit can keep everywhere.
 * ~15 = a visually tight squeeze, 25–45 = tense but fair, > 60 = wide open.
 */
export function routeBottleneck(def: ChamberDef, cell = 4): number {
  const cols = Math.ceil((HALF_W * 2) / cell);
  const rows = Math.ceil(def.H / cell);
  const n = cols * rows;
  const clr = new Float32Array(n).fill(-1);
  for (let r = 0; r < rows; r++) {
    const y = r * cell;
    if (y < PHYS.barMinY + BALL_R || y > def.H - PHYS.barTopMargin + BALL_R) continue;
    const ivs = intervalsAt(def.outer, def.islands, y);
    for (let c = 0; c < cols; c++) {
      const x = -HALF_W + c * cell + cell / 2;
      if (!ivs.some((iv) => x >= iv.a + BALL_R && x <= iv.b - BALL_R)) continue;
      let m = 999;
      for (const h of def.holes) m = Math.min(m, Math.hypot(h.x - x, h.y - y) - captureRadius(h));
      clr[r * cols + c] = Math.max(0, m);
    }
  }
  // maximin path: add cells from widest to narrowest until start and exit connect
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => clr[i] >= 0);
  order.sort((a, b) => clr[b] - clr[a]);
  const S = n;
  const G = n + 1;
  const par = Int32Array.from({ length: n + 2 }, (_, i) => i);
  const find = (i: number): number => {
    while (par[i] !== i) i = par[i] = par[par[i]];
    return i;
  };
  const on = new Uint8Array(n);
  const startRow = Math.floor((PHYS.barMinY + BALL_R) / cell) + 1;
  const goal = captureRadius(def.exit);
  for (const i of order) {
    on[i] = 1;
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (r <= startRow) par[find(i)] = find(S);
    if (Math.hypot(def.exit.x - (-HALF_W + c * cell + cell / 2), def.exit.y - r * cell) < goal) par[find(i)] = find(G);
    for (const j of [i - 1, i + 1, i - cols, i + cols]) {
      if (j < 0 || j >= n || !on[j] || Math.abs((j % cols) - c) > 1) continue;
      par[find(i)] = find(j);
    }
    if (find(S) === find(G)) return clr[i];
  }
  return 0;
}

export function paramCombos(full: boolean, template: TemplateName): ChamberParams[] {
  const out: ChamberParams[] = [];
  const dens: (1 | 2 | 3)[] = full ? [1, 2, 3] : [2];
  const press: ("L" | "R" | null)[] = template === "MODEL" ? ["L", "R"] : full ? [null, "L", "R"] : [null, "R"];
  const exits: ("L" | "C" | "R")[] = full ? ["L", "C", "R"] : ["L", "R"];
  const seeds = full ? [1, 7, 42] : [3];
  for (const density of dens)
    for (const pressureSide of press)
      for (const exitSide of exits)
        for (const seed of seeds) out.push({ density, pressureSide, exitSide, seed });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const detail = args.includes("--detail");
  const oi = args.indexOf("--only");
  const templates = oi >= 0 ? [args[oi + 1] as TemplateName] : ALL_TEMPLATES;
  const pi = args.indexOf("--profiles");
  const profiles = pi >= 0 ? args[pi + 1].split(",") : Object.keys(PROFILES);
  const t0 = Date.now();
  console.log(`chamber-check ${full ? "FULL" : "quick"} — cell = median clear time / total deaths (fails in brackets)`);
  console.log("template".padEnd(12) + profiles.map((p) => p.padStart(16)).join("") + "   unsolvable  route-gap");
  const failures: string[] = [];
  for (const t of templates) {
    const combos = paramCombos(full, t);
    let unsolvable = 0;
    const gaps: number[] = [];
    for (const c of combos) {
      const m = t === "MODEL" ? modelParamsFor(c.seed, c.exitSide, c.pressureSide ?? "R") : undefined;
      const def = buildChamber(1, t, c, m);
      if (!isSolvable(def)) unsolvable++;
      gaps.push(routeBottleneck(def));
    }
    const cells: string[] = [];
    const details: string[] = [];
    for (const pk of profiles) {
      const runs = combos.map((c) => ({ c, r: runChamber(t, c, pk) }));
      const times = runs.filter((x) => x.r.cleared).map((x) => x.r.timeS).sort((a, b) => a - b);
      const med = times.length ? times[Math.floor(times.length / 2)] : NaN;
      const deaths = runs.reduce((s, x) => s + x.r.deaths, 0);
      const fails = runs.filter((x) => !x.r.cleared);
      for (const f of fails) failures.push(`${t} ${pk} ${JSON.stringify(f.c)} stuck@${f.r.progress.toFixed(2)} deaths=${f.r.deaths}`);
      cells.push(`${Number.isNaN(med) ? "--" : med.toFixed(0) + "s"}/${deaths}d${fails.length ? `[${fails.length}]` : ""}`.padStart(16));
      if (detail) {
        const avg = (f: (r: ChamberRun) => number) => runs.reduce((s, x) => s + f(x.r), 0) / runs.length;
        const minC = Math.min(...runs.map((x) => x.r.minClear));
        details.push(
          `    ${pk.padEnd(11)} max ${Math.max(...runs.map((x) => x.r.timeS)).toFixed(0)}s  minClr ${minC.toFixed(1)}  nearMiss/run ${avg((r) => r.nearMiss).toFixed(1)}  lane L${avg((r) => r.lane.L).toFixed(2)} C${avg((r) => r.lane.C).toFixed(2)} R${avg((r) => r.lane.R).toFixed(2)}  still ${(avg((r) => r.stationary) * 100).toFixed(0)}%  wall L${avg((r) => r.wall.L).toFixed(1)}s R${avg((r) => r.wall.R).toFixed(1)}s  style ${[...new Set(runs.map((x) => x.r.style))].join("/")}`,
        );
      }
    }
    console.log(t.padEnd(12) + cells.join("") + `   ${`${unsolvable}/${combos.length}`.padEnd(11)} ${Math.min(...gaps).toFixed(0)}–${Math.max(...gaps).toFixed(0)}`);
    for (const d of details) console.log(d);
  }
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures.slice(0, 40)) console.log("  " + f);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s wall`);
}

if (process.argv[1]?.endsWith("chamber-check.ts")) main();
