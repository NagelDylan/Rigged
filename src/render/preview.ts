// Visual QA harness (not part of the main bundle): open /render-preview.html?...
// Params: screen=title|offline  tpl=SPLITTER  idx=1  bx=0 by=300 tilt=0
//   fx=SHIFT|PULSE|CRUSH|MAGNET|JAM side=L|C|R fxms=600 int=2
//   phase=dying|checkpoint|transition|resetting pms=200
//   inf=0..1 agent=1 glitch=0..1 eye=idle banner=TEXT bsub=.. bcolor=amber caption=TEXT reveal=1 live=1 rm=1 tag=P-7F3A
import { buildChamber, type ChamberDef } from "../engine/chambers";
import { BALL_R, PHYS } from "../engine/constants";
import { Game, NO_INPUT } from "../engine/game";
import type { Ability, Side, TemplateName } from "../shared/rig";
import type { EyeState } from "./eye";
import { Renderer, type ViewState } from "./renderer";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const tpl = (q.get("tpl") ?? "SPLITTER").toUpperCase() as TemplateName;
const ORDER: TemplateName[] = ["CALIBRATION", "FUNNEL", "SPLITTER", "EYE", "MODEL"];
const idx = num("idx", tpl === "CALIBRATION" ? 0 : tpl === "MODEL" ? 4 : 2);

function make(i: number, t: TemplateName): ChamberDef {
  const params = { pressureSide: "R" as const, density: 2 as const, exitSide: "C" as Side, seed: 3 + i };
  if (t === "MODEL")
    return buildChamber(i, "MODEL", { ...params, exitSide: "L" }, {
      trapSide: "R",
      exitSide: "L",
      restingSpots: [0, 1, 5, 2, 0, 0, 3, 8, 1, 0, 4, 0],
      useRestingSpots: true,
    });
  return buildChamber(i, t, params);
}

const def = make(idx, tpl);
const game = new Game(def);
game.nextChamber = (i) => (i >= 5 ? null : make(i, ORDER[i] === tpl ? "TOWER" : ORDER[i]));
const step = (ms: number) => {
  for (let t = 0; t < ms; t += PHYS.dt * 1000) game.step();
};

step(2600);
if (q.has("by") || q.has("bx")) {
  const by = num("by", 200);
  const tilt = num("tilt", 0);
  game.bar.yL = by - tilt / 2;
  game.bar.yR = by + tilt / 2;
  game.ball.x = num("bx", 0);
  step(1000 / 120);
}
const fx = q.get("fx")?.toUpperCase() as Ability | undefined;
if (fx) {
  game.enqueue({
    decisionId: "preview",
    ability: fx,
    side: (q.get("side") ?? "R").toUpperCase() as Side,
    intensity: num("int", 2) as 1 | 2 | 3,
    telegraphMs: num("tele", 1400),
    trigger: q.get("armed")
      ? { type: "ball_enters", lane: q.get("armed")!.toUpperCase() as Side, progress: null }
      : { type: "now", lane: null, progress: null },
    expiresMs: 60000,
  });
  step(num("fxms", 600));
}
const phase = q.get("phase");
if (phase) {
  const target =
    phase === "dying" || phase === "resetting"
      ? [...game.chamber.holes].sort((a, b) => Math.abs(a.y - num("by", 300)) - Math.abs(b.y - num("by", 300)))[0]
      : game.chamber.exit;
  game.bar.yL = game.bar.yR = target.y - BALL_R;
  game.ball.x = target.x;
  for (let i = 0; i < 10 && game.phase === "playing"; i++) step(1000 / 120);
  if (phase === "transition") step(450);
  if (phase === "resetting") step(420 + 520);
  step(num("pms", 150));
}

const canvas = document.getElementById("c") as HTMLCanvasElement;
const r = new Renderer(canvas);
const fit = () => r.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
fit();
addEventListener("resize", fit);

const t0 = performance.now();
const view: ViewState = {
  infection: num("inf", Math.min(1, idx / 4)),
  eye: (q.get("eye") ?? "tracking") as EyeState,
  agentView: q.get("agent") === "1",
  reducedMotion: q.get("rm") === "1",
  playerTag: q.get("tag") ?? "P-7F3A",
  chamberCount: 5,
  glitch: num("glitch", 0),
  modelReveal: q.get("reveal") === "1" ? { holeIds: def.revealHoles, startedAt: t0 + 400 } : null,
  deathCaption: q.get("caption"),
  banner: q.get("banner")
    ? {
        text: q.get("banner")!,
        sub: q.get("bsub") ?? undefined,
        color: (q.get("bcolor") ?? "amber") as "amber",
        at: t0 + 100,
      }
    : null,
  screen: (q.get("screen") ?? "game") as ViewState["screen"],
};

const live = q.get("live") === "1";
const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
let last = performance.now();
let acc = 0;
let frames = 0;
let fpsT = performance.now();
function frame(now: number) {
  if (live) {
    game.setInput({
      ...NO_INPUT,
      lUp: keys.has("KeyW"),
      lDown: keys.has("KeyS"),
      rUp: keys.has("ArrowUp"),
      rDown: keys.has("ArrowDown"),
    });
    acc += Math.min(100, now - last);
    while (acc >= PHYS.dt * 1000) {
      game.step();
      acc -= PHYS.dt * 1000;
    }
    game.drainEvents();
  }
  last = now;
  const a = performance.now();
  r.render(game, view, now);
  frames++;
  (window as unknown as { __renderMs: number }).__renderMs = performance.now() - a;
  if (now - fpsT > 1000) {
    (window as unknown as { __fps: number }).__fps = frames;
    frames = 0;
    fpsT = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as unknown as { __game: Game }).__game = game;
