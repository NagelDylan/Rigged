// RIGGED machine renderer. Pixel art at integer scale: everything is drawn into a
// low-res buffer (1 logical px = PX css px), blitted nearest-neighbour, then a
// light CRT pass runs on the full-res canvas.
import { outerIntervalAt, type ChamberDef, type Hole } from "../engine/chambers";
import { BALL_R, HALF_W, PHYS, TIMING } from "../engine/constants";
import type { Effect, Game } from "../engine/game";
import { drawEye, type EyeState } from "./eye";
import { drawText, measure } from "./font";
import { PAL, mix } from "./palette";
import { ballSprite, disc, holeSprite, ringPixels, type Sprite } from "./sprites";
import { SIDE, buildStatic, type ChamberLike, type StaticLayer } from "./staticLayer";

export type { EyeState } from "./eye";

export interface ViewState {
  infection: number; // 0..1
  eye: EyeState;
  agentView: boolean;
  reducedMotion: boolean;
  playerTag: string;
  chamberCount: number;
  glitch: number; // 0..1 transient
  modelReveal: { holeIds: string[]; startedAt: number } | null;
  deathCaption: string | null;
  banner: { text: string; sub?: string; color: "bone" | "amber" | "red" | "rig"; at: number } | null;
  screen: "game" | "title" | "offline";
}

const PAD_B = 36; // world units of machine base visible under the floor
const PAD_T = 86; // header plate above the chamber top
const BULK = 150; // bulkhead between chambers during transition
const CAM_MIN = -PAD_B * 0.75;
const REVEAL_STEP = 250;
const INTRO_HOLD = 350; // ms framed on the exit at chamber start
const INTRO_END = 1400; // ms when the camera is back on the ball

function hash(n: number) {
  let x = Math.imul((n | 0) ^ 0x5bd1e995, 0x27d4eb2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x165667b1);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function infectionStage(inf: number) {
  return inf < 0.2 ? 0 : inf < 0.45 ? 1 : inf < 0.7 ? 2 : inf < 0.95 ? 3 : 4;
}

/** Stage the UI will set for a chamber (mirrors runtime: MODEL → 1, else min(0.85, idx/4)). */
function guessStage(ch: ChamberDef) {
  return ch.template === "MODEL" ? 4 : infectionStage(Math.min(0.85, ch.index / 4));
}

interface Housing {
  x: number; // left px
  y: number; // top px
  cx: number;
  cy: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buf: HTMLCanvasElement;
  private b: CanvasRenderingContext2D;
  private tint: HTMLCanvasElement | null = null;
  private vignette: HTMLCanvasElement | null = null;

  private k = 4; // device px per logical px
  private LW = 320;
  private LH = 200;
  private s = 1; // world → logical
  private mx = 0; // machine left
  private mw = 0; // machine width
  private px0 = 0; // playfield left
  private PW = 600;

  // camera (world y at screen bottom)
  private camY = CAM_MIN;
  private camV = 0;
  private camChamber: ChamberDef | null = null;
  private lastNow = 0;
  private Y0 = 0; // screen row of world y=0 (plus yOff)
  private yOff = 0;

  private layers = new WeakMap<object, { key: string; layer: StaticLayer }>();
  private titleCh: ChamberLike = {
    index: 0,
    name: "",
    template: "TITLE",
    H: 600,
    outer: [
      { y: 0, cx: 0, hw: 300 },
      { y: 600, cx: 0, hw: 300 },
    ],
    islands: [],
  };

  // transition bookkeeping
  private trans: { from: ChamberDef; to: ChamberDef; camStart: number; yL: number; yR: number; landed: boolean } | null = null;
  private transLanded: ChamberDef | null = null;

  // fx state
  private shakeAmp = 0;
  private lastLife = -1;
  private lastPhase = "";
  private tearAt = -1e9;
  private nextRowShift = 0;
  private rowShiftUntil = 0;
  private rowShift = { y: 0, h: 0, dx: 0 };
  private trace = new Float32Array(240);
  private traceN = 0;
  private traceHead = 0;
  private traceLast = 0;
  private titleStart = -1;
  private offlineStart = -1;
  private bannerShakeAt = -1;
  private revealShakeIdx = -1;
  private gearFrame = { L: 0, R: 0 };
  private curLayer: StaticLayer | null = null;
  private curTop = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.buf = document.createElement("canvas");
    this.b = this.buf.getContext("2d", { alpha: false })!;
    this.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720, window.devicePixelRatio || 1);
  }

  resize(cssW: number, cssH: number, dpr: number) {
    const W = Math.max(1, Math.round(cssW * dpr));
    const H = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    const PX = cssW > 1900 ? 3 : 2;
    this.k = Math.max(1, Math.round(PX * dpr));
    this.LW = Math.ceil(W / this.k);
    this.LH = Math.ceil(H / this.k);
    this.buf.width = this.LW;
    this.buf.height = this.LH;
    this.b.imageSmoothingEnabled = false;
    this.ctx.imageSmoothingEnabled = false;
    this.s = Math.min((this.LW - 2 * SIDE - 6) / (HALF_W * 2), this.LH / 330);
    this.PW = Math.round(HALF_W * 2 * this.s);
    this.mw = this.PW + 2 * SIDE;
    this.mx = Math.floor((this.LW - this.mw) / 2);
    this.px0 = this.mx + SIDE;

    // CRT overlay (scanlines every 2 device px at 10% + vignette to 35%), prebuilt once
    const v = document.createElement("canvas");
    v.width = W;
    v.height = H;
    const vg = v.getContext("2d")!;
    vg.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = 1; y < H; y += 2) vg.fillRect(0, y, W, 1);
    const r = Math.hypot(W, H) / 2;
    const grd = vg.createRadialGradient(W / 2, H / 2, r * 0.55, W / 2, H / 2, r);
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(0,0,0,0.35)");
    vg.fillStyle = grd;
    vg.fillRect(0, 0, W, H);
    this.vignette = v;
    this.tint = null;
  }

  // ================================================================== frame
  render(game: Game, view: ViewState, nowMs: number) {
    const dt = clamp((nowMs - (this.lastNow || nowMs)) / 1000, 0, 0.05);
    this.lastNow = nowMs;
    const b = this.b;
    b.globalAlpha = 1;
    b.fillStyle = PAL.void;
    b.fillRect(0, 0, this.LW, this.LH);
    this.shakeAmp *= Math.pow(0.002, dt);

    if (view.screen === "title") {
      this.offlineStart = -1;
      if (this.titleStart < 0) this.titleStart = nowMs;
      this.drawTitle(view, nowMs);
    } else if (view.screen === "offline") {
      this.titleStart = -1;
      if (this.offlineStart < 0) this.offlineStart = nowMs;
      this.drawOffline(view, nowMs);
    } else {
      this.titleStart = -1;
      this.offlineStart = -1;
      this.drawGame(game, view, nowMs, dt);
    }
    this.drawBanner(view, nowMs);
    this.present(view, nowMs, game);
  }

  // ================================================================== coords
  private sx(x: number) {
    return Math.round(this.px0 + (x + HALF_W) * this.s);
  }
  private sy(y: number) {
    return Math.round(this.Y0 - (y + this.yOff) * this.s);
  }
  private setCam(cam: number) {
    this.Y0 = this.LH + cam * this.s;
  }

  private layerFor(ch: ChamberLike, stage: number, tag: string): StaticLayer {
    const key = `${this.s.toFixed(4)}|${stage}|${tag}`;
    const c = this.layers.get(ch);
    if (c && c.key === key) return c.layer;
    const layer = buildStatic(ch, { s: this.s, padB: PAD_B, padT: PAD_T, stage, playerTag: tag });
    this.layers.set(ch, { key, layer });
    return layer;
  }

  /** Blit a static layer for a chamber whose y=0 is at this.yOff; returns its top screen row. */
  private blitLayer(L: StaticLayer): number {
    const top = Math.round(this.Y0 - this.yOff * this.s) - (L.h - L.padBpx);
    const y0 = Math.max(0, -top);
    const y1 = Math.min(L.h, this.LH - top);
    if (y1 > y0) this.b.drawImage(L.canvas, 0, y0, L.w, y1 - y0, this.mx, top + y0, L.w, y1 - y0);
    return top;
  }

  private camTarget(g: Game, ch: ChamberDef) {
    const viewH = this.LH / this.s;
    let focus = g.ball.y;
    if (g.phase === "resetting") focus = PHYS.barMinY + BALL_R;
    const hi = Math.max(CAM_MIN, ch.H + PAD_T - viewH);
    return clamp(focus - 0.4 * viewH, CAM_MIN, hi);
  }

  /** Camera that frames the exit (exit at ~62% of the view height). */
  private camExit(ch: ChamberDef) {
    const viewH = this.LH / this.s;
    const hi = Math.max(CAM_MIN, ch.H + PAD_T - viewH);
    return clamp(ch.exit.y - 0.62 * viewH, CAM_MIN, hi);
  }

  /** Intro camera: framed on the exit, hold, then ease to the ball by ~1.4s. Null when not in the intro. */
  private introCam(g: Game, ch: ChamberDef, view: ViewState): number | null {
    if (view.reducedMotion || g.phase !== "playing" && g.phase !== "paused") return null;
    const t = g.chamberClock;
    if (t >= INTRO_END) return null;
    const e = easeInOut(clamp((t - INTRO_HOLD) / (INTRO_END - INTRO_HOLD), 0, 1));
    const a = this.camExit(ch);
    return a + (this.camTarget(g, ch) - a) * e;
  }

  // ================================================================== game
  private drawGame(g: Game, view: ViewState, now: number, dt: number) {
    const ch = g.chamber;
    const stage = infectionStage(view.infection);

    // chamber change bookkeeping
    if (this.camChamber !== ch) {
      const intro = this.introCam(g, ch, view);
      if (intro !== null) {
        this.camY = intro;
      } else if (this.transLanded === ch) {
        this.camY = CAM_MIN;
      } else {
        this.camY = this.camTarget(g, ch);
      }
      this.camV = 0;
      this.camChamber = ch;
      this.transLanded = null;
      this.traceN = 0;
    }
    if (g.life !== this.lastLife) {
      if (g.phase === "dying" && this.lastLife >= 0) {
        this.tearAt = now;
        this.kick(view, 3);
      }
      this.lastLife = g.life;
    }
    if (g.phase !== this.lastPhase) {
      if (g.phase === "checkpoint") this.kick(view, 1.5);
      if (g.phase === "playing" && this.lastPhase === "resetting") this.traceN = 0;
      this.lastPhase = g.phase;
    }

    if (g.phase === "transition" && g.pendingChamber) {
      this.drawTransition(g, view, now, stage);
      return;
    }
    this.trans = null;

    // pre-build the next chamber's layer during the checkpoint hold (no transition hitch)
    if (g.phase === "checkpoint" && g.pendingChamber && g.phaseT > 220)
      this.layerFor(g.pendingChamber, guessStage(g.pendingChamber), view.playerTag);

    // camera: exit intro, then critically damped follow
    const intro = this.introCam(g, ch, view);
    if (intro !== null) {
      this.camY = intro;
      this.camV = 0;
    } else {
      const target = this.camTarget(g, ch);
      const w = 6.5;
      const a = w * w * (target - this.camY) - 2 * w * this.camV;
      this.camV += a * dt;
      this.camY += this.camV * dt;
    }
    this.setCam(this.camY);
    this.yOff = 0;

    const L = this.layerFor(ch, stage, view.playerTag);
    const top = this.blitLayer(L);
    this.curLayer = L;
    this.curTop = top;
    this.drawMargins();
    this.drawInfection(L, top, stage, now, g.chamberClock);
    if (view.agentView) this.drawLanes(ch);

    const hidden = this.revealHidden(view, now);
    this.drawHoles(g, ch, now, hidden, view);
    this.drawExit(ch.exit, now, g.phase === "checkpoint", ch.H);
    this.drawCrush(g, ch, now);

    for (const e of g.effects) if (e.phase !== "done" && e.phase !== "armed") this.drawEffectUnder(g, e, now, view);

    this.drawHeaderEye(L, top, view, now, g.ball.x / HALF_W);

    // bar
    let yL = g.bar.yL;
    let yR = g.bar.yR;
    if (g.phase === "resetting") {
      const t = easeInOut(clamp(g.phaseT / TIMING.resetMs, 0, 1));
      yL += (PHYS.barMinY - yL) * t;
      yR += (PHYS.barMinY - yR) * t;
    }
    const hs = this.drawBarAndMotors(g, yL, yR, now, view, stage, L, top);

    // ball
    this.drawBall(g, view, now, yL, yR);

    for (const e of g.effects) if (e.phase !== "done" && e.phase !== "armed") this.drawEffectOver(g, e, now, view, hs);
    if (view.agentView) this.drawAgent(g, now);

    if (g.phase === "dying") this.drawDeath(g, now, view);
    if (g.phase === "checkpoint" || g.phase === "won") this.drawCheckpoint(g, now, L, top);
    if (g.phase === "playing" || g.phase === "paused") this.drawExitIndicator(g, now);

    // death tear (1 frame)
    if (!view.reducedMotion && now - this.tearAt < 34) {
      const ty = Math.round(this.LH * (0.3 + hash(Math.floor(this.tearAt)) * 0.4));
      const th = 6 + Math.round(hash(Math.floor(this.tearAt) + 1) * 10);
      this.b.drawImage(this.buf, 0, ty, this.LW, th, 7, ty, this.LW, th);
      this.b.fillStyle = PAL.red;
      this.b.fillRect(0, ty, 7, th);
    }
    if (view.deathCaption && (g.phase === "dying" || g.phase === "resetting")) this.drawCaption(view.deathCaption, now);
  }

  private kick(view: ViewState, amp: number) {
    if (!view.reducedMotion) this.shakeAmp = Math.max(this.shakeAmp, amp);
  }

  private drawMargins() {
    const b = this.b;
    if (this.mx > 0) {
      b.fillStyle = PAL.metal0;
      b.fillRect(0, 0, this.mx, this.LH);
      b.fillRect(this.mx + this.mw, 0, this.LW - this.mx - this.mw, this.LH);
    }
  }

  private revealHidden(view: ViewState, now: number): Set<string> | null {
    const mr = view.modelReveal;
    if (!mr) return null;
    const set = new Set<string>();
    mr.holeIds.forEach((id, i) => {
      if (now < mr.startedAt + i * REVEAL_STEP) set.add(id);
      else if (now - (mr.startedAt + i * REVEAL_STEP) < 40 && this.revealShakeIdx !== i) {
        this.revealShakeIdx = i;
        this.kick(view, 2);
      }
    });
    return set;
  }

  // ================================================================== infection
  private drawInfection(L: StaticLayer, top: number, stage: number, now: number, chamberClock: number) {
    const b = this.b;
    if (stage >= 2 && L.stencil) {
      const P = 2700;
      const seg = Math.floor(now / P);
      if (now % P < 180) {
        const st = L.stencil;
        const i = Math.floor(hash(seg) * st.text.length);
        const chr = st.text[i];
        if (chr && chr !== " ") {
          const x = this.mx + st.x + i * 6 * st.scale;
          drawText(b, chr, x, top + st.y, { color: PAL.rig, scale: st.scale });
        }
      }
    }
    if (stage >= 3) {
      const creep = clamp(0.25 + chamberClock / 40000, 0, 1);
      for (let i = 0; i < L.conduits.length; i++) {
        const c = L.conduits[i];
        const y = top + c.y;
        if (y < 0 || y >= this.LH) continue;
        const len = Math.round((c.x1 - c.x0) * creep);
        const fromRight = i % 2 === 1;
        const xa = this.mx + (fromRight ? c.x1 - len : c.x0);
        b.fillStyle = PAL.rigDeep;
        b.fillRect(xa, y, len, 1);
        b.fillStyle = PAL.rigDim;
        for (let x = 0; x < len; x += 5) b.fillRect(xa + x, y, 2, 1);
        // travelling pulse
        const p = ((now / 1800 + i * 0.37) % 1) * len;
        b.fillStyle = PAL.rig;
        b.fillRect(fromRight ? this.mx + c.x1 - p : xa + p, y, 1, 1);
        b.fillRect(fromRight ? this.mx + c.x1 - len : xa + len, y, 1, 1);
      }
    }
  }

  // ================================================================== holes
  private drawHoles(g: Game, ch: ChamberDef, now: number, hidden: Set<string> | null, view: ViewState) {
    const b = this.b;
    const dying = g.phase === "dying" ? g.ball.fallingInto : null;
    let touchedIds: Set<string> | null = null;
    for (const e of g.effects)
      if (e.holeId && e.phase !== "armed" && e.phase !== "done") (touchedIds ??= new Set()).add(e.holeId);
    if (dying) (touchedIds ??= new Set()).add(dying.id);
    for (const h of ch.holes) {
      const x = this.sx(h.x);
      const y = this.sy(h.y);
      const rp = h.r * this.s;
      if (y < -rp - 20 || y > this.LH + rp + 20) continue;
      if (hidden && hidden.has(h.id)) continue;
      let bevel: "normal" | "red" | "bone" = "normal";
      if (dying === h && g.ball.fallT < 520 && Math.floor(g.ball.fallT / 70) % 2 === 0) bevel = "red";
      // MODEL reveal clang flash
      let flash = -1;
      if (view.modelReveal) {
        const i = view.modelReveal.holeIds.indexOf(h.id);
        if (i >= 0) {
          flash = now - (view.modelReveal.startedAt + i * REVEAL_STEP);
          if (flash < 90) bevel = "bone";
        }
      }
      const sp = holeSprite(rp, bevel);
      b.drawImage(sp.c, x - sp.o, y - sp.o);
      if (flash >= 0 && flash < 260) {
        const rr = rp + 3 + flash / 18;
        const ring = ringPixels(Math.round(rr), 0, 1, 0);
        b.fillStyle = flash < 120 ? PAL.bone : PAL.boneDim;
        for (let i = 0; i < ring.length; i += 4) b.fillRect(x + ring[i], y + ring[i + 1], 1, 1);
      }
      // residue
      if (h.residue > 0) {
        const n = h.residue * 4;
        const seed = hashStr(h.id);
        for (let i = 0; i < n; i++) {
          const ang = hash(seed + i * 7) * Math.PI * 2;
          const rr = rp + 0.5 + hash(seed + i * 13) * 4;
          b.fillStyle = hash(seed + i * 3) < 0.25 ? PAL.rig : PAL.rigDim;
          b.fillRect(Math.round(x + Math.cos(ang) * rr), Math.round(y + Math.sin(ang) * rr), 1, 1);
        }
      }
      const touched = view.agentView || h.residue > 0 || (touchedIds !== null && touchedIds.has(h.id));
      drawText(b, h.id, x, y + Math.ceil(rp) + 4, { color: PAL.boneDim, alpha: touched ? 0.6 : 0.14, align: "center" });
    }
  }

  private drawExit(ex: Hole, now: number, taken: boolean, chH: number) {
    const b = this.b;
    const x = this.sx(ex.x);
    const y = this.sy(ex.y);
    const rp = ex.r * this.s;
    if (y < -60 || y > this.LH + 60) return;
    const sp = holeSprite(rp, "normal");
    b.drawImage(sp.c, x - sp.o, y - sp.o);
    // ring of 8 bone segments, stepping every 125ms
    const R0 = Math.round(rp) + 3;
    const ring = ringPixels(R0, 0, 4, 0);
    const step = Math.floor(now / 125);
    const n = ring.length / 2;
    const segCol = taken ? PAL.amber : PAL.bone;
    for (let i = 0; i < n; i++) {
      const dx = ring[i * 2];
      const dy = ring[i * 2 + 1];
      const ang = Math.atan2(dy, dx) + Math.PI;
      const f = (((ang / (Math.PI * 2)) * 8 + step / 4) % 1 + 1) % 1;
      const d = Math.hypot(dx, dy) - R0;
      let col: string;
      if (f < 0.62) col = d < 0.8 ? PAL.void : d > 3 ? (taken ? PAL.amberDim : PAL.boneDim) : segCol;
      else col = PAL.void;
      b.fillStyle = col;
      b.fillRect(x + dx, y + dy, 1, 1);
    }
    // 4 inward chevrons, pulsing
    const pulse = Math.floor(now / 160) % 3;
    const d0 = R0 + 10 + (2 - pulse) * 2;
    for (let q = 0; q < 4; q++) {
      for (let j = 0; j < CHEV.length; j++) {
        const [cx, cy] = CHEV[j];
        let px = cx;
        let py = cy - d0;
        for (let r = 0; r < q; r++) {
          const t = px;
          px = -py;
          py = t;
        }
        b.fillStyle = j < 7 ? (taken ? PAL.amber : PAL.bone) : PAL.boneDim;
        b.fillRect(x + px, y + py, 1, 1);
      }
    }
    // stamp + lamp
    // stamp above the ring; beside it when the chamber ceiling is too close
    let ty = y - R0 - 30;
    let lx = x - 17;
    let tx = x + 3;
    let align: "center" | "left" | "right" = "center";
    if (ty < this.sy(chH) + 4) {
      ty = y - 3;
      const right = ex.x <= 0;
      align = right ? "left" : "right";
      tx = right ? x + R0 + 27 : x - R0 - 27;
      lx = right ? x + R0 + 20 : x - R0 - 24;
    }
    drawText(b, "EXIT", tx, ty, { color: PAL.bone, emboss: PAL.void, align });
    const lampOn = Math.floor(now / 400) % 2 === 0;
    b.fillStyle = PAL.void;
    b.fillRect(lx - 1, ty - 1, 6, 9);
    b.fillStyle = lampOn ? PAL.amber : PAL.amberDim;
    b.fillRect(lx, ty, 4, 7);
    if (lampOn) {
      b.fillStyle = mix(PAL.amber, PAL.bone, 0.5);
      b.fillRect(lx, ty + 1, 1, 1);
    }
  }

  // ================================================================== crush
  private crushAmounts(g: Game) {
    let L = g.crush.L;
    let R = g.crush.R;
    for (const e of g.effects) {
      if (e.order.ability !== "CRUSH" || !e.crushSide || e.depth === undefined) continue;
      let d = 0;
      if (e.phase === "active") d = Math.min(e.depth, (e.t / 1000) * 75);
      else if (e.phase === "release") d = Math.max(0, e.depth - (e.t / 1000) * 70);
      if (e.crushSide === "L") L = Math.max(L, d);
      else R = Math.max(R, d);
    }
    return { L, R };
  }

  private drawCrush(g: Game, ch: ChamberDef, now: number) {
    const cr = this.crushAmounts(g);
    if (cr.L <= 0.5 && cr.R <= 0.5) return;
    const b = this.b;
    const s = this.s;
    void now;
    for (let row = 0; row < this.LH; row++) {
      const y = (this.Y0 - row - 0.5) / s - this.yOff;
      if (y < 0 || y > ch.H) continue;
      const o = outerIntervalAt(ch.outer, y);
      const room = Math.max(0, o.b - o.a - 7 * BALL_R);
      for (const side of [-1, 1] as const) {
        const amt = Math.floor(Math.min(side < 0 ? cr.L : cr.R, room / 2) * s);
        if (amt < 1) continue;
        const wall = side < 0 ? this.sx(o.a) : this.sx(o.b);
        const face = wall - side * amt; // leading edge
        const xa = Math.min(wall, face);
        const xb = Math.max(wall, face);
        b.fillStyle = row % 6 === 0 ? PAL.metal2 : row % 6 === 1 ? PAL.void : PAL.metal1;
        b.fillRect(xa - (side < 0 ? 6 : 0), row, xb - xa + 6, 1);
        // hazard band on the leading face
        for (let k = 1; k <= 7; k++) {
          const xx = face + side * k;
          b.fillStyle = ((xx + row) >> 2) & 1 ? PAL.rigDim : PAL.void;
          b.fillRect(xx, row, 1, 1);
        }
        b.fillStyle = PAL.metal3;
        b.fillRect(face + side * 8, row, 1, 1);
        b.fillStyle = PAL.metal3;
        b.fillRect(face, row, 1, 1);
        b.fillStyle = PAL.void;
        b.fillRect(face - side, row, 1, 1);
        b.globalAlpha = 0.5;
        b.fillRect(face - side * 2, row, 1, 1);
        b.globalAlpha = 1;
        if (row % 14 === 7) {
          b.fillStyle = PAL.rig;
          b.fillRect(face + side * 11 - (side < 0 ? 1 : 0), row, 2, 2);
        }
      }
    }
  }

  // ================================================================== effects
  private holeById(g: Game, id?: string) {
    if (!id) return null;
    return g.chamber.holes.find((h) => h.id === id) ?? null;
  }

  private bracket(x0: number, y0: number, x1: number, y1: number, col: string, arm = 4) {
    const b = this.b;
    b.fillStyle = col;
    b.fillRect(x0, y0, arm, 1);
    b.fillRect(x0, y0, 1, arm);
    b.fillRect(x1 - arm + 1, y0, arm, 1);
    b.fillRect(x1, y0, 1, arm);
    b.fillRect(x0, y1, arm, 1);
    b.fillRect(x0, y1 - arm + 1, 1, arm);
    b.fillRect(x1 - arm + 1, y1, arm, 1);
    b.fillRect(x1, y1 - arm + 1, 1, arm);
  }

  private countdown(x0: number, y: number, w: number, p: number) {
    const b = this.b;
    b.fillStyle = PAL.rigDeep;
    b.fillRect(x0, y, w, 3);
    b.fillStyle = PAL.rig;
    b.fillRect(x0, y, Math.max(0, Math.round(w * (1 - p))), 3);
  }

  private sprinkle(seed: number, x: number, y: number, r: number, n: number, now: number) {
    const b = this.b;
    const fr = Math.floor(now / 90);
    for (let i = 0; i < n; i++) {
      const ang = hash(seed + i * 31 + (i % 3 === 0 ? fr : 0)) * Math.PI * 2;
      const rr = r + hash(seed + i * 17) * 3;
      b.fillStyle = i % 4 === 0 ? PAL.rig : PAL.rigDim;
      b.fillRect(Math.round(x + Math.cos(ang) * rr), Math.round(y + Math.sin(ang) * rr), 1, 1);
    }
  }

  private drawEffectUnder(g: Game, e: Effect, now: number, view: ViewState) {
    const b = this.b;
    const tele = e.phase === "telegraph";
    const ab = e.order.ability;
    if (ab === "SHIFT") {
      const h = this.holeById(g, e.holeId);
      if (!h) return;
      const rp = h.r * this.s;
      let x = this.sx(h.x);
      const y = this.sy(h.y);
      const p = tele ? e.progress : 1;
      if (tele && p > 0.55 && !view.reducedMotion) {
        x += hash(Math.floor(now / 50)) < 0.5 ? -1 : 1;
        const sp = holeSprite(rp, "normal");
        b.drawImage(sp.c, x - sp.o, y - sp.o);
      }
      const ring = ringPixels(rp, 0, 2, 101 + e.id);
      const n = Math.floor((ring.length / 2) * (e.phase === "release" ? 1 - clamp(e.t / 800, 0, 1) : p));
      b.fillStyle = PAL.rig;
      for (let i = 0; i < n; i++) b.fillRect(x + ring[i * 2], y + ring[i * 2 + 1], 1, 1);
      this.sprinkle(e.id * 97, x, y, rp + 2, Math.round(4 + p * 14), now);
      if (e.to && e.phase !== "release") {
        const tx = this.sx(e.to.x);
        const dir = Math.sign(tx - x) || 1;
        const march = Math.floor(now / 70) % 4;
        b.fillStyle = PAL.rigDim;
        for (let xx = x + dir * (Math.ceil(rp) + 4 + march); dir > 0 ? xx < tx - rp - 2 : xx > tx + rp + 2; xx += dir * 4)
          b.fillRect(xx, y, 2, 1);
        // arrow head at the ghost
        const ax = tx - dir * (Math.ceil(rp) + 4);
        b.fillRect(ax - dir, y - 1, 1, 3);
        b.fillRect(ax - dir * 2, y - 2, 1, 5);
        // ghost destination outline
        const gr = ringPixels(rp, 0, 2, 0);
        const blink = tele ? Math.floor(now / 120) % 2 : 0;
        b.fillStyle = blink ? PAL.rig : PAL.rigDim;
        for (let i = 0; i < gr.length / 2; i += 2) b.fillRect(tx + gr[i * 2], y + gr[i * 2 + 1], 1, 1);
      }
    } else if (ab === "MAGNET") {
      const h = this.holeById(g, e.holeId);
      if (!h) return;
      const rp = h.r * this.s;
      const x = this.sx(h.x);
      const y = this.sy(h.y);
      const ring = ringPixels(Math.round(rp) + 5, 0, 1, 0);
      const rot = Math.floor(now / 70);
      const nr = ring.length / 2;
      b.fillStyle = e.phase === "active" ? PAL.rig : PAL.rigDim;
      for (let i = 0; i < nr; i++) if ((i + rot) % 4 !== 0 || e.phase === "active") b.fillRect(x + ring[i * 2], y + ring[i * 2 + 1], 1, 1);
      if (e.phase !== "release") {
        // 12 pixels spiralling inward, 600ms loop
        for (let i = 0; i < 12; i++) {
          const ph = (now / 600 + i / 12) % 1;
          const r = 30 * (1 - ph);
          const ang = (i / 12) * Math.PI * 2 + ph * Math.PI * 1.6;
          b.fillStyle = i % 2 ? PAL.rig : PAL.rigDim;
          b.fillRect(Math.round(x + Math.cos(ang) * (r + rp * 0.3)), Math.round(y + Math.sin(ang) * (r + rp * 0.3)), 1, 1);
        }
      }
      if (e.phase === "active" && g.phase === "playing") {
        const bx = this.sx(g.ball.x);
        const by = this.sy(g.ball.y);
        const n = Math.max(Math.abs(bx - x), Math.abs(by - y));
        b.fillStyle = PAL.rigDim;
        const off = Math.floor(now / 50) % 3;
        for (let i = off; i < n; i += 3) b.fillRect(Math.round(x + ((bx - x) * i) / n), Math.round(y + ((by - y) * i) / n), 1, 1);
      }
      if (tele) this.sprinkle(e.id * 97, x, y, rp + 2, Math.round(4 + e.progress * 12), now);
    } else if (ab === "CRUSH" && e.crushSide) {
      const ch = g.chamber;
      const side = e.crushSide === "L" ? -1 : 1;
      const depth = e.depth ?? 60;
      const stripes = tele || e.phase === "active";
      const by = this.sy(g.ball.y);
      for (let row = 0; row < this.LH; row++) {
        const y = (this.Y0 - row - 0.5) / this.s - this.yOff;
        if (y < 0 || y > ch.H) continue;
        const o = outerIntervalAt(ch.outer, y);
        const room = Math.max(0, o.b - o.a - 7 * BALL_R);
        const wall = side < 0 ? this.sx(o.a) : this.sx(o.b);
        if (stripes && tele) {
          // rig/void hazard stripes on the wall face
          const mv = Math.floor(now / 90);
          for (let k = 1; k <= 5; k++) {
            const xx = wall + side * k;
            if (((xx + row + mv) >> 2) & 1) {
              b.fillStyle = PAL.rigDim;
              b.fillRect(xx, row, 1, 1);
            }
          }
        }
        // piston line at max travel
        if (row % 2 === 0 && e.phase !== "release") {
          const px = wall - side * Math.round(Math.min(depth, room / 2) * this.s);
          b.fillStyle = PAL.rigDim;
          b.fillRect(px, row, 1, 1);
        }
      }
      if (tele) {
        // wall rivets turn green
        const L = this.curLayer;
        if (L) {
          for (let i = 0; i < L.rivets.length; i++) {
            const rv = L.rivets[i];
            if (rv.side !== e.crushSide || hash(i * 7 + e.id) > e.progress * 1.3) continue;
            const ry = this.curTop + rv.y;
            if (ry < -2 || ry > this.LH) continue;
            b.fillStyle = PAL.rig;
            b.fillRect(this.mx + rv.x - 1, ry - 1, 2, 2);
          }
        }
        const wallX = side < 0 ? this.sx(outerIntervalAt(ch.outer, g.ball.y).a) : this.sx(outerIntervalAt(ch.outer, g.ball.y).b);
        const pd = Math.round(depth * this.s);
        const x0 = side < 0 ? wallX - 7 : wallX - pd - 2;
        const x1 = side < 0 ? wallX + pd + 2 : wallX + 7;
        this.bracket(x0, by - 40, x1, by + 40, PAL.rig, 5);
        this.countdown(x0, by + 44, x1 - x0 + 1, e.progress);
      }
    }
  }

  private drawEffectOver(g: Game, e: Effect, now: number, view: ViewState, hs: { L: Housing; R: Housing }) {
    const b = this.b;
    const tele = e.phase === "telegraph";
    const ab = e.order.ability;
    if ((ab === "SHIFT" || ab === "MAGNET") && tele) {
      const h = this.holeById(g, e.holeId);
      if (!h) return;
      const rp = Math.ceil(h.r * this.s);
      const x = this.sx(h.x);
      const y = this.sy(h.y);
      const m = rp + 6;
      this.bracket(x - m, y - m, x + m, y + m, PAL.rig);
      this.countdown(x - m, y + m + 3, 2 * m + 1, e.progress);
      if (view.agentView) drawText(b, `${ab} ${h.id}`, x + m + 4, y - m, { color: PAL.rig });
    } else if (ab === "PULSE" && e.dir) {
      const dir = e.dir;
      const by = this.sy(g.ball.y);
      const bx = this.sx(g.ball.x);
      if (tele) {
        const march = Math.floor(now / 70) % 6;
        const glyph = dir > 0 ? ">" : "<";
        for (const railX of [this.mx + 8, this.mx + this.mw - 30]) {
          for (let r = -1; r <= 1; r++) {
            const yy = by - 52 + r * 10;
            for (let c = 0; c < 3; c++) {
              const xx = railX + c * 6 + (dir > 0 ? march : -march);
              drawText(b, glyph, xx, yy, { color: c === (Math.floor(now / 90) % 3) ? PAL.rig : PAL.rigDim });
            }
          }
        }
        // chevrons over the ball and bracket
        const rb = Math.ceil(BALL_R * this.s);
        const m = rb + 5;
        this.bracket(bx - m, by - m, bx + m, by + m, PAL.rig, 3);
        this.countdown(bx - m, by - m - 6, 2 * m + 1, e.progress);
        const t3 = dir > 0 ? ">>>" : "<<<";
        drawText(b, t3, bx + dir * (m + 4) + (dir > 0 ? 0 : -17) + (dir > 0 ? march / 2 : -march / 2), by - 3, { color: PAL.rig });
      } else if (e.phase === "active") {
        const p = clamp(e.t / e.activeMs, 0, 1);
        for (let k = 0; k < 3; k++) {
          const pp = clamp(p - k * 0.06, 0, 1);
          const x = dir > 0 ? this.px0 + Math.round(pp * this.PW) : this.px0 + this.PW - Math.round(pp * this.PW);
          b.fillStyle = k === 0 ? PAL.rig : PAL.rigDim;
          b.globalAlpha = k === 0 ? 1 : 0.6 - k * 0.2;
          b.fillRect(x, 0, 1, this.LH);
        }
        b.globalAlpha = 1;
      }
    } else if (ab === "JAM" && e.motor) {
      const hsg = hs[e.motor];
      if (tele) {
        this.bracket(hsg.x - 4, hsg.y - 4, hsg.x + 15, hsg.y + 21, PAL.rig, 3);
        this.countdown(hsg.x - 4, hsg.y + 24, 20, e.progress);
      }
      if (tele || e.phase === "active") {
        // sparks: amber + green
        const n = e.phase === "active" ? 7 : 3;
        const fr = Math.floor(now / 45);
        for (let i = 0; i < n; i++) {
          if (hash(fr * 13 + i) < 0.4) continue;
          const ang = hash(fr * 7 + i * 3) * Math.PI * 2;
          const r = 8 + hash(fr * 5 + i) * 9;
          b.fillStyle = i % 2 ? PAL.amber : PAL.rig;
          b.fillRect(Math.round(hsg.cx + Math.cos(ang) * r), Math.round(hsg.cy + Math.sin(ang) * r), 1, 1);
        }
      }
      if (view.agentView && tele) drawText(b, "JAM " + e.motor, hsg.x - 4, hsg.y - 13, { color: PAL.rig });
    } else if (ab === "CRUSH" && view.agentView && tele) {
      drawText(b, "CRUSH " + e.crushSide, this.px0 + (e.crushSide === "L" ? 8 : this.PW - 50), 14, { color: PAL.rig });
    }
  }

  // ================================================================== bar + motors
  private drawBarAndMotors(
    g: Game,
    yL: number,
    yR: number,
    now: number,
    view: ViewState,
    stage: number,
    L: StaticLayer | null,
    top: number,
  ): { L: Housing; R: Housing } {
    void L;
    void top;
    const b = this.b;
    const s = this.s;
    const railL = this.mx + 22;
    const railR = this.mx + SIDE + this.PW + 21;
    const yls = this.Y0 - (yL + this.yOff) * s;
    const yrs = this.Y0 - (yR + this.yOff) * s;
    const slope = (yrs - yls) / this.PW;
    const yAt = (c: number) => Math.round(yls + (c - this.px0) * slope);

    // stepped rail, run-length
    let c0 = railL;
    let ry = yAt(railL);
    const flush = (c1: number) => {
      const w = c1 - c0;
      b.fillStyle = PAL.bone;
      b.fillRect(c0, ry, w, 1);
      b.fillStyle = PAL.boneDim;
      b.fillRect(c0, ry + 1, w, 2);
      b.fillStyle = PAL.metal2;
      b.fillRect(c0, ry + 3, w, 1);
      b.fillStyle = PAL.void;
      b.fillRect(c0, ry + 4, w, 1);
    };
    for (let c = railL + 1; c <= railR; c++) {
      const y = yAt(c);
      if (y !== ry || c === railR) {
        flush(c === railR ? c + 1 : c);
        c0 = c;
        ry = y;
      }
    }
    // tick notches every 16px (fixed to the bar)
    b.fillStyle = PAL.metal2;
    for (let c = this.px0 + 8; c < this.px0 + this.PW; c += 16) b.fillRect(c, yAt(c) + 1, 1, 2);

    // checkpoint sweep along the bar
    if (g.phase === "checkpoint") {
      const p = clamp(g.phaseT / TIMING.checkpointHoldMs, 0, 1);
      const cx = this.px0 + Math.round(p * this.PW);
      b.fillStyle = PAL.amber;
      for (let c = cx - 20; c < cx; c++) if (c >= this.px0) b.fillRect(c, yAt(c), 1, c > cx - 6 ? 3 : 1);
    }

    const mk = (side: "L" | "R"): Housing => {
      const cx = side === "L" ? railL : railR;
      const cy = yAt(cx) + 1;
      return { x: cx - 6, y: cy - 9, cx, cy };
    };
    const hs = { L: mk("L"), R: mk("R") };
    this.drawHousing(g, "L", hs.L, now, view, stage);
    this.drawHousing(g, "R", hs.R, now, view, stage);
    return hs;
  }

  private drawHousing(g: Game, side: "L" | "R", h: Housing, now: number, view: ViewState, stage: number) {
    const b = this.b;
    const v = side === "L" ? g.bar.vL : g.bar.vR;
    const strain = (side === "L" ? g.bar.strainL : g.bar.strainR) > 0;
    const live = g.phase === "playing";
    const moving = live && Math.abs(v) > 2;
    let jamTele = false;
    let jamActive = false;
    for (const e of g.effects) {
      if (e.order.ability !== "JAM" || e.motor !== side) continue;
      if (e.phase === "telegraph") jamTele = true;
      if (e.phase === "active") jamActive = true;
    }
    let x = h.x;
    const y = h.y;
    if (strain && !view.reducedMotion) x += Math.floor(now / 40) % 2 ? 1 : -1;
    // gear frame
    if (moving && !jamActive) {
      if (!jamTele || hash(Math.floor(now / 80)) > 0.5) this.gearFrame[side] = Math.floor(now / (Math.abs(v) > 60 ? 60 : 110)) % 2;
    }
    // body
    b.fillStyle = PAL.void;
    b.fillRect(x - 1, y - 1, 14, 20);
    b.fillStyle = PAL.metal2;
    b.fillRect(x, y, 12, 18);
    b.fillStyle = PAL.metal3;
    b.fillRect(x, y, 12, 1);
    b.fillRect(x, y, 1, 18);
    b.fillStyle = PAL.metal1;
    b.fillRect(x + 11, y + 1, 1, 17);
    b.fillRect(x + 1, y + 17, 11, 1);
    // vents
    const ventG = jamActive || (jamTele && hash(Math.floor(now / 100) + 3) > 0.4);
    b.fillStyle = ventG ? PAL.rig : PAL.void;
    for (const vy of [3, 5, 7]) b.fillRect(x + 2, y + vy, 8, 1);
    // gear window
    b.fillStyle = PAL.void;
    b.fillRect(x + 2, y + 10, 6, 6);
    b.fillStyle = jamActive ? PAL.rigDim : PAL.boneDim;
    if (this.gearFrame[side] === 0) {
      b.fillRect(x + 4, y + 11, 2, 4);
      b.fillRect(x + 3, y + 12, 4, 2);
    } else {
      b.fillRect(x + 3, y + 11, 1, 1);
      b.fillRect(x + 6, y + 11, 1, 1);
      b.fillRect(x + 3, y + 14, 1, 1);
      b.fillRect(x + 6, y + 14, 1, 1);
      b.fillRect(x + 4, y + 12, 2, 2);
    }
    // lamp
    let lamp: string = PAL.amberDim;
    if (strain) lamp = PAL.red;
    else if (jamTele || jamActive) lamp = Math.floor(now / 120) % 2 ? PAL.rig : PAL.amber;
    else if (moving) lamp = PAL.amber;
    else if (stage >= 3 && hash(Math.floor(now / 90) + (side === "L" ? 0 : 77)) > 0.93) lamp = PAL.rigDim;
    b.fillStyle = PAL.void;
    b.fillRect(x + 8, y + 10, 3, 4);
    b.fillStyle = lamp;
    b.fillRect(x + 9, y + 11, 2, 2);
    // vent puffs at strain
    if (strain) {
      const ph = Math.floor(now / 60) % 4;
      b.fillStyle = PAL.boneDim;
      const dir = side === "L" ? 1 : -1;
      const vx = side === "L" ? x + 12 + ph : x - 1 - ph;
      b.fillRect(vx, y + 3 + (ph % 2) * 2, 1, 1);
      b.fillRect(vx + dir, y + 5, 1, 1);
    }
    // dust when moving
    if (moving) {
      const fr = Math.floor(now / 70);
      b.fillStyle = PAL.metal3;
      for (let i = 0; i < 3; i++) {
        const dy = (fr + i * 5) % 12;
        const dx = Math.floor(hash(fr + i * 11 + (side === "L" ? 0 : 50)) * 10) - 5;
        b.fillRect(h.cx + dx, v > 0 ? y + 19 + dy : y - 2 - dy, 1, 1);
      }
    }
    // key glyphs (learnable controls, subtle)
    const up = side === "L" ? "W" : "↑";
    const dn = side === "L" ? "S" : "↓";
    const upOn = side === "L" ? g.input.lUp : g.input.rUp;
    const dnOn = side === "L" ? g.input.lDown : g.input.rDown;
    drawText(b, up, h.cx + 1, y - 10, { color: upOn ? PAL.bone : PAL.boneDim, alpha: upOn ? 1 : 0.75, align: "center" });
    drawText(b, dn, h.cx + 1, y + 21, { color: dnOn ? PAL.bone : PAL.boneDim, alpha: dnOn ? 1 : 0.75, align: "center" });
  }

  // ================================================================== ball
  private drawBall(g: Game, view: ViewState, now: number, yL: number, yR: number) {
    const b = this.b;
    const rb = BALL_R * this.s;
    const ball = g.ball;
    if (g.phase === "playing" || g.phase === "paused") {
      const x = this.sx(ball.x);
      const y = this.sy(ball.y);
      const sp = ballSprite(rb);
      if (Math.abs(ball.vx) > 110) {
        for (let k = 3; k >= 1; k--) {
          const gx = this.sx(ball.x - ball.vx * 0.018 * k);
          const gy = this.sy(g.barY(ball.x - ball.vx * 0.018 * k) + BALL_R);
          b.globalAlpha = 0.32 - k * 0.08;
          b.drawImage(sp.c, gx - sp.o, gy - sp.o);
        }
        b.globalAlpha = 1;
      }
      // spawn protection: soft blink of an amber outline ring
      if (g.clock < g.protectedUntil && Math.floor(now / 180) % 2 === 0) {
        const ring = ringPixels(Math.round(rb) + 2, 0, 1, 0);
        b.fillStyle = PAL.amberDim;
        for (let i = 0; i < ring.length; i += 6) b.fillRect(x + ring[i], y + ring[i + 1], 1, 1);
      }
      b.drawImage(sp.c, x - sp.o, y - sp.o);
      this.recordTrace(ball.x, ball.y, now);
    } else if (g.phase === "dying" || g.phase === "checkpoint") {
      const h = ball.fallingInto;
      if (!h) return;
      const dur = g.phase === "dying" ? TIMING.deathFallMs : Math.min(360, TIMING.checkpointHoldMs);
      const t = ball.fallT;
      const st = Math.min(4, Math.floor(t / (dur / 4)));
      if (st >= 4) return;
      const f = st / 4;
      const x = Math.round(this.sx(ball.x) + (this.sx(h.x) - this.sx(ball.x)) * f);
      const y = Math.round(this.sy(ball.y) + (this.sy(h.y) - this.sy(ball.y)) * f);
      const tint = g.phase === "dying" ? (t < 34 ? "red" : "steel") : "steel";
      if (st === 0) {
        const sp = ballSprite(rb, tint);
        b.drawImage(sp.c, x - sp.o, y - sp.o);
      } else {
        const r = rb * (1 - f);
        disc(b, x, y, r + 0.6, PAL.void);
        disc(b, x, y, r, g.phase === "dying" && st === 1 ? PAL.red : mix(PAL.ballBody, PAL.ballShade, f));
        b.fillStyle = PAL.ballSpec;
        b.fillRect(x - 1, y - 1, 1, 1);
      }
    } else if (g.phase === "resetting") {
      // new ball delivered at centre in the last 45% of the reset
      const p = g.phaseT / TIMING.resetMs;
      if (p > 0.55 && (view.reducedMotion || Math.floor(now / 50) % 2 === 0 || p > 0.85)) {
        const barMid = (yL + yR) / 2;
        const sp = ballSprite(rb);
        b.drawImage(sp.c, this.sx(0) - sp.o, this.sy(barMid + BALL_R) - sp.o);
      }
    }
  }

  private recordTrace(x: number, y: number, now: number) {
    if (now - this.traceLast < 50) return;
    this.traceLast = now;
    this.trace[this.traceHead * 2] = x;
    this.trace[this.traceHead * 2 + 1] = y;
    this.traceHead = (this.traceHead + 1) % (this.trace.length / 2);
    this.traceN = Math.min(this.traceN + 1, this.trace.length / 2);
  }

  // ================================================================== death / checkpoint
  private drawDeath(g: Game, now: number, view: ViewState) {
    const h = g.ball.fallingInto;
    if (!h) return;
    void now;
    void view;
    const b = this.b;
    const t = g.ball.fallT;
    const x = this.sx(h.x);
    const y = this.sy(h.y);
    if (t < 650) {
      const r = h.r * this.s + 3 + t * 0.06;
      b.fillStyle = PAL.red;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        const px = Math.round(x + Math.cos(a) * r);
        const py = Math.round(y + Math.sin(a) * r);
        if (t < 450 || i % 2 === 0) b.fillRect(px, py, 2, 2);
      }
    }
  }

  /** Off-screen goal marker at the top edge: [ring] EXIT ▲ 412 */
  private drawExitIndicator(g: Game, now: number) {
    const ex = g.chamber.exit;
    const ey = this.sy(ex.y);
    if (ey + ex.r * this.s > 0) return; // exit at least partly visible
    const b = this.b;
    const dist = Math.max(0, Math.round(ex.y - g.ball.y));
    const label = `EXIT ${(dist / 100).toFixed(1)}M`; // 100 world units = 1 machine metre
    const tw = measure(label);
    const w = 11 + 3 + 7 + 3 + tw + 6;
    const h = 15;
    const cx = clamp(this.sx(ex.x), this.px0 + w / 2 + 2, this.px0 + this.PW - w / 2 - 2);
    const x = Math.round(cx - w / 2);
    const y = 3;
    b.fillStyle = PAL.void;
    b.globalAlpha = 0.85;
    b.fillRect(x, y, w, h);
    b.globalAlpha = 1;
    b.fillStyle = PAL.boneDim;
    b.fillRect(x, y + h - 1, w, 1);
    // segmented ring icon (rotating like the exit ring)
    const ring = ringPixels(4, 0, 1.6, 0);
    const step = Math.floor(now / 125);
    const icx = x + 7;
    const icy = y + 7;
    for (let i = 0; i < ring.length / 2; i++) {
      const dx = ring[i * 2];
      const dy = ring[i * 2 + 1];
      const f = ((((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 8 + step / 4) % 1 + 1) % 1;
      if (f >= 0.62) continue;
      b.fillStyle = PAL.bone;
      b.fillRect(icx + dx, icy + dy, 1, 1);
    }
    // chevron ▲ (bobbing 1px)
    const bob = Math.floor(now / 300) % 2;
    const ax = x + 14 + 3;
    const ay = y + 4 - bob;
    b.fillStyle = PAL.bone;
    for (let r = 0; r < 4; r++) b.fillRect(ax - r, ay + r, 1 + r * 2, 1);
    b.fillRect(ax - 1, ay + 4, 3, 3);
    drawText(b, label, x + 24, y + 4, { color: PAL.bone });
  }

  private drawCheckpoint(g: Game, now: number, L: StaticLayer, top: number) {
    const b = this.b;
    const p = g.phase === "won" ? 1 : clamp(g.phaseT / TIMING.checkpointHoldMs, 0, 1);
    const lineY = this.LH * (1 - p);
    for (const r of L.lampRows) {
      const y = top + r;
      if (y < 0 || y >= this.LH) continue;
      if (y < lineY) continue;
      b.fillStyle = PAL.amber;
      b.fillRect(this.mx + 8, y, 2, 2);
      b.fillRect(this.mx + this.mw - 10, y, 2, 2);
    }
    const ex = g.chamber.exit;
    const x = this.sx(ex.x);
    const y = this.sy(ex.y) + Math.round(ex.r * this.s) + 10;
    if (Math.floor(now / 140) % 4 !== 3) this.plate("CHKPT", x, y, 1, PAL.amber, PAL.metal1);
  }

  /** Small stamped plate with text centred at (cx, y top). */
  private plate(text: string, cx: number, y: number, scale: number, col: string, bg: string) {
    const b = this.b;
    const w = measure(text, scale) + 10;
    const h = 7 * scale + 8;
    const x = Math.round(cx - w / 2);
    b.fillStyle = PAL.void;
    b.fillRect(x - 1, y - 1, w + 2, h + 2);
    b.fillStyle = bg;
    b.fillRect(x, y, w, h);
    b.fillStyle = col;
    b.fillRect(x, y, w, 1);
    b.fillRect(x, y + h - 1, w, 1);
    b.fillRect(x, y, 1, h);
    b.fillRect(x + w - 1, y, 1, h);
    drawText(b, text, cx, y + 4, { color: col, scale, align: "center" });
  }

  // ================================================================== agent view
  private drawLanes(ch: ChamberDef) {
    const b = this.b;
    b.fillStyle = PAL.rigDim;
    for (let row = 0; row < this.LH; row += 3) {
      const y = (this.Y0 - row - 0.5) / this.s - this.yOff;
      if (y < 0 || y > ch.H) continue;
      const o = outerIntervalAt(ch.outer, y);
      b.fillRect(this.sx(o.cx - 0.25 * o.hw), row, 1, 2);
      b.fillRect(this.sx(o.cx + 0.25 * o.hw), row, 1, 2);
    }
  }

  private drawAgent(g: Game, now: number) {
    const b = this.b;
    const ch = g.chamber;
    // lane labels at the ball's height
    const yW = g.ball.y;
    const o = outerIntervalAt(ch.outer, yW);
    const ly = this.sy(yW) - 40;
    const lane = g.lane;
    for (const [lab, u] of [
      ["L", -0.62],
      ["C", 0],
      ["R", 0.62],
    ] as const) {
      drawText(b, lab, this.sx(o.cx + u * o.hw), ly, { color: lab === lane ? PAL.rig : PAL.rigDim, align: "center" });
    }
    // trace
    const n = this.trace.length / 2;
    b.fillStyle = PAL.rigDim;
    for (let i = 0; i < this.traceN; i++) {
      const k = (this.traceHead - 1 - i + n) % n;
      if (i % 2) continue;
      b.fillRect(this.sx(this.trace[k * 2]), this.sy(this.trace[k * 2 + 1]), 1, 1);
    }
    // armed effects
    let row = 0;
    for (const e of g.effects) {
      if (e.phase !== "armed") continue;
      const tr = e.order.trigger;
      const when =
        tr.type === "now"
          ? "NOW"
          : tr.type === "ball_enters"
            ? `WHEN BALL ENTERS ${tr.lane}`
            : `AT ${Math.round((tr.progress ?? 0) * 100)}%`;
      const txt = `ARMED: ${e.order.ability} ${e.order.side} → ${when}`;
      const y = 6 + row * 11;
      b.fillStyle = PAL.void;
      b.globalAlpha = 0.75;
      b.fillRect(this.px0 + 4, y - 2, measure(txt) + 6, 11);
      b.globalAlpha = 1;
      drawText(b, txt, this.px0 + 7, y, { color: PAL.rig });
      row++;
      // marker in the world
      if (tr.type === "ball_enters" && tr.lane) {
        const yy = g.ball.y + 70;
        const oo = outerIntervalAt(ch.outer, yy);
        const u0 = tr.lane === "L" ? -1 : tr.lane === "C" ? -0.25 : 0.25;
        const u1 = tr.lane === "L" ? -0.25 : tr.lane === "C" ? 0.25 : 1;
        const x0 = this.sx(oo.cx + u0 * oo.hw) + 3;
        const x1 = this.sx(oo.cx + u1 * oo.hw) - 3;
        const y0 = this.sy(yy);
        if (Math.floor(now / 300) % 2 === 0) this.bracket(x0, y0 - 10, x1, y0 + 10, PAL.rigDim, 3);
        drawText(b, "ARM " + e.order.ability, (x0 + x1) / 2, y0 - 3, { color: PAL.rigDim, align: "center" });
      } else if (tr.type === "progress" && tr.progress !== null) {
        const yy = PHYS.barMinY + tr.progress * (ch.exit.y - PHYS.barMinY);
        const y0 = this.sy(yy);
        b.fillStyle = PAL.rigDim;
        for (let x = this.px0; x < this.px0 + this.PW; x += 4) b.fillRect(x, y0, 2, 1);
        drawText(b, `${e.order.ability} @${Math.round(tr.progress * 100)}%`, this.px0 + 6, y0 - 9, { color: PAL.rigDim });
      }
    }
  }

  // ================================================================== header eye
  private drawHeaderEye(L: StaticLayer, top: number, view: ViewState, now: number, look: number) {
    const cx = this.mx + L.eyeWin.x + L.eyeWin.w / 2;
    const cy = top + L.eyeWin.y + L.eyeWin.h / 2;
    if (cy < -20 || cy > this.LH + 20) return;
    drawEye(this.b, cx, cy, 3, view.glitch > 0.5 ? "glitch" : view.eye, now, look);
  }

  // ================================================================== transition
  private drawTransition(g: Game, view: ViewState, now: number, stage: number) {
    const from = g.chamber;
    const to = g.pendingChamber!;
    if (!this.trans || this.trans.to !== to) {
      this.trans = { from, to, camStart: this.camY, yL: g.bar.yL, yR: g.bar.yR, landed: false };
    }
    const T = this.trans;
    const off = from.H + PAD_T + BULK + PAD_B;
    const p = clamp(g.phaseT / TIMING.transitionMs, 0, 1);
    const e = easeInOut(p);
    const camEnd = off + (view.reducedMotion ? CAM_MIN : this.camExit(to));
    const cam = T.camStart + (camEnd - T.camStart) * e;
    this.camY = cam;
    this.camV = 0;
    this.setCam(cam);
    if (p > 0.96 && !T.landed) {
      T.landed = true;
      this.kick(view, 3);
    }
    this.transLanded = to;

    // old chamber
    this.yOff = 0;
    const Lo = this.layerFor(from, stage, view.playerTag);
    const topO = this.blitLayer(Lo);
    this.drawHoles(g, from, now, null, view);
    this.drawExit(from.exit, now, true, from.H);
    this.drawHeaderEye(Lo, topO, view, now, 0);

    // new chamber (stage guess = its index for a fresh layer)
    this.yOff = off;
    const Ln = this.layerFor(to, guessStage(to), view.playerTag);
    const topN = this.blitLayer(Ln);
    const hidden = to.template === "MODEL" ? new Set(to.revealHoles) : null;
    for (const h of to.holes) {
      if (hidden && hidden.has(h.id)) continue;
      const sp = holeSprite(h.r * this.s, "normal");
      this.b.drawImage(sp.c, this.sx(h.x) - sp.o, this.sy(h.y) - sp.o);
    }
    this.drawExit(to.exit, now, false, to.H);
    this.drawHeaderEye(Ln, topN, view, now, 0);
    this.yOff = 0;
    this.drawMargins();

    // bulkhead
    this.drawBulkhead(from.H + PAD_T, from.H + PAD_T + BULK, to, now);

    // the bar stays with the old chamber and scrolls away; the intro camera finds it again
    this.drawBarAndMotors(g, T.yL, T.yR, now, view, stage, null, 0);

    // lamps chase during the scroll
    const b = this.b;
    for (const r of Lo.lampRows) {
      const y = topO + r;
      if (y < 0 || y >= this.LH) continue;
      if (Math.floor(now / 80 + r / 16) % 3 !== 0) continue;
      b.fillStyle = PAL.amber;
      b.fillRect(this.mx + 8, y, 2, 2);
      b.fillRect(this.mx + this.mw - 10, y, 2, 2);
    }
  }

  private drawBulkhead(y0w: number, y1w: number, to: ChamberDef, now: number) {
    const b = this.b;
    const yTop = this.sy(y1w);
    const yBot = this.sy(y0w);
    if (yBot < 0 || yTop > this.LH) return;
    const x = this.mx;
    const w = this.mw;
    const h = yBot - yTop;
    b.fillStyle = PAL.metal2;
    b.fillRect(x, yTop, w, h);
    // bevels
    b.fillStyle = PAL.metal3;
    b.fillRect(x, yTop + 8, w, 1);
    b.fillStyle = PAL.void;
    b.fillRect(x, yBot - 9, w, 1);
    b.fillRect(x, yTop, w, 1);
    b.fillRect(x, yBot - 1, w, 1);
    // hazard bands
    for (const by of [yTop + 1, yBot - 8]) {
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < w; c += 4) {
          b.fillStyle = ((c + r + by) >> 2) & 1 ? PAL.amber : PAL.void;
          b.fillRect(x + c + ((r + by) & 3) - 3, by + r, 4, 1);
        }
    }
    b.fillStyle = PAL.metal1;
    b.fillRect(x, yTop + 9, 3, h - 18);
    b.fillRect(x + w - 3, yTop + 9, 3, h - 18);
    // rivets
    for (let c = x + 10; c < x + w - 8; c += 22) {
      for (const ry of [yTop + 13, yBot - 15]) {
        b.fillStyle = mix(PAL.metal2, PAL.boneDim, 0.6);
        b.fillRect(c, ry, 2, 2);
        b.fillStyle = PAL.void;
        b.fillRect(c + 1, ry + 2, 2, 1);
      }
    }
    const num = String(to.index + 1).padStart(2, "0");
    const midY = yTop + Math.round(h / 2);
    const sc = Math.max(3, Math.min(6, Math.floor(this.s * 5)));
    drawText(b, `CH-${num}`, x + w / 2, midY - (7 * sc) / 2 - 6, { color: PAL.bone, emboss: PAL.void, scale: sc, align: "center", tracking: 1 });
    drawText(b, to.name, x + w / 2, midY + (7 * sc) / 2 + 2, { color: PAL.boneDim, emboss: PAL.void, scale: 2, align: "center", tracking: 1 });
    const blink = Math.floor(now / 200) % 2 === 0;
    for (const lx of [x + 30, x + w - 36]) {
      b.fillStyle = PAL.void;
      b.fillRect(lx - 1, midY - 4, 8, 8);
      b.fillStyle = blink ? PAL.amber : PAL.amberDim;
      b.fillRect(lx, midY - 3, 6, 6);
    }
  }

  // ================================================================== banner / caption
  private drawBanner(view: ViewState, now: number) {
    const bn = view.banner;
    if (!bn) return;
    const age = now - bn.at;
    if (age < 0) return;
    const b = this.b;
    const col = bn.color === "amber" ? PAL.amber : bn.color === "red" ? PAL.red : bn.color === "rig" ? PAL.rig : PAL.bone;
    const bg = bn.color === "rig" ? PAL.rigDeep : bn.color === "red" ? mix(PAL.metal1, PAL.redDim, 0.5) : PAL.metal1;
    const sc = this.LW > 560 ? 3 : 2;
    const tw = measure(bn.text, sc, 1);
    const sw = bn.sub ? measure(bn.sub, 1) : 0;
    const w = Math.max(tw, sw) + 44;
    const h = 7 * sc + (bn.sub ? 14 : 0) + 22;
    let y = Math.round(this.LH * 0.6 - h / 2); // below the exit-intro framing
    if (age < 60) y -= 10;
    else if (age < 110) y += 2;
    if (age < 70 && this.bannerShakeAt !== bn.at) {
      this.bannerShakeAt = bn.at;
      this.kick(view, 2);
    }
    const x = Math.round(this.LW / 2 - w / 2);
    // shadow + plate
    b.fillStyle = PAL.void;
    b.globalAlpha = 0.3;
    b.fillRect(0, y - 4, this.LW, h + 8);
    b.globalAlpha = 1;
    b.fillRect(x - 2, y - 2, w + 4, h + 4);
    b.fillStyle = bg;
    b.fillRect(x, y, w, h);
    b.fillStyle = PAL.metal3;
    b.fillRect(x, y, w, 1);
    b.fillRect(x, y, 1, h);
    b.fillStyle = col;
    b.fillRect(x + 3, y + 3, w - 6, 1);
    b.fillRect(x + 3, y + h - 4, w - 6, 1);
    // hazard tabs
    if (bn.color === "amber" || bn.color === "red") {
      for (let r = 0; r < h - 10; r++)
        for (const tx of [x + 6, x + w - 14])
          for (let c = 0; c < 8; c++) {
            if (((c + r) >> 2) & 1) continue;
            b.fillStyle = col;
            b.fillRect(tx + c, y + 5 + r, 1, 1);
          }
    }
    // rivets
    b.fillStyle = mix(PAL.metal2, PAL.boneDim, 0.6);
    for (const [rx, ry] of [
      [x + 2, y + 2],
      [x + w - 4, y + 2],
      [x + 2, y + h - 4],
      [x + w - 4, y + h - 4],
    ])
      b.fillRect(rx, ry, 2, 2);
    drawText(b, bn.text, this.LW / 2, y + 10, { color: col, emboss: PAL.void, scale: sc, align: "center", tracking: 1 });
    if (bn.sub) drawText(b, bn.sub, this.LW / 2, y + 10 + 7 * sc + 6, { color: PAL.boneDim, align: "center" });
  }

  private drawCaption(text: string, now: number) {
    void now;
    const b = this.b;
    const maxW = Math.min(this.PW - 30, 420);
    const words = text.toUpperCase().split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (measure(t) > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else cur = t;
    }
    if (cur) lines.push(cur);
    const w = Math.max(...lines.map((l) => measure(l))) + 16;
    const h = lines.length * 10 + 8;
    const x = Math.round(this.LW / 2 - w / 2);
    const y = Math.round(this.LH * 0.66);
    b.fillStyle = PAL.void;
    b.globalAlpha = 0.85;
    b.fillRect(x, y, w, h);
    b.globalAlpha = 1;
    b.fillStyle = PAL.red;
    b.fillRect(x, y, 2, h);
    lines.forEach((l, i) => drawText(b, l, x + 8, y + 5 + i * 10, { color: PAL.bone }));
  }

  // ================================================================== title / offline
  private drawTitle(view: ViewState, now: number) {
    const b = this.b;
    const t = now - this.titleStart;
    const viewH = this.LH / this.s;
    this.setCam(Math.max(0, (this.titleCh.H - viewH) / 2) + Math.sin(now / 9000) * 12);
    this.yOff = 0;
    const L = this.layerFor(this.titleCh, 0, "");
    this.blitLayer(L);
    this.drawMargins();
    // dim
    b.fillStyle = PAL.void;
    b.globalAlpha = 0.45;
    b.fillRect(0, 0, this.LW, this.LH);
    b.globalAlpha = 1;

    // hazard bars
    const hb = 8;
    for (const y0 of [0, this.LH - hb]) {
      b.fillStyle = PAL.void;
      b.fillRect(0, y0, this.LW, hb);
      b.fillStyle = PAL.amber;
      const mv = Math.floor(now / 120) % 8;
      for (let r = 0; r < hb; r++) for (let c = -8; c < this.LW + 8; c += 8) b.fillRect(c + ((r + mv) % 8), y0 + r, 4, 1);
    }

    // big plate
    let sc = Math.floor((this.LW * 0.56) / measure("RIGGED", 1, 1));
    sc = clamp(sc, 3, 14);
    const tw = measure("RIGGED", sc, 1);
    const pw = tw + sc * 8;
    const ph = 7 * sc + sc * 6;
    const px = Math.round(this.LW / 2 - pw / 2);
    const py = Math.round(this.LH * 0.47 - ph / 2);
    b.fillStyle = PAL.void;
    b.fillRect(px - 3, py - 3, pw + 6, ph + 6);
    b.fillStyle = PAL.metal2;
    b.fillRect(px, py, pw, ph);
    b.fillStyle = PAL.metal3;
    b.fillRect(px, py, pw, 2);
    b.fillRect(px, py, 2, ph);
    b.fillStyle = PAL.metal1;
    b.fillRect(px, py + ph - 2, pw, 2);
    b.fillRect(px + pw - 2, py, 2, ph);
    // brushed
    b.fillStyle = mix(PAL.metal2, PAL.metal3, 0.25);
    for (let c = px + 4; c < px + pw - 4; c += 3) b.fillRect(c, py + 4, 1, ph - 8);
    // rivets
    for (let c = px + 8; c < px + pw - 6; c += 22) {
      for (const ry of [py + 6, py + ph - 9]) {
        b.fillStyle = mix(PAL.metal2, PAL.boneDim, 0.7);
        b.fillRect(c, ry, 2, 2);
        b.fillStyle = PAL.void;
        b.fillRect(c + 1, ry + 2, 2, 1);
      }
    }
    // stamped letters: dark recess offset, then bone face
    const tx = this.LW / 2;
    const ty = py + Math.round((ph - 7 * sc) / 2);
    drawText(b, "RIGGED", tx - 1, ty - 1, { color: PAL.void, scale: sc, align: "center", tracking: 1 });
    drawText(b, "RIGGED", tx, ty, { color: PAL.bone, emboss: PAL.metal0, scale: sc, align: "center", tracking: 1 });
    // a grime smear across the plate
    b.fillStyle = PAL.grime;
    b.globalAlpha = 0.35;
    for (let i = 0; i < 90; i++) {
      const gx = px + pw * 0.62 + (hash(i) - 0.5) * pw * 0.3;
      const gy = py + ph * 0.7 + (hash(i + 99) - 0.5) * ph * 0.5;
      b.fillRect(Math.round(gx), Math.round(gy), 2, 1);
    }
    b.globalAlpha = 1;

    // eye
    const open = clamp((t - 700) / 2600, 0, 1);
    const eyeS = clamp(Math.floor(sc * 0.75), 3, 8);
    const ey = py - eyeS * 7;
    const eyeW = 13 * eyeS + 16;
    b.fillStyle = PAL.void;
    b.fillRect(Math.round(this.LW / 2 - eyeW / 2), Math.round(ey - (7 * eyeS) / 2 - 6), eyeW, 7 * eyeS + 12);
    const look = Math.sin(now / 1300) * 0.9;
    drawEye(b, this.LW / 2, ey, eyeS, view.glitch > 0.5 ? "glitch" : open < 1 ? "idle" : "tracking", now, look, {
      open,
      noBlink: open < 1,
    });

    // tagline + prompt
    const tagY = py + ph + 14;
    drawText(b, "YOU CONTROL THE BAR. RIG CONTROLS EVERYTHING ELSE.", this.LW / 2, tagY, {
      color: PAL.boneDim,
      align: "center",
    });
    if (Math.floor(now / 530) % 3 !== 2) {
      const ps = this.LW > 600 ? 2 : 1;
      drawText(b, "INSERT PLAYER — PRESS SPACE", this.LW / 2, tagY + 22, {
        color: PAL.amber,
        emboss: PAL.void,
        scale: ps,
        align: "center",
      });
    }
    drawText(b, "UNIT 05 // SELF-DIAGNOSTIC: NOMINAL", 10, this.LH - hb - 14, { color: PAL.boneDim, alpha: 0.8 });
    drawText(b, view.playerTag ? `PLAYER ${view.playerTag}` : "", this.LW - 10, this.LH - hb - 14, {
      color: PAL.boneDim,
      alpha: 0.8,
      align: "right",
    });
  }

  private drawOffline(view: ViewState, now: number) {
    const b = this.b;
    const t = now - this.offlineStart;
    b.fillStyle = PAL.void;
    b.fillRect(0, 0, this.LW, this.LH);
    // collapse line during the first 400ms
    if (t < 420 && !view.reducedMotion) {
      const p = t / 420;
      const hh = Math.max(1, Math.round(this.LH * (1 - p) * 0.5));
      b.fillStyle = PAL.metal1;
      b.fillRect(0, this.LH / 2 - hh, this.LW, hh * 2);
      b.fillStyle = PAL.bone;
      b.fillRect(Math.round(this.LW * p * 0.4), this.LH / 2, Math.round(this.LW * (1 - p * 0.8)), 1);
      return;
    }
    const sc = this.LW > 600 ? 4 : 3;
    const cy = Math.round(this.LH * 0.46);
    drawEye(b, this.LW / 2, cy - 40, sc, "offline", now, 0, { noBlink: true });
    const flick = t < 1400 && hash(Math.floor(now / 70)) < 0.3;
    if (!flick) drawText(b, "RIG OFFLINE", this.LW / 2, cy, { color: PAL.bone, emboss: PAL.metal1, scale: sc, align: "center", tracking: 1 });
    if (t > 1400) drawText(b, "UNIT 05 // CONTROL RELEASED", this.LW / 2, cy + 7 * sc + 14, { color: PAL.boneDim, align: "center" });
  }

  // ================================================================== present + CRT
  private present(view: ViewState, now: number, g: Game) {
    const ctx = this.ctx;
    const k = this.k;
    const W = this.canvas.width;
    const H = this.canvas.height;
    let ox = 0;
    let oy = 0;
    if (!view.reducedMotion && this.shakeAmp > 0.3) {
      ox = Math.round((hash(Math.floor(now / 16)) - 0.5) * 2 * this.shakeAmp);
      oy = Math.round((hash(Math.floor(now / 16) + 9) - 0.5) * 2 * this.shakeAmp);
    }
    if (ox || oy) {
      ctx.fillStyle = PAL.void;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.buf, 0, 0, this.LW, this.LH, ox * k, oy * k, this.LW * k, this.LH * k);

    // RGB split (glitch > 0.5 only)
    if (view.glitch > 0.5) {
      if (!this.tint) {
        this.tint = document.createElement("canvas");
        this.tint.width = this.LW;
        this.tint.height = this.LH;
      }
      const tg = this.tint.getContext("2d")!;
      tg.globalCompositeOperation = "source-over";
      tg.drawImage(this.buf, 0, 0);
      tg.globalCompositeOperation = "multiply";
      tg.fillStyle = "#ff0000";
      tg.fillRect(0, 0, this.LW, this.LH);
      // remove red from the frame, then add it back displaced: a true channel split
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "#00ffff";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      const d = Math.max(2, Math.round(k * view.glitch));
      ctx.drawImage(this.tint, 0, 0, this.LW, this.LH, ox * k + d, oy * k, this.LW * k, this.LH * k);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // rare 1-frame row shift
    if (!view.reducedMotion) {
      const model = view.screen === "game" && g.chamber.template === "MODEL" && view.infection >= 0.95;
      if (this.nextRowShift === 0) this.nextRowShift = now + 20000 + hash(Math.floor(now)) * 20000;
      let fire = now >= this.nextRowShift;
      if (view.glitch > 0 && hash(Math.floor(now / 16) * 3 + 1) < view.glitch * 0.18) fire = true;
      if (fire && now >= this.rowShiftUntil) {
        this.rowShiftUntil = now + 17;
        const r = hash(Math.floor(now) + 5);
        this.rowShift = {
          y: Math.round(r * (H - 40)),
          h: Math.round((6 + hash(Math.floor(now) + 6) * 26) * (k / 2)),
          dx: Math.round((hash(Math.floor(now) + 7) - 0.5) * 24 * (k / 2)) || k,
        };
        this.nextRowShift = now + (model ? 6000 + r * 6000 : 20000 + r * 25000);
      }
      if (now < this.rowShiftUntil) {
        const rs = this.rowShift;
        ctx.drawImage(this.canvas, 0, rs.y, W, rs.h, rs.dx, rs.y, W, rs.h);
      }
    }

    // scanlines + vignette (one prebuilt overlay)
    if (this.vignette) ctx.drawImage(this.vignette, 0, 0);
  }
}

// chevron (pointing +y), 1px thick double stroke
const CHEV: [number, number][] = [
  [-3, -3],
  [-2, -2],
  [-1, -1],
  [0, 0],
  [1, -1],
  [2, -2],
  [3, -3],
  [-3, -6],
  [-2, -5],
  [-1, -4],
  [0, -3],
  [1, -4],
  [2, -5],
  [3, -6],
];

export type { Sprite };
