// RIGGED palette — binding tokens from docs/VISUAL_SPEC.md.
// Green (rig*) appears ONLY on things RIG touches. No blue / purple anywhere.
export const PAL = {
  void: "#0A0A09",
  metal0: "#16171A",
  metal1: "#25272B",
  metal2: "#3B3D40",
  metal3: "#5C5D59",
  grime: "#2A251E",
  bone: "#D6CFBE",
  boneDim: "#8E897B",
  amber: "#C98A2B",
  amberDim: "#5E4019",
  red: "#B3302A",
  redDim: "#4E1714",
  rig: "#5EE07C",
  rigDim: "#227A3C",
  rigDeep: "#0C2614",
  ballBody: "#C4C8CC",
  ballShade: "#666B71",
  ballSpec: "#FFFFFF",
} as const;

export type PalKey = keyof typeof PAL;

/** Parse "#RRGGBB" to [r,g,b]. */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix two hex colors (t=0 → a, t=1 → b), returns "#RRGGBB". */
export function mix(a: string, b: string, t: number): string {
  const A = rgb(a);
  const B = rgb(b);
  const c = (i: number) => Math.round(A[i] + (B[i] - A[i]) * t);
  return "#" + ((1 << 24) | (c(0) << 16) | (c(1) << 8) | c(2)).toString(16).slice(1);
}
