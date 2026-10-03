import { describe, expect, it } from "vitest";
import { buildChamber, captureRadius, isSolvable, type ChamberParams } from "../src/engine/chambers";
import { BALL_R, HOLE_R } from "../src/engine/constants";
import { TEMPLATES, type TemplateName } from "../src/shared/rig";
import { ALL_TEMPLATES, modelParamsFor, runChamber } from "../scripts/chamber-check";

const DENSITIES = [1, 2, 3] as const;
const PRESSURE = [null, "L", "R"] as const;
const EXITS = ["L", "C", "R"] as const;
const SEEDS = [1, 7, 42];

function combos(): ChamberParams[] {
  const out: ChamberParams[] = [];
  for (const density of DENSITIES)
    for (const pressureSide of PRESSURE)
      for (const exitSide of EXITS) for (const seed of SEEDS) out.push({ density, pressureSide, exitSide, seed });
  return out;
}

describe("chamber templates", () => {
  const all: TemplateName[] = ["CALIBRATION", ...TEMPLATES];

  it.each(all)("%s builds and is solvable for every parameter combo", (t) => {
    for (const p of combos()) {
      const def = buildChamber(1, t, p);
      expect(def.holes.length, `${t} ${JSON.stringify(p)}`).toBeGreaterThan(3);
      expect(isSolvable(def), `${t} ${JSON.stringify(p)}`).toBe(true);
      // the authored layout should not depend on the solvability fallback removing holes
      expect(isSolvable(def, def.holes, 9), `${t} ${JSON.stringify(p)} comfortable`).toBe(true);
      // holes never overlap the exit or each other
      for (const h of def.holes) {
        expect(Math.hypot(h.x - def.exit.x, h.y - def.exit.y)).toBeGreaterThan(def.exit.r + HOLE_R + 2 * BALL_R);
        for (const q of def.holes) if (q !== h) expect(Math.hypot(h.x - q.x, h.y - q.y)).toBeGreaterThan(2 * captureRadius(h) + 2 * BALL_R);
      }
    }
  });

  it("MODEL builds and is solvable across trap/exit sides and resting spots", () => {
    for (const trapSide of ["L", "R"] as const)
      for (const exitSide of EXITS)
        for (const seed of SEEDS)
          for (const useRestingSpots of [true, false]) {
            const m = { ...modelParamsFor(seed, exitSide, trapSide), useRestingSpots };
            const def = buildChamber(4, "MODEL", { pressureSide: trapSide, density: 2, exitSide, seed }, m);
            expect(isSolvable(def), JSON.stringify(m)).toBe(true);
            if (useRestingSpots) expect(def.revealHoles.length).toBeGreaterThan(0);
          }
    // degenerate histograms
    for (const spots of [new Array(12).fill(0), new Array(12).fill(1), [9, 9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0]]) {
      const def = buildChamber(4, "MODEL", { pressureSide: "R", density: 2, exitSide: "C", seed: 3 }, {
        trapSide: "R",
        exitSide: "C",
        restingSpots: spots,
        useRestingSpots: true,
      });
      expect(isSolvable(def)).toBe(true);
    }
  });
});

describe("autopilot", () => {
  it.each(ALL_TEMPLATES)("LEFT-HUGGER clears %s within 120 s", (t) => {
    const r = runChamber(t, { density: 2, pressureSide: "R", exitSide: "R", seed: 5 }, "left", { maxSeconds: 120 });
    expect(r.cleared, `stuck at progress ${r.progress.toFixed(2)} after ${r.timeS.toFixed(0)}s`).toBe(true);
    expect(r.deaths).toBeLessThanOrEqual(2);
    expect(r.lane.L).toBeGreaterThan(r.lane.R); // personality is visible
  });
});
