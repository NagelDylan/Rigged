// World units: the playfield is W wide, x ∈ [-W/2, W/2], y up from chamber floor.
export const W = 600;
export const HALF_W = W / 2;
export const BALL_R = 9;
export const HOLE_R = 15;
export const EXIT_R = 19;

export const PHYS = {
  dt: 1 / 120,
  motorSpeed: 128, // u/s at full drive
  motorAccel: 1300, // u/s² ramp up (≈100 ms to full)
  motorDecel: 2400, // u/s² ramp down (≈55 ms to stop)
  maxDiff: 140, // max |yR - yL|
  gravity: 1150, // a = gravity * slope
  damping: 1.9, // linear velocity damping per second
  maxVx: 230,
  deadzoneSlope: 0.006,
  deadzoneVx: 6,
  wallRestitution: 0.35,
  captureMargin: 4, // ball falls when centre within holeR - margin
  captureTicks: 2,
  lipBand: 7, // extra radius beyond capture where the hole lip pulls
  lipPull: 45, // u/s² toward hole centre inside the lip band
  exitAssistR: 40,
  exitAssistPull: 110,
  barMinY: 26,
  barTopMargin: 14,
};

export const TIMING = {
  deathFallMs: 420,
  deathHoldMs: 520, // reaction beat before reset
  resetMs: 380, // bar returns to start
  spawnProtectMs: 2500,
  transitionMs: 1900,
  checkpointHoldMs: 450,
};

/** Minimum telegraph per ability (fairness floor, ms). */
export const MIN_TELEGRAPH = {
  SHIFT: 950,
  PULSE: 1100,
  CRUSH: 1200,
  MAGNET: 1000,
  JAM: 1100,
} as const;
