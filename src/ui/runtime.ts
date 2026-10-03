// The browser runtime: owns the fixed-step loop, keyboard input, audio cues,
// the director (RIG orchestration) and the renderer. React only reads from it.
import { Director } from "../agent/director";
import { HttpTransport } from "../agent/transport";
import { sfx } from "../audio/sfx";
import { Bot, PROFILES } from "../engine/bot";
import { PHYS, TIMING } from "../engine/constants";
import { Game, NO_INPUT, type GameEvent, type Input } from "../engine/game";
import { PlayerModel } from "../engine/playerModel";
import { Renderer, type ViewState } from "../render/renderer";
import type { EyeState } from "../render/eye";
import type { MemorySummary, RunEnd, RunSummary } from "../shared/rig";
import { endRun, playerTag, sendEvents, startRun, type Session } from "./api";

export type Screen = "title" | "game" | "win" | "summary";

export interface RunResult {
  summary: RunSummary;
  rigEnd: RunEnd | null;
  rigEndSource: "live" | "local" | null;
  timeMs: number;
}

const KEYMAP: Record<string, keyof Input> = {
  KeyW: "lUp",
  KeyS: "lDown",
  ArrowUp: "rUp",
  ArrowDown: "rDown",
};

export class Runtime {
  screen: Screen = "title";
  game: Game | null = null;
  model: PlayerModel | null = null;
  director: Director | null = null;
  renderer: Renderer | null = null;
  session: Session | null = null;
  agentView = false;
  paused = false;
  focused = true;
  reducedMotion = false;
  result: RunResult | null = null;
  autopilot: Bot | null = null;
  winStage = 0; // 0 offline, 1 "...no.", 2 eye returns
  /** QA only (?speed=N): simulate faster than real time. */
  timeScale = 1;
  version = 0;

  private keys: Input = { ...NO_INPUT };
  private raf = 0;
  private last = 0;
  private acc = 0;
  private listeners = new Set<() => void>();
  private view: ViewState;
  private lastNotify = 0;
  private lastFlush = 0;
  private winAt = 0;
  private seedOverride: number | null = null;
  private runIdPromise: Promise<string | null> | null = null;
  private lastDirectorVersion = -1;

  constructor() {
    this.view = {
      infection: 0,
      eye: "idle",
      agentView: false,
      reducedMotion: false,
      playerTag: "P----",
      chamberCount: 5,
      glitch: 0,
      modelReveal: null,
      deathCaption: null,
      banner: null,
      screen: "title",
    };
    try {
      this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const p = new URLSearchParams(location.search);
      if (p.get("seed")) this.seedOverride = Number(p.get("seed")) || null;
      if (p.get("speed")) this.timeScale = Math.max(1, Math.min(8, Number(p.get("speed")) || 1));
    } catch {
      /* non-browser */
    }
  }

  // ------------------------------------------------------------------ wiring
  attach(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.resize();
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("resize", this.resize);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  detach() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("resize", this.resize);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.version++;
    for (const l of this.listeners) l();
  }

  resize = () => {
    const c = this.renderer && (this.renderer as unknown as { canvas?: HTMLCanvasElement }).canvas;
    const el = c ?? (document.querySelector("canvas.machine") as HTMLCanvasElement | null);
    if (!el || !this.renderer) return;
    const r = el.getBoundingClientRect();
    this.renderer.resize(Math.max(320, r.width), Math.max(240, r.height), window.devicePixelRatio || 1);
  };

  setSession(s: Session) {
    this.session = s;
    this.view.playerTag = playerTag(s.playerId);
    if (this.startWhenReady) {
      this.startWhenReady = false;
      this.startRun();
    }
    this.notify();
  }

  /** Start as soon as the session (memory) is known, so RIG can greet a returning player. */
  private startWhenReady = false;
  requestStart() {
    sfx.unlock();
    if (this.session) return this.startRun();
    if (this.startWhenReady) return;
    this.startWhenReady = true;
    setTimeout(() => {
      if (this.startWhenReady) {
        this.startWhenReady = false;
        this.startRun();
      }
    }, 2500);
  }

  // ------------------------------------------------------------------ runs
  startRun() {
    sfx.unlock();
    sfx.boot();
    const seed = this.seedOverride ?? Math.floor(Math.random() * 1e6);
    const game = new Game(Director.firstChamber(seed));
    const model = new PlayerModel();
    const memory: MemorySummary | null = this.session?.memorySummary ?? null;
    const director = new Director({ game, model, transport: new HttpTransport(), memory, seed });
    this.game = game;
    this.model = model;
    this.director = director;
    this.result = null;
    this.paused = false;
    this.screen = "game";
    this.view.screen = "game";
    this.view.modelReveal = null;
    this.view.banner = { text: "CH-01 // CALIBRATION", sub: "SHOW ME HOW YOU MOVE", color: "bone", at: performance.now() };
    this.runIdPromise = this.session ? startRun(this.session.playerId) : Promise.resolve(null);
    void this.runIdPromise.then((id) => {
      if (this.director === director) director.runId = id;
    });
    this.openingLines(director, memory);
    this.notify();
  }

  private openingLines(d: Director, memory: MemorySummary | null) {
    const tag = this.view.playerTag;
    if (!memory || memory.runs === 0) {
      d.sys(`NEW SUBJECT ${tag}`);
      d.say("Show me how you move.", "local", null);
      return;
    }
    d.sys(`SUBJECT ${tag} // RUN ${memory.runs + 1}`);
    d.say("I remember you.", "local", null);
    const p = memory.prior;
    const side = (s: string | null) => (s === "L" ? "left" : s === "R" ? "right" : null);
    if (p.wallParkSide && side(p.wallParkSide)) d.note(`prior: parks on the ${side(p.wallParkSide)} wall`);
    else if (p.panicSide && side(p.panicSide)) d.note(`prior: flees ${side(p.panicSide)} under threat`);
    if (p.bestAbility) d.note(`prior: ${p.bestAbility} worked on you`);
    if (memory.notes[0]) d.note(`memory: ${memory.notes[0]}`.slice(0, 90));
  }

  restartRun() {
    if (this.screen === "game" || this.screen === "summary") this.startRun();
  }

  setAutopilot(profile: keyof typeof PROFILES | null) {
    this.autopilot = profile ? new Bot(PROFILES[profile]) : null;
  }

  toggleAgentView() {
    this.agentView = !this.agentView;
    this.view.agentView = this.agentView;
    this.notify();
    requestAnimationFrame(() => this.resize());
  }

  // ------------------------------------------------------------------ input
  private onKeyDown = (e: KeyboardEvent) => {
    const k = KEYMAP[e.code];
    if (k || e.code === "Space") e.preventDefault();
    if (e.repeat && !k) return;
    if (this.screen === "title") {
      if (e.code === "Space" || e.code === "Enter") this.requestStart();
      if (e.code === "KeyD") this.toggleAgentView();
      return;
    }
    if (this.screen === "summary") {
      if (e.code === "Enter" || e.code === "KeyR" || e.code === "Space") this.startRun();
      if (e.code === "KeyD") this.toggleAgentView();
      return;
    }
    if (k) this.keys[k] = true;
    if (e.code === "KeyD") this.toggleAgentView();
    if (e.code === "KeyM") {
      sfx.setMuted(!sfx.muted);
      this.notify();
    }
    if (e.code === "Escape" || e.code === "KeyP") this.setPaused(!this.paused);
    if (e.code === "KeyR" && this.paused) this.startRun();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const k = KEYMAP[e.code];
    if (k) this.keys[k] = false;
  };

  private onBlur = () => {
    this.focused = false;
    this.keys = { ...NO_INPUT };
    if (this.screen === "game") this.setPaused(true);
    this.notify();
  };

  private onFocus = () => {
    this.focused = true;
    this.notify();
  };

  setPaused(p: boolean) {
    if (this.screen !== "game" || !this.game) return;
    this.paused = p;
    this.game.pause(p);
    this.notify();
  }

  // ------------------------------------------------------------------ loop
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dtMs = Math.min(100, now - this.last);
    this.last = now;
    const g = this.game;

    if (this.screen === "game" && g && this.director && this.model && !this.paused) {
      this.acc += (dtMs / 1000) * this.timeScale;
      let steps = 0;
      const maxSteps = 12 * this.timeScale;
      const allEvents: GameEvent[] = [];
      while (this.acc >= PHYS.dt && steps < maxSteps) {
        g.setInput(this.autopilot ? this.autopilot.decide(g) : this.keys);
        g.step(PHYS.dt);
        if (g.phase === "playing") this.model.sample(g, PHYS.dt);
        const evs = g.drainEvents();
        for (const e of evs) {
          this.model.onEvent(e, g);
          this.autopilot?.onEvent(e, g);
        }
        allEvents.push(...evs);
        this.acc -= PHYS.dt;
        steps++;
      }
      if (steps === maxSteps) this.acc = 0;
      this.director.tick(allEvents);
      for (const e of allEvents) this.react(e);
      this.audioFrame();
      if (now - this.lastFlush > 5000) {
        this.lastFlush = now;
        sendEvents(this.director.runId, this.director.drainTracked());
      }
    }
    if (this.screen === "win") this.winFrame(now);

    this.updateView(now);
    this.renderer?.render(g as Game, this.view, now);

    const dv = this.director?.version ?? -1;
    if ((dv !== this.lastDirectorVersion && now - this.lastNotify > 60) || now - this.lastNotify > 250) {
      this.lastDirectorVersion = dv;
      this.lastNotify = now;
      this.notify();
    }
  };

  private audioFrame() {
    const g = this.game!;
    if (g.phase === "playing") {
      sfx.motors(g.bar.vL, g.bar.vR, PHYS.motorSpeed);
      sfx.roll(Math.abs(g.ball.vx) / PHYS.maxVx, true);
      sfx.strain(g.bar.strainL > 0 || g.bar.strainR > 0);
    } else {
      sfx.motors(0, 0, PHYS.motorSpeed);
      sfx.roll(0, false);
      sfx.strain(false);
    }
    sfx.hum(true, g.chamber.template === "MODEL" ? 1 : g.chamber.index / 6);
  }

  private react(e: GameEvent) {
    const g = this.game!;
    const d = this.director!;
    const now = performance.now();
    switch (e.type) {
      case "telegraph":
        sfx.telegraph(e.effect.order.ability);
        this.view.glitch = Math.max(this.view.glitch, 0.35 + g.chamber.index * 0.08);
        break;
      case "activate":
        sfx.activate(e.effect.order.ability);
        break;
      case "wall_hit":
        sfx.wallClack(Math.min(1, e.speed / PHYS.maxVx));
        break;
      case "lip":
        sfx.lipRattle();
        break;
      case "death": {
        sfx.death();
        const cause = e.cause !== null ? g.effects.find((q) => q.id === e.cause)?.order.ability : null;
        this.view.banner = {
          text: "BALL LOST",
          sub: cause ? `CAUSE: ${e.holeId} // ${cause}` : `CAUSE: ${e.holeId}`,
          color: "red",
          at: now,
        };
        this.view.glitch = Math.max(this.view.glitch, 0.6);
        break;
      }
      case "respawn":
        sfx.respawn();
        break;
      case "checkpoint":
        sfx.checkpoint(e.chamber + 1);
        // the final exit leads straight into the win sequence; no banner over "RIG OFFLINE"
        if (e.chamber + 1 < g.totalChambers)
          this.view.banner = { text: `CHECKPOINT ${String(e.chamber + 1).padStart(2, "0")}`, color: "amber", at: now };
        if (e.chamber + 1 < g.totalChambers) setTimeout(() => sfx.transition(), TIMING.checkpointHoldMs);
        break;
      case "chamber_start": {
        if (e.chamber === 0) break;
        const def = g.chamber;
        const n = String(def.index + 1).padStart(2, "0");
        if (def.template === "MODEL") {
          const fp = d.finalPlan?.plan;
          const secs = Math.round(g.clock / 1000);
          this.view.banner = {
            text: `CH-${n} // MODEL`,
            sub: `BUILT FROM ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} OF YOU`,
            color: "rig",
            at: now,
          };
          this.view.modelReveal = { holeIds: def.revealHoles, startedAt: now + 600 };
          d.say(fp?.revealLine || "I think I've got you now.", d.finalPlan?.source ?? "local", null);
          if (fp?.claim) d.note(`model: ${fp.claim}`.slice(0, 90));
          g.maxConcurrent = 1;
        } else {
          const plan = d.plans[def.index];
          this.view.banner = { text: `CH-${n} // ${def.name}`, sub: plan ? plan.reason.toUpperCase().slice(0, 44) : undefined, color: "bone", at: now };
        }
        break;
      }
      case "won":
        this.beginWin();
        break;
    }
  }

  private updateView(now: number) {
    const g = this.game;
    const d = this.director;
    this.view.reducedMotion = this.reducedMotion;
    this.view.agentView = this.agentView;
    this.view.glitch = Math.max(0, this.view.glitch - 0.02);
    if (this.view.banner && now - this.view.banner.at > 2600) this.view.banner = null;
    if (!g || !d) {
      this.view.eye = this.screen === "title" ? "tracking" : "idle";
      return;
    }
    const idx = g.chamber.index;
    this.view.infection = g.chamber.template === "MODEL" ? 1 : Math.min(0.85, idx / 4);
    if (this.screen === "game") this.view.eye = (d.eye.mood === "tracking" ? "tracking" : d.eye.mood) as EyeState;
  }

  // ------------------------------------------------------------------ win
  private beginWin() {
    const g = this.game!;
    const d = this.director!;
    this.screen = "win";
    this.view.screen = "offline";
    this.view.banner = null;
    this.view.eye = "offline";
    this.winStage = 0;
    this.winAt = performance.now();
    sfx.offline();
    const summary = this.buildSummary("escaped");
    this.result = { summary, rigEnd: null, rigEndSource: null, timeMs: g.clock };
    sendEvents(d.runId, d.drainTracked());
    void (async () => {
      const end = await d.requestRunEnd({ result: "escaped", deaths: g.totalDeaths, timeMs: Math.round(g.clock) });
      if (this.result) {
        this.result.rigEnd = end;
        this.result.rigEndSource = d.runEnd?.source ?? null;
      }
      const runId = (await this.runIdPromise) ?? d.runId;
      if (this.session) {
        const r = await endRun(runId, this.session.playerId, summary, end);
        if (r && this.session) {
          this.session.memory = r.memory;
          this.session.memorySummary = r.memorySummary;
        }
      }
      this.notify();
    })();
    this.notify();
  }

  private winFrame(now: number) {
    const t = now - this.winAt;
    if (this.winStage === 0 && t > 2300) {
      this.winStage = 1;
      sfx.rigReturns();
      this.notify();
    }
    if (this.winStage === 1 && t > 4200) {
      this.winStage = 2;
      this.view.eye = "smug";
      this.notify();
    }
    if (this.winStage === 2 && t > 5600) {
      this.screen = "summary";
      this.view.screen = "offline";
      this.notify();
    }
  }

  buildSummary(result: "escaped" | "abandoned"): RunSummary {
    const g = this.game!;
    const d = this.director!;
    const m = this.model!;
    return {
      result,
      durationMs: Math.round(g.clock),
      deaths: g.totalDeaths,
      chambers: d.stats.map((c) => ({ template: c.template as RunSummary["chambers"][number]["template"], deaths: c.deaths, timeMs: c.timeMs })),
      model: m.snapshot(),
      restingSpots: m.restingSpots(),
      ledger: d.ledger,
      calls: { live: d.calls.live, local: d.calls.local },
    };
  }
}

export const runtime = new Runtime();

declare global {
  interface Window {
    __rigged?: Runtime;
  }
}
if (typeof window !== "undefined") window.__rigged = runtime;
