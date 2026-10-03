import { HALF_W } from "./constants";

/** A piecewise-linear vertical profile: at height y the shape spans [cx-hw, cx+hw]. */
export interface ProfilePoint {
  y: number;
  cx: number;
  hw: number;
}

export interface Island {
  id: string;
  points: ProfilePoint[]; // first and last should have hw≈0 to form a pointed wedge
}

export interface Interval {
  a: number;
  b: number;
}

export function sampleProfile(points: ProfilePoint[], y: number): { cx: number; hw: number } | null {
  if (points.length === 0) return null;
  if (y < points[0].y || y > points[points.length - 1].y) return null;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    if (y <= p1.y) {
      const span = p1.y - p0.y;
      const t = span <= 0 ? 0 : (y - p0.y) / span;
      return { cx: p0.cx + (p1.cx - p0.cx) * t, hw: p0.hw + (p1.hw - p0.hw) * t };
    }
  }
  const last = points[points.length - 1];
  return { cx: last.cx, hw: last.hw };
}

export interface WallMods {
  crushL: number; // inward offset of the left outer wall
  crushR: number;
}

/** Allowed horizontal intervals at height y (outer shape minus islands, minus crush). */
export function intervalsAt(outer: ProfilePoint[], islands: Island[], y: number, mods?: WallMods): Interval[] {
  const o = sampleProfile(outer, clampY(outer, y));
  if (!o) return [];
  let a = Math.max(-HALF_W, o.cx - o.hw);
  let b = Math.min(HALF_W, o.cx + o.hw);
  if (mods) {
    a += mods.crushL;
    b -= mods.crushR;
  }
  let out: Interval[] = [{ a, b }];
  for (const isl of islands) {
    const s = sampleProfile(isl.points, y);
    if (!s || s.hw <= 0.01) continue;
    const ia = s.cx - s.hw;
    const ib = s.cx + s.hw;
    const next: Interval[] = [];
    for (const iv of out) {
      if (ib <= iv.a || ia >= iv.b) {
        next.push(iv);
        continue;
      }
      if (ia > iv.a) next.push({ a: iv.a, b: ia });
      if (ib < iv.b) next.push({ a: ib, b: iv.b });
    }
    out = next;
  }
  return out.filter((iv) => iv.b - iv.a > 0.5);
}

function clampY(points: ProfilePoint[], y: number) {
  return Math.min(points[points.length - 1].y, Math.max(points[0].y, y));
}

/** Polygon outline (closed, clockwise from bottom-left) for rendering a profile. */
export function profilePolygon(points: ProfilePoint[], step = 8): { x: number; y: number }[] {
  const ys: number[] = [];
  const y0 = points[0].y;
  const y1 = points[points.length - 1].y;
  for (let y = y0; y < y1; y += step) ys.push(y);
  ys.push(y1);
  for (const p of points) ys.push(p.y);
  ys.sort((p, q) => p - q);
  const uniq = ys.filter((y, i) => i === 0 || y - ys[i - 1] > 0.01);
  const left = uniq.map((y) => {
    const s = sampleProfile(points, y)!;
    return { x: Math.max(-HALF_W, s.cx - s.hw), y };
  });
  const right = uniq
    .map((y) => {
      const s = sampleProfile(points, y)!;
      return { x: Math.min(HALF_W, s.cx + s.hw), y };
    })
    .reverse();
  return [...left, ...right];
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
