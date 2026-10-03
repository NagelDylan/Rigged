// Per-chamber static layer: backboard, plates, seams, rivets, grime, walls,
// side rails, floor hazard band, stencils. Built once (pixel-level, ImageData)
// and blitted every frame.
import { HALF_W } from "../engine/constants";
import { intervalsAt, type Island, type ProfilePoint } from "../engine/geometry";
import { makeRng } from "../engine/rng";
import { drawText, measure } from "./font";
import { PAL, mix, rgb } from "./palette";

export const SIDE = 44; // logical px for each side rail / motor housing column

export interface ChamberLike {
  index: number;
  name: string;
  template: string;
  H: number;
  outer: ProfilePoint[];
  islands: Island[];
  params?: { seed: number };
}

export interface Rivet {
  x: number;
  y: number;
  side: "L" | "R";
}

export interface StaticLayer {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  padBpx: number;
  rivets: Rivet[]; // wall rivets (static coords)
  seamRivets: { x: number; y: number }[];
  conduits: { x0: number; x1: number; y: number }[];
  lampRows: number[]; // static rows of side lamps
  stencil: { x: number; y: number; text: string; scale: number } | null;
  eyeWin: { x: number; y: number; w: number; h: number }; // header window (static coords)
}

export interface StaticOpts {
  s: number; // world→logical scale
  padB: number; // world units of machine below the floor
  padT: number; // world units of header above the top
  stage: number; // infection stage 0..4
  playerTag: string;
}

const C = (hex: string) => rgb(hex);

function hash2(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function buildStatic(ch: ChamberLike, o: StaticOpts): StaticLayer {
  const { s } = o;
  const PW = Math.round(HALF_W * 2 * s);
  const w = PW + SIDE * 2;
  const padBpx = Math.round(o.padB * s);
  const h = Math.round((ch.H + o.padT + o.padB) * s);
  const seed = (ch.params?.seed ?? 1) * 31 + ch.index * 977 + 5;
  const rng = makeRng(seed);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const N = w * h;

  // ---------------------------------------------------------------- mask
  // 1 = inside the chamber (backboard), 0 = solid plate / machine
  const inside = new Uint8Array(N);
  const worldY = (r: number) => (h - padBpx - r - 0.5) / s;
  const worldX = (c: number) => (c - SIDE + 0.5) / s - HALF_W;
  for (let r = 0; r < h; r++) {
    const y = worldY(r);
    if (y < 0 || y > ch.H) continue;
    const ivs = intervalsAt(ch.outer, ch.islands, y);
    for (let c = SIDE; c < SIDE + PW; c++) {
      const x = worldX(c);
      for (const iv of ivs) {
        if (x >= iv.a && x <= iv.b) {
          inside[r * w + c] = 1;
          break;
        }
      }
    }
  }

  // chessboard distance transforms: dOut (outside px → nearest inside), dIn (inside → nearest outside)
  const dOut = new Uint8Array(N);
  const dIn = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    dOut[i] = inside[i] ? 0 : 250;
    dIn[i] = inside[i] ? 250 : 0;
  }
  chamfer(dOut, w, h);
  chamfer(dIn, w, h);

  // ---------------------------------------------------------------- colors
  const cVoid = C(PAL.void);
  const cM0 = C(PAL.metal0);
  const cM1 = C(PAL.metal1);
  const cM2 = C(PAL.metal2);
  const cM3 = C(PAL.metal3);
  const cBrush2 = C(mix(PAL.metal0, PAL.metal1, 0.15));
  const cPlateDark = C(mix(PAL.metal1, PAL.metal0, 0.45));
  const cPlateLite = C(mix(PAL.metal1, PAL.metal2, 0.35));
  const cAmber = C(PAL.amber);
  const cAmberDim = C(PAL.amberDim);
  const cRivet = C(mix(PAL.metal2, PAL.boneDim, 0.6));
  const seamGreen = o.stage >= 2;
  const cSeamHi = C(seamGreen ? mix(PAL.metal2, PAL.rigDim, 0.22) : PAL.metal2);
  const cSeamLo = C(PAL.void);
  const cSide = C(mix(PAL.metal1, PAL.metal0, 0.55));
  // per-plate tone variation (8 levels)
  const toneBase: [number, number, number][] = [];
  const toneBrush: [number, number, number][] = [];
  for (let k = 0; k < 8; k++) {
    const base = mix(PAL.metal0, PAL.metal1, k * 0.035);
    toneBase.push(C(base));
    toneBrush.push(C(mix(base, PAL.metal1, 0.3)));
  }

  const put = (i: number, c: [number, number, number]) => {
    const k = i * 4;
    px[k] = c[0];
    px[k + 1] = c[1];
    px[k + 2] = c[2];
    px[k + 3] = 255;
  };
  const blend = (i: number, c: [number, number, number], a: number) => {
    const k = i * 4;
    px[k] += (c[0] - px[k]) * a;
    px[k + 1] += (c[1] - px[k + 1]) * a;
    px[k + 2] += (c[2] - px[k + 2]) * a;
  };

  // seam grid (static rows / cols)
  const seamStep = 110;
  const seamOff = Math.floor(rng() * 60);
  const isSeamRow = (r: number) => (r + seamOff) % seamStep;
  const vSeamX = (band: number) => {
    const a = SIDE + Math.round(PW * (band % 2 ? 0.37 : 0.62));
    const b = SIDE + Math.round(PW * (band % 2 ? 0.8 : 0.2));
    return [a, b];
  };

  const floorRow = h - padBpx; // first row below the floor (world y < 0)
  const bandPx = Math.max(5, Math.round(6 * s)); // floor hazard band height

  for (let r = 0; r < h; r++) {
    const sr = isSeamRow(r);
    const band = Math.floor((r + seamOff) / seamStep);
    const [vs1, vs2] = vSeamX(band);
    const sLo = Math.min(vs1, vs2);
    const sHi = Math.max(vs1, vs2);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (c < SIDE || c >= SIDE + PW) {
        put(i, cSide);
        continue;
      }
      if (inside[i]) {
        // backboard
        const plate = band * 3 + (c < sLo ? 0 : c < sHi ? 1 : 2);
        const tone = Math.floor(hash2(plate, 7, seed) * 8);
        const brushed = c % 3 === 0 && hash2(c, r >> 4, seed) > 0.2;
        put(i, brushed ? toneBrush[tone] : hash2(c, r >> 3, seed + 1) > 0.93 ? cBrush2 : toneBase[tone]);
        // seams
        if (sr === 0) put(i, cSeamLo);
        else if (sr === 1) put(i, cSeamHi);
        else if (c === vs1 || c === vs2) put(i, cSeamLo);
        else if (c === vs1 + 1 || c === vs2 + 1) put(i, cSeamHi);
        // floor hazard band
        const fr = floorRow - 1 - r; // 0 at the lowest inside row
        if (fr >= 0 && fr < bandPx) {
          put(i, ((c + r) >> 2) & 1 ? cAmberDim : cVoid);
          if (((c + r) >> 2) & 1 && fr > 0 && fr < bandPx - 1) put(i, mixc(cAmber, cAmberDim, 0.35));
        } else if (fr === bandPx) put(i, cM2);
        // inner shadow along walls
        const di = dIn[i];
        if (di === 1) put(i, cVoid);
        else if (di === 2) blend(i, cVoid, 0.55);
        else if (di === 3) blend(i, cVoid, 0.2);
        continue;
      }
      // outside: wall stroke then plate
      const d = dOut[i];
      if (d === 1) put(i, cM3);
      else if (d >= 2 && d <= 5) put(i, d === 2 ? mixc(cM3, cM2, 0.5) : cM2);
      else if (d === 6) put(i, cVoid);
      else {
        const n = hash2(c >> 1, r >> 1, seed + 7);
        put(i, n > 0.97 ? cPlateLite : n < 0.04 ? cPlateDark : cM1);
        // diagonal tread on the solid plate
        if (((c - r) & 7) === 0 && hash2(c >> 3, r >> 3, seed + 9) > 0.5) put(i, cPlateDark);
      }
    }
  }

  // corruption on walls (MODEL): ~15% of wall length in clustered patches
  if (o.stage >= 4) {
    const cRd = C(PAL.rigDim);
    const cRdeep = C(PAL.rigDeep);
    const cR = C(PAL.rig);
    for (let r = 0; r < h; r++)
      for (let c = SIDE; c < SIDE + PW; c++) {
        const i = r * w + c;
        const d = dOut[i];
        if (d < 1 || d > 7) continue;
        if (hash2(c >> 4, r >> 4, seed + 31) > 0.16) continue;
        const q = hash2(c, r, seed + 33);
        if (q < 0.18) put(i, cRd);
        else if (q < 0.3) put(i, cRdeep);
        else if (q < 0.33) put(i, cR);
      }
  }

  // ---------------------------------------------------------------- grime
  // scratches
  const nS = Math.round((PW * h) / 9000);
  const cScr = C(PAL.metal2);
  const cScrHi = C(PAL.metal3);
  for (let k = 0; k < nS; k++) {
    const x0 = SIDE + rng() * PW;
    const y0 = rng() * h;
    const len = 4 + rng() * 16;
    const ang = (rng() < 0.7 ? -0.8 : 0.3) + (rng() - 0.5) * 0.6;
    const hi = rng() < 0.25;
    for (let t = 0; t < len; t++) {
      const c = Math.round(x0 + Math.cos(ang) * t);
      const r = Math.round(y0 + Math.sin(ang) * t);
      if (c < SIDE || c >= SIDE + PW || r < 0 || r >= h) break;
      blend(r * w + c, hi ? cScrHi : cScr, inside[r * w + c] ? 0.45 : 0.3);
    }
  }
  const nG = 9 + Math.floor(rng() * 6);
  const cGrime = C(PAL.grime);
  for (let g = 0; g < nG; g++) {
    const gx = SIDE + rng() * PW;
    const gy = rng() * h;
    const gr = 14 + rng() * 34;
    const ga = 0.2 + rng() * 0.15;
    const stretch = 0.6 + rng() * 1.2;
    for (let r = Math.max(0, Math.floor(gy - gr * stretch)); r < Math.min(h, gy + gr * stretch); r++)
      for (let c = Math.max(SIDE, Math.floor(gx - gr)); c < Math.min(SIDE + PW, gx + gr); c++) {
        const dx = (c - gx) / gr;
        const dy = (r - gy) / (gr * stretch);
        const f = 1 - Math.sqrt(dx * dx + dy * dy);
        if (f <= 0) continue;
        if (hash2(c, r, seed + g) > f * 1.6) continue;
        blend(r * w + c, cGrime, ga * (inside[r * w + c] ? 1 : 0.7) * 2.2);
      }
    // drip streak below some blotches
    if (rng() < 0.5) {
      const dc = Math.round(gx + (rng() - 0.5) * gr);
      const len = 20 + rng() * 60;
      for (let r = Math.floor(gy); r < Math.min(h, gy + len); r++) {
        if (dc < SIDE || dc >= SIDE + PW) break;
        blend(r * w + dc, cGrime, 0.5 * (1 - (r - gy) / len));
      }
    }
  }

  // ---------------------------------------------------------------- side columns
  const lampRows: number[] = [];
  for (const side of [0, 1]) {
    const x0 = side === 0 ? 0 : SIDE + PW;
    const at = (dx: number) => (side === 0 ? x0 + dx : x0 + SIDE - 1 - dx);
    for (let r = 0; r < h; r++) {
      // outer cabinet frame
      put(r * w + at(0), cVoid);
      put(r * w + at(1), cM3);
      put(r * w + at(2), cM2);
      put(r * w + at(3), cM2);
      put(r * w + at(4), cVoid);
      // lamp channel
      put(r * w + at(7), cM0);
      put(r * w + at(8), cM0);
      put(r * w + at(9), cM0);
      put(r * w + at(10), cM0);
      // guide rail (centred)
      const rc = 22;
      put(r * w + at(rc - 3), cVoid);
      put(r * w + at(rc - 2), cM3);
      put(r * w + at(rc - 1), cM2);
      put(r * w + at(rc), cM2);
      put(r * w + at(rc + 1), cM0);
      put(r * w + at(rc + 2), cVoid);
      if (r % 8 === 0)
        for (let k = rc - 6; k <= rc + 5; k++) put(r * w + at(k), k < rc - 3 || k > rc + 2 ? cM2 : cM3);
      if (r % 8 === 1) for (let k = rc - 6; k <= rc + 5; k++) if (k < rc - 3 || k > rc + 2) put(r * w + at(k), cVoid);
      // inner edge
      put(r * w + at(SIDE - 2), cM2);
      put(r * w + at(SIDE - 1), cVoid);
    }
    for (let r = 8; r < h - 2; r += 16) {
      if (side === 0) lampRows.push(r);
      for (let dy = 0; dy < 2; dy++) {
        put((r + dy) * w + at(8), cAmberDim);
        put((r + dy) * w + at(9), cAmberDim);
      }
    }
  }

  // ---------------------------------------------------------------- rivets
  const rivets: Rivet[] = [];
  const seamRivets: { x: number; y: number }[] = [];
  const rivetAt = (c: number, r: number, col: [number, number, number]) => {
    if (c < 1 || r < 1 || c >= w - 2 || r >= h - 2) return;
    put(r * w + c, mixc(col, [255, 255, 255], 0.12));
    put(r * w + c + 1, col);
    put((r + 1) * w + c, col);
    put((r + 1) * w + c + 1, mixc(col, cVoid, 0.4));
    blend((r + 2) * w + c + 1, cVoid, 0.6);
    blend((r + 1) * w + c + 2, cVoid, 0.6);
  };
  // wall rivets every ~14px along the 3rd stroke pixel
  const near = (x: number, y: number) => rivets.some((q) => Math.abs(q.x - x) < 9 && Math.abs(q.y - y) < 9);
  for (let r = 7; r < h; r += 14)
    for (let c = SIDE + 1; c < SIDE + PW - 1; c++) {
      const i = r * w + c;
      if (dOut[i] !== 3) continue;
      if (dOut[i - 1] === 3 && dOut[i + 1] === 3) continue; // horizontal run: handled by column pass
      if (near(c, r)) continue;
      rivets.push({ x: c, y: r, side: c < SIDE + PW / 2 ? "L" : "R" });
    }
  for (let c = SIDE + 7; c < SIDE + PW; c += 14)
    for (let r = 1; r < h - 1; r++) {
      const i = r * w + c;
      if (dOut[i] !== 3) continue;
      if (dOut[i - w] === 3 && dOut[i + w] === 3) continue;
      if (near(c, r)) continue;
      rivets.push({ x: c, y: r, side: c < SIDE + PW / 2 ? "L" : "R" });
    }
  for (const rv of rivets) rivetAt(rv.x - 1, rv.y - 1, cRivet);

  // seam rivets every 22px
  for (let r = 0; r < h; r++) {
    if (isSeamRow(r) !== 0) continue;
    for (let c = SIDE + 11; c < SIDE + PW; c += 22) {
      if (!inside[(r + 3) * w + c] || !inside[Math.max(0, r - 3) * w + c]) continue;
      seamRivets.push({ x: c, y: r - 3 });
      seamRivets.push({ x: c, y: r + 3 });
    }
  }
  for (const sr of seamRivets) rivetAt(sr.x, sr.y, C(PAL.metal2));
  if (o.stage >= 1 && seamRivets.length) {
    // the first green rivet: RIG has touched the machine
    const pick = seamRivets[Math.floor(rng() * seamRivets.length)];
    rivetAt(pick.x, pick.y, C(PAL.rigDim));
    put(pick.y * w + pick.x, C(PAL.rig));
  }

  // rust/oil drips under a few seam rivets
  for (const sr of seamRivets) {
    if (rng() > 0.12) continue;
    const len = 5 + rng() * 16;
    for (let k = 3; k < len; k++) {
      const r = sr.y + k;
      if (r >= h) break;
      blend(r * w + sr.x + 1, cGrime, 0.55 * (1 - k / len));
    }
  }
  // MODEL: RIG's growth on the backboard
  if (o.stage >= 4) {
    const cRd = C(PAL.rigDim);
    const cRdeep = C(PAL.rigDeep);
    for (let k = 0; k < 14; k++) {
      const gx = SIDE + rng() * PW;
      const gy = rng() * h;
      const gr = 4 + rng() * 10;
      for (let r = Math.floor(gy - gr); r < gy + gr; r++)
        for (let c = Math.floor(gx - gr); c < gx + gr; c++) {
          if (r < 0 || r >= h || c < SIDE || c >= SIDE + PW || !inside[r * w + c]) continue;
          const f = 1 - Math.hypot(c - gx, r - gy) / gr;
          if (f <= 0 || hash2(c, r, seed + 77) > f * 0.7) continue;
          put(r * w + c, hash2(c, r, seed + 78) < 0.3 ? cRd : cRdeep);
        }
    }
  }

  // conduits (stage 3+): along a subset of seams, drawn dynamically
  const conduits: { x0: number; x1: number; y: number }[] = [];
  if (o.stage >= 3) {
    for (let r = 0; r < h; r++) {
      if (isSeamRow(r) !== 0 || rng() < 0.35) continue;
      let c = SIDE;
      while (c < SIDE + PW) {
        while (c < SIDE + PW && !inside[(r + 2) * w + c]) c++;
        const a = c;
        while (c < SIDE + PW && inside[(r + 2) * w + c]) c++;
        if (c - a > 30) conduits.push({ x0: a + 3, x1: c - 3, y: r + 2 });
      }
    }
  }

  // ---------------------------------------------------------------- header window (for RIG's eye)
  const ew = 52;
  const eh = 30;
  const eyeWin = { x: Math.round(w / 2 - ew / 2), y: Math.max(4, Math.round((o.padT * s) / 2 - eh / 2)), w: ew, h: eh };
  if (ch.name) for (let r = eyeWin.y - 3; r < eyeWin.y + eh + 3; r++)
    for (let c = eyeWin.x - 3; c < eyeWin.x + ew + 3; c++) {
      if (r < 0 || r >= h) continue;
      const edge = r < eyeWin.y || c < eyeWin.x || r >= eyeWin.y + eh || c >= eyeWin.x + ew;
      put(r * w + c, edge ? (r < eyeWin.y || c < eyeWin.x ? cVoid : cM3) : C(PAL.void));
    }
  if (ch.name) for (const [c, r] of [
    [eyeWin.x - 7, eyeWin.y],
    [eyeWin.x + ew + 5, eyeWin.y],
    [eyeWin.x - 7, eyeWin.y + eh - 2],
    [eyeWin.x + ew + 5, eyeWin.y + eh - 2],
  ])
    rivetAt(c, r, cRivet);

  ctx.putImageData(img, 0, 0);

  // ---------------------------------------------------------------- stencils (text via atlas)
  const num = String(ch.index + 1).padStart(2, "0");
  let label = `CH-${num} // ${ch.name}`;
  if (ch.template === "MODEL") label = `CH-${num} // MODEL OF ${o.playerTag}`;
  let stencil: StaticLayer["stencil"] = null;
  if (ch.name) {
    const yW = Math.max(60, ch.H * 0.06) + 16; // world y of stencil baseline area
    const r = Math.round(h - padBpx - yW * s);
    const ivs = intervalsAt(ch.outer, ch.islands, yW);
    if (ivs.length) {
      const iv = ivs[0];
      const a = SIDE + Math.round((iv.a + HALF_W) * s) + 10;
      const room = Math.round((iv.b - iv.a) * s) - 20;
      let sc = 2;
      if (measure(label, sc) > room) sc = 1;
      drawText(ctx, label, a, r, { color: PAL.metal2, emboss: PAL.metal3, scale: sc });
      stencil = { x: a, y: r, text: label, scale: sc };
    }
    // header plate label
    const hy = eyeWin.y + eh + 8;
    if (hy + 9 < (o.padT * s) - 2) drawText(ctx, label, w / 2, hy, { color: PAL.metal3, emboss: PAL.void, align: "center" });
  }

  return { canvas, w, h, padBpx, rivets, seamRivets, conduits, lampRows, stencil, eyeWin };
}

function mixc(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Two-pass chessboard distance transform (capped at 250). */
function chamfer(d: Uint8Array, w: number, h: number) {
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      let v = d[i];
      if (v === 0) continue;
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (c > 0) v = Math.min(v, d[i - w - 1] + 1);
        if (c < w - 1) v = Math.min(v, d[i - w + 1] + 1);
      }
      d[i] = v;
    }
  for (let r = h - 1; r >= 0; r--)
    for (let c = w - 1; c >= 0; c--) {
      const i = r * w + c;
      let v = d[i];
      if (v === 0) continue;
      if (c < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (c < w - 1) v = Math.min(v, d[i + w + 1] + 1);
        if (c > 0) v = Math.min(v, d[i + w - 1] + 1);
      }
      d[i] = v;
    }
}
