// RIGGED stamp — an original 5x7 bitmap face. Square shoulders, flat tops,
// slashed zero, chamfered B/D: the look of letters punched into sheet steel.
// Glyphs are rendered once per (color, scale) into an atlas and blitted.

const G: Record<string, string> = {
  A: "##### #...# #...# ##### #...# #...# #...#",
  B: "####. #...# #...# ##### #...# #...# ####.",
  C: "##### #.... #.... #.... #.... #.... #####",
  D: "####. #...# #...# #...# #...# #...# ####.",
  E: "##### #.... #.... ####. #.... #.... #####",
  F: "##### #.... #.... ####. #.... #.... #....",
  G: "##### #.... #.... #.### #...# #...# #####",
  H: "#...# #...# #...# ##### #...# #...# #...#",
  I: "##### ..#.. ..#.. ..#.. ..#.. ..#.. #####",
  J: "....# ....# ....# ....# #...# #...# #####",
  K: "#...# #..#. #.#.. ###.. #..#. #...# #...#",
  L: "#.... #.... #.... #.... #.... #.... #####",
  M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
  N: "#...# ##..# #.#.# #..## #...# #...# #...#",
  O: "##### #...# #...# #...# #...# #...# #####",
  P: "##### #...# #...# ##### #.... #.... #....",
  Q: "##### #...# #...# #...# #.#.# #..#. ###.#",
  R: "##### #...# #...# ####. #..#. #...# #...#",
  S: "##### #.... #.... ##### ....# ....# #####",
  T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  U: "#...# #...# #...# #...# #...# #...# #####",
  V: "#...# #...# #...# #...# .#.#. .#.#. ..#..",
  W: "#...# #...# #...# #.#.# #.#.# ##.## #...#",
  X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
  Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
  Z: "##### ....# ...#. ..#.. .#... #.... #####",
  "0": "##### #...# #..## #.#.# ##..# #...# #####",
  "1": ".##.. #.#.. ..#.. ..#.. ..#.. ..#.. #####",
  "2": "##### ....# ....# ##### #.... #.... #####",
  "3": "##### ....# ....# .#### ....# ....# #####",
  "4": "#...# #...# #...# ##### ....# ....# ....#",
  "5": "##### #.... #.... ####. ....# ....# ####.",
  "6": "##### #.... #.... ##### #...# #...# #####",
  "7": "##### ....# ...#. ..#.. ..#.. ..#.. ..#..",
  "8": "##### #...# #...# .###. #...# #...# #####",
  "9": "##### #...# #...# ##### ....# ....# #####",
  "-": "..... ..... ..... .###. ..... ..... .....",
  "/": "....# ....# ...#. ..#.. .#... #.... #....",
  ":": "..... .##.. .##.. ..... .##.. .##.. .....",
  ".": "..... ..... ..... ..... ..... .##.. .##..",
  ">": ".#... ..#.. ...#. ....# ...#. ..#.. .#...",
  "<": "...#. ..#.. .#... #.... .#... ..#.. ...#.",
  "[": ".###. .#... .#... .#... .#... .#... .###.",
  "]": ".###. ...#. ...#. ...#. ...#. ...#. .###.",
  "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.",
  ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
  "%": "##..# ##..# ...#. ..#.. .#... #..## #..##",
  "#": ".#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.",
  "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
  "?": "##### ....# ....# ..### ..#.. ..... ..#..",
  "'": "..#.. ..#.. ..... ..... ..... ..... .....",
  '"': ".#.#. .#.#. ..... ..... ..... ..... .....",
  ",": "..... ..... ..... ..... ..... .##.. .#...",
  "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
  "=": "..... ..... ##### ..... ##### ..... .....",
  _: "..... ..... ..... ..... ..... ..... #####",
  "*": "..... #.#.# .###. ##### .###. #.#.# .....",
  "|": "..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  "↑": "..#.. .###. #.#.# ..#.. ..#.. ..#.. ..#..",
  "↓": "..#.. ..#.. ..#.. ..#.. #.#.# .###. ..#..",
  "→": "..... ...#. ....# ##### ....# ...#. .....",
  "←": "..... .#... #.... ##### #.... .#... .....",
  "·": "..... ..... ..... .##.. .##.. ..... .....",
  " ": "..... ..... ..... ..... ..... ..... .....",
};
// aliases
G["—"] = G["-"];
G["–"] = G["-"];
G["^"] = G["↑"];

export const GLYPH_W = 5;
export const GLYPH_H = 7;
const ADV = 6; // advance (1px spacing)

const ORDER = Object.keys(G);
const INDEX = new Map<string, number>(ORDER.map((c, i) => [c, i]));

/** Bit rows per glyph for direct pixel use (eye/plates). */
export function glyphBits(ch: string): boolean[][] | null {
  const s = G[ch];
  if (!s) return null;
  return s.split(" ").map((row) => [...row].map((c) => c === "#"));
}

const atlases = new Map<string, HTMLCanvasElement>();

function atlas(color: string, scale: number): HTMLCanvasElement {
  const key = color + "|" + scale;
  let a = atlases.get(key);
  if (a) return a;
  a = document.createElement("canvas");
  a.width = ORDER.length * GLYPH_W * scale;
  a.height = GLYPH_H * scale;
  const c = a.getContext("2d")!;
  c.fillStyle = color;
  ORDER.forEach((ch, gi) => {
    const rows = G[ch].split(" ");
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y];
      let x = 0;
      while (x < GLYPH_W) {
        if (row[x] !== "#") {
          x++;
          continue;
        }
        let e = x;
        while (e < GLYPH_W && row[e] === "#") e++;
        c.fillRect((gi * GLYPH_W + x) * scale, y * scale, (e - x) * scale, scale);
        x = e;
      }
    }
  });
  atlases.set(key, a);
  return a;
}

export interface TextOpts {
  color: string;
  scale?: number;
  /** Stamped look: draws the glyphs once in this color offset by (1,1) underneath. */
  emboss?: string;
  align?: "left" | "center" | "right";
  alpha?: number;
  /** Extra spacing between characters in logical px (before scale). */
  tracking?: number;
}

export function measure(text: string, scale = 1, tracking = 0): number {
  if (!text.length) return 0;
  return (text.length * (ADV + tracking) - 1 - tracking) * scale;
}

/** Draw text at integer logical coordinates (top-left of the glyph box, adjusted by align). */
export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: TextOpts): number {
  const scale = o.scale ?? 1;
  const tr = o.tracking ?? 0;
  const t = text.toUpperCase();
  const w = measure(t, scale, tr);
  let x0 = Math.round(x);
  if (o.align === "center") x0 = Math.round(x - w / 2);
  else if (o.align === "right") x0 = Math.round(x - w);
  const y0 = Math.round(y);
  const prevA = ctx.globalAlpha;
  if (o.alpha !== undefined) ctx.globalAlpha = prevA * o.alpha;
  if (o.emboss) blit(ctx, t, x0 + 1, y0 + 1, atlas(o.emboss, scale), scale, tr);
  blit(ctx, t, x0, y0, atlas(o.color, scale), scale, tr);
  ctx.globalAlpha = prevA;
  return w;
}

function blit(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, a: HTMLCanvasElement, scale: number, tr: number) {
  const gw = GLYPH_W * scale;
  const gh = GLYPH_H * scale;
  for (let i = 0; i < t.length; i++) {
    const gi = INDEX.get(t[i]);
    if (gi !== undefined && t[i] !== " ") ctx.drawImage(a, gi * gw, 0, gw, gh, x + i * (ADV + tr) * scale, y, gw, gh);
  }
}
