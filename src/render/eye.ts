// RIG's eye: a 13x7 pixel sprite framed by < > brackets. Usable on any 2D canvas.
import { PAL } from "./palette";

export type EyeState = "idle" | "tracking" | "smug" | "annoyed" | "glitch" | "closed" | "offline";

export interface EyeOpts {
  /** 0..1 lid opening override (title screen wake-up). */
  open?: number;
  /** Disable blinking. */
  noBlink?: boolean;
}

const BR_L = ["...", "..#", ".#.", "#..", ".#.", "..#", "..."];

// 7x7 eye bodies. o = outline, i = interior, P = pupil slot rows (pupil drawn separately)
const OPEN = [".......", "..ooo..", ".oiiio.", "oiiiiio", ".oiiio.", "..ooo..", "......."];
const HALF = [".......", ".......", ".ooooo.", "oiiiiio", ".ooooo.", ".......", "......."];
const SMUG = [".......", ".......", "ooooooo", "oiiiiio", ".oooo..", ".......", "......."];
const ANNOY = [".......", "oo.....", ".ooooo.", "oiiiiio", ".oiiio.", "..ooo..", "......."];
const SHUT = [".......", ".......", ".......", "ooooooo", "..o.o..", ".......", "......."];

/** pupil rows (inclusive) per body */
const PUPIL_ROWS: Record<string, [number, number]> = {
  open: [1, 5],
  half: [3, 3],
  smug: [3, 3],
  annoy: [2, 4],
};

const track = new WeakMap<object, { next: number; px: number }>();

function hash(n: number) {
  let x = Math.imul(n ^ 0x5bd1e995, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x165667b1);
  x ^= x >>> 13;
  return ((x >>> 0) % 10000) / 10000;
}

/** 0 = open, 1 = half, 2 = shut — blink every 4–7 s, ~140 ms long. */
function blinkStage(t: number): number {
  const P = 5500;
  const seg = Math.floor(t / P);
  const at = hash(seg + 17) * 1500 - 750 + P / 2;
  const d = (t % P) - at;
  if (d < 0 || d > 150) return 0;
  return d < 40 || d > 110 ? 1 : 2;
}

/**
 * Draw RIG's eye centred at (cx, cy). `scale` = canvas px per eye pixel.
 * `lookX` in -1..1 steers the pupil (tracking jerks every 100 ms).
 */
export function drawEye(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
  state: EyeState,
  t: number,
  lookX: number,
  opts: EyeOpts = {},
) {
  const x0 = Math.round(cx - (13 * scale) / 2);
  const y0 = Math.round(cy - (7 * scale) / 2);
  const offline = state === "offline";
  const cLine = offline ? PAL.metal3 : PAL.rigDim;
  const cBr = offline ? PAL.metal2 : PAL.rigDim;
  const cIn = offline ? PAL.metal1 : PAL.rig;
  const cPupil = offline ? PAL.metal0 : PAL.void;

  // which body
  let body = OPEN;
  let key = "open";
  if (state === "smug") (body = SMUG), (key = "smug");
  else if (state === "annoyed") (body = ANNOY), (key = "annoy");
  else if (state === "closed" || offline) (body = SHUT), (key = "shut");

  if (opts.open !== undefined && key !== "shut") {
    if (opts.open < 0.3) (body = SHUT), (key = "shut");
    else if (opts.open < 0.7) (body = HALF), (key = "half");
  }
  if (!opts.noBlink && key !== "shut" && state !== "glitch") {
    const b = blinkStage(t);
    if (b === 1) (body = HALF), (key = "half");
    else if (b === 2) (body = SHUT), (key = "shut");
  }

  // pupil column (0..3 → interior col 1+px)
  let px: number;
  const want = Math.max(0, Math.min(4, Math.round((lookX + 1) * 2)));
  if (state === "tracking" || state === "annoyed" || state === "smug") {
    let st = track.get(ctx);
    if (!st) track.set(ctx, (st = { next: 0, px: want }));
    if (t >= st.next || t < st.next - 1000) {
      st.px = want;
      st.next = t + 100;
    }
    px = st.px;
  } else if (state === "glitch") {
    px = Math.floor(hash(Math.floor(t / 60)) * 5);
  } else {
    const w = hash(Math.floor(t / 1400) + 3);
    px = w < 0.5 ? 2 : w < 0.75 ? 1 : 3;
  }

  const glitch = state === "glitch";
  const gseed = Math.floor(t / 50);
  const pr = PUPIL_ROWS[key];
  const pw = 1;
  const pcol = 1 + px;

  for (let r = 0; r < 7; r++) {
    let shift = 0;
    if (glitch && hash(gseed * 7 + r) < 0.35) shift = hash(gseed * 13 + r) < 0.5 ? -1 : 1;
    for (let c = 0; c < 13; c++) {
      let col: string | null = null;
      if (c < 3) col = BR_L[r][c] === "#" ? cBr : null;
      else if (c > 9) col = BR_L[r][12 - c] === "#" ? cBr : null;
      else {
        const ec = c - 3;
        const ch = body[r][ec];
        if (ch === "o") col = cLine;
        else if (ch === "i") {
          col = cIn;
          if (pr && r >= pr[0] && r <= pr[1] && ec >= pcol && ec < pcol + pw) col = cPupil;
        }
      }
      if (!col) continue;
      if (glitch) {
        const h = hash(gseed * 101 + r * 13 + c);
        if (h < 0.08) continue;
        if (h > 0.97) col = PAL.bone;
      }
      ctx.fillStyle = col;
      ctx.fillRect(x0 + (c + (c > 2 && c < 10 ? shift : 0)) * scale, y0 + r * scale, scale, scale);
    }
  }
}
