// Small cached pixel sprites (holes, ball) and pixel-list helpers.
import { makeRng } from "../engine/rng";
import { PAL, mix } from "./palette";

export interface Sprite {
  c: HTMLCanvasElement;
  /** offset from the sprite's top-left to its centre pixel */
  o: number;
}

const cache = new Map<string, Sprite>();
const listCache = new Map<string, Int16Array>();

function mk(size: number) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

/** Hole: void disc, 2px bevel (top-left lit), inner crescent of depth. */
export function holeSprite(r: number, bevel: "normal" | "red" | "rig" | "bone"): Sprite {
  const key = `h${r.toFixed(2)}${bevel}`;
  let sp = cache.get(key);
  if (sp) return sp;
  const R = Math.ceil(r) + 3;
  const size = R * 2 + 1;
  const c = mk(size);
  const g = c.getContext("2d")!;
  const hi = bevel === "red" ? PAL.red : bevel === "rig" ? PAL.rig : bevel === "bone" ? PAL.bone : PAL.metal3;
  const mid = bevel === "red" ? PAL.redDim : bevel === "rig" ? PAL.rigDim : bevel === "bone" ? PAL.boneDim : PAL.metal2;
  const lo = bevel === "red" ? PAL.redDim : bevel === "rig" ? PAL.rigDeep : PAL.metal0;
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, y);
      const n = d > 0 ? (-x - y) / (d * Math.SQRT2) : 0; // +1 = facing top-left
      let col: string | null = null;
      if (d < r) {
        col = PAL.void;
        // far inner wall catches a little light at bottom-right
        if (d > r - 2.2 && n < -0.35) col = d > r - 1.2 ? PAL.metal1 : mix(PAL.void, PAL.metal1, 0.5);
      } else if (d < r + 2) {
        col = n > 0.25 ? hi : n < -0.25 ? lo : mid;
      } else if (d < r + 3 && n < -0.2) col = mix(PAL.void, PAL.metal0, 0.5);
      if (!col) continue;
      g.fillStyle = col;
      g.fillRect(x + R, y + R, 1, 1);
    }
  sp = { c, o: R };
  cache.set(key, sp);
  return sp;
}

/** Bevel ring pixels (dx,dy pairs) in seeded random order — for pixel-by-pixel takeovers. */
export function ringPixels(r: number, r0: number, r1: number, shuffleSeed = 0): Int16Array {
  const key = `${r.toFixed(2)}|${r0}|${r1}|${shuffleSeed}`;
  let l = listCache.get(key);
  if (l) return l;
  const R = Math.ceil(r + r1) + 1;
  const pts: number[] = [];
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, y);
      if (d >= r + r0 && d < r + r1) pts.push(x, y);
    }
  if (shuffleSeed) {
    const rng = makeRng(shuffleSeed);
    for (let i = pts.length / 2 - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      pts[i * 2] = pts[j * 2];
      pts[i * 2 + 1] = pts[j * 2 + 1];
      pts[j * 2] = ax;
      pts[j * 2 + 1] = ay;
    }
  } else {
    // sort by angle for rotating segment rings
    const idx = [...Array(pts.length / 2).keys()].sort(
      (a, b) => Math.atan2(pts[a * 2 + 1], pts[a * 2]) - Math.atan2(pts[b * 2 + 1], pts[b * 2]),
    );
    const out: number[] = [];
    for (const i of idx) out.push(pts[i * 2], pts[i * 2 + 1]);
    pts.splice(0, pts.length, ...out);
  }
  l = Int16Array.from(pts);
  listCache.set(key, l);
  return l;
}

/** Steel ball: body, lower-right shade crescent, 2x2 spec top-left, 1px void outline. */
export function ballSprite(r: number, tint: "steel" | "red" | "amber" = "steel"): Sprite {
  const key = `b${r.toFixed(2)}${tint}`;
  let sp = cache.get(key);
  if (sp) return sp;
  const R = Math.ceil(r) + 1;
  const size = R * 2 + 1;
  const c = mk(size);
  const g = c.getContext("2d")!;
  const body = tint === "red" ? PAL.red : tint === "amber" ? PAL.amber : PAL.ballBody;
  const shade = tint === "red" ? PAL.redDim : tint === "amber" ? PAL.amberDim : PAL.ballShade;
  const midc = mix(body, shade, 0.5);
  const lc = -r * 0.32; // light centre offset
  for (let y = -R; y <= R; y++)
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, y);
      if (d >= r + 0.5) continue;
      let col: string = body;
      if (d >= r - 0.6) col = PAL.void;
      else {
        const dl = Math.hypot(x - lc, y - lc);
        if (dl > r * 1.12) col = shade;
        else if (dl > r * 0.95) col = midc;
      }
      g.fillStyle = col;
      g.fillRect(x + R, y + R, 1, 1);
    }
  // specular 2x2 (top-left)
  const sx = Math.round(-r * 0.45) + R;
  g.fillStyle = PAL.ballSpec;
  g.fillRect(sx, sx, 2, 2);
  g.fillRect(sx + 2, sx, 1, 1);
  sp = { c, o: R };
  cache.set(key, sp);
  return sp;
}

/** Plain filled disc with outline (shrinking balls etc). */
export function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, fill: string) {
  ctx.fillStyle = fill;
  const R = Math.ceil(r);
  for (let y = -R; y <= R; y++) {
    const hw = Math.sqrt(Math.max(0, r * r - (y + 0.5) * (y + 0.5)));
    const a = Math.round(-hw);
    const b = Math.round(hw);
    if (b > a) ctx.fillRect(cx + a, cy + y, b - a, 1);
  }
}
