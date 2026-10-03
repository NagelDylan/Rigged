// The Director: decides WHEN to consult RIG, builds the compressed observation,
// applies RIG's structured decision through the fairness layer, keeps the
// hypothesis ledger, grades predictions, and plans the chamber sequence.
// Real-time play never waits on it; every RIG call is async and may be dropped.
import type {
  Ability,
  ActionKind,
  CallKind,
  DecideRequest,
  DecideResponse,
  DecisionOutcome,
  FinalPlan,
  LedgerEntry,
  MemorySummary,
  MiddleTemplate,
  ModelField,
  Observation,
  PlayerModelSnapshot,
  RigSource,
  RunEnd,
  Side,
  TacticalDecision,
  TriggerReason,
} from "../shared/rig";
import { TEMPLATES } from "../shared/rig";
import { buildChamber, laneOf, type ChamberDef } from "../engine/chambers";
import type { Effect, Game, GameEvent } from "../engine/game";
import type { PlayerModel } from "../engine/playerModel";
import { makeRng } from "../engine/rng";
import {
  gapReady,
  newFairnessState,
  pressureFor,
  recordStart,
  rule,
  type FairnessContext,
  type FairnessState,
} from "./fairness";
import { describePrediction, evaluate, windowClosed, type PredictionWatch, type WatchSample } from "./outcome";

export interface RigTransport {
  decide<T>(req: DecideRequest, timeoutMs: number): Promise<DecideResponse<T>>;
}

export type TermKind = "say" | "note" | "sys" | "sealed" | "verdict" | "warn";
export interface TermLine {
  id: number;
  kind: TermKind;
  text: string;
  at: number; // performance.now()-like wall ms
  source?: RigSource;
}

export interface DecisionLog {
  id: string;
  at: number; // run clock
  chamber: number;
  trigger: TriggerReason;
  kind: CallKind;
  source: RigSource;
  latencyMs: number;
  model: string | null;
  fallbackReason: string | null;
  repairs: string[];
  decision: TacticalDecision | null;
  ruling: string; // EXECUTED / ARMED / VETOED: … / STALE / WAIT
  order: string | null;
  sealed: string | null;
  outcome: DecisionOutcome | null;
  digest: string; // key evidence RIG saw
}

export interface ChamberPlan {
  template: MiddleTemplate;
  pressureSide: "L" | "R" | null;
  density: 1 | 2 | 3;
  reason: string;
  source: RigSource;
}

export type EyeMood = "tracking" | "smug" | "annoyed" | "glitch";

const TACTICAL_CAP = 30;
const PER_CHAMBER_CAP = 8;
const MIN_CALL_GAP_MS = 3500;
const IDLE_MS = 12000;
const PRIORITY: Record<TriggerReason, number> = {
  death: 9,
  contradiction: 8,
  final_plan: 8,
  run_end: 10,
  first_read: 7,
  action_resolved: 6,
  confidence: 5,
  plan_next: 5,
  chamber_start: 4,
  idle: 1,
};

let lineSeq = 1;

export class Director {
  readonly game: Game;
  readonly model: PlayerModel;
  readonly transport: RigTransport;
  readonly runSeed: number;
  memory: MemorySummary | null;
  runId: string | null = null;

  ledger: LedgerEntry[] = [];
  log: DecisionLog[] = [];
  lines: TermLine[] = [];
  lastOutcome: DecisionOutcome | null = null;
  fair: FairnessState = newFairnessState();
  plans: Record<number, ChamberPlan> = {};
  finalPlan: { plan: FinalPlan; source: RigSource } | null = null;
  runEnd: { end: RunEnd; source: RigSource } | null = null;
  eye: { mood: EyeMood; until: number } = { mood: "tracking", until: 0 };
  calls = { live: 0, local: 0, tactical: 0 };
  inFlight: { trigger: TriggerReason; kind: CallKind; startedAt: number } | null = null;
  liveModel: string | null = null;
  lastSource: RigSource | null = null;
  version = 0; // bump to notify UI

  private pending: TriggerReason | null = null;
  private chamberCalls = 0;
  private lastCallAt = -1e9;
  private lastDecisionAt = 0;
  private watch: PredictionWatch | null = null;
  private watchEffect = new Map<number, string>(); // effect id → decision id
  private recentEvents: { at: number; text: string }[] = [];
  private recentTaunts: string[] = [];
  private abilityUses: Partial<Record<ActionKind, number>> = {};
  private firstReadDone = false;
  private confidenceMarks = new Set<string>();
  private remaining: MiddleTemplate[] = [...TEMPLATES];
  private chamberStats: { template: string; deaths: number; timeMs: number }[] = [];
  private cleanChambers = 0;
  private lastDeathAt: number | null = null;
  private lastLane: Side = "C";
  private nowWall: () => number;
  private finalRequested = false;
  private pendingEvents: { t: number; type: string; data: unknown }[] = [];

  constructor(opts: {
    game: Game;
    model: PlayerModel;
    transport: RigTransport;
    memory: MemorySummary | null;
    seed: number;
    now?: () => number;
  }) {
    this.game = opts.game;
    this.model = opts.model;
    this.transport = opts.transport;
    this.memory = opts.memory;
    this.runSeed = opts.seed;
    this.nowWall = opts.now ?? (() => performance.now());
    this.game.nextChamber = (i) => this.supplyChamber(i);
    this.game.gate = (e) => this.gate(e);
  }

  // ------------------------------------------------------------------ chambers
  static firstChamber(seed: number): ChamberDef {
    return buildChamber(0, "CALIBRATION", { pressureSide: null, density: 1, exitSide: "C", seed });
  }

  private supplyChamber(index: number): ChamberDef | null {
    if (index >= this.game.totalChambers) return null;
    const seed = this.runSeed + index * 101;
    if (index === this.game.totalChambers - 1) {
      const fp = this.finalPlan?.plan ?? this.localFinalPlanSync();
      const def = buildChamber(
        index,
        "MODEL",
        { pressureSide: fp.trapSide, density: 2, exitSide: fp.exitSide, seed },
        {
          trapSide: fp.trapSide,
          exitSide: fp.exitSide,
          restingSpots: this.model.restingSpots(),
          useRestingSpots: fp.useRestingSpots,
        },
      );
      return def;
    }
    const plan = this.plans[index] ?? this.localPlan(index);
    this.plans[index] = plan;
    this.remaining = this.remaining.filter((t) => t !== plan.template);
    const snap = this.model.snapshot();
    // exit sits on the side the player favours least: they must reposition
    const fav = snap.laneBias.v.L > snap.laneBias.v.R ? "L" : "R";
    const exitSide: Side = plan.template === "TOWER" ? "C" : fav === "L" ? "R" : "L";
    return buildChamber(index, plan.template, { pressureSide: plan.pressureSide, density: plan.density, exitSide, seed });
  }

  private localPlan(index: number): ChamberPlan {
    const s = this.model.snapshot();
    const fav: "L" | "R" = s.laneBias.v.L > s.laneBias.v.R ? "L" : "R";
    const pref: MiddleTemplate[] = [];
    if (s.wallPark.v.side && s.wallPark.c > 0.5) pref.push("FUNNEL");
    if (s.laneBias.c > 0.5 && Math.max(s.laneBias.v.L, s.laneBias.v.R) > 0.45) pref.push("SPLITTER");
    if (s.panicDirection.v.side) pref.push("EYE");
    if (s.correctionRate.v > 3) pref.push("HOURGLASS");
    pref.push("TOWER", "SPLITTER", "FUNNEL", "EYE", "HOURGLASS");
    const template = pref.find((t) => this.remaining.includes(t)) ?? this.remaining[0] ?? "SPLITTER";
    return {
      template,
      pressureSide: fav,
      density: (Math.min(3, 1 + Math.floor(index / 2) + (this.cleanChambers >= 1 ? 1 : 0)) as 1 | 2 | 3),
      reason: "local plan",
      source: "local",
    };
  }

  private localFinalPlanSync(): FinalPlan {
    const s = this.model.snapshot();
    const fav: "L" | "R" = s.laneBias.v.L > s.laneBias.v.R ? "L" : "R";
    const targets: ModelField[] = ["laneBias"];
    if (s.panicDirection.v.side) targets.push("panicDirection");
    if (s.wallPark.v.side) targets.push("wallPark");
    return {
      observation: "fallback plan",
      claim: `Comfort lives on the ${fav === "L" ? "left" : "right"}.`,
      targets: targets.slice(0, 3),
      trapSide: fav,
      exitSide: fav === "L" ? "R" : "L",
      loadout: ["SHIFT", "PULSE"],
      useRestingSpots: true,
      revealLine: "Built from you.",
      taunt: "I know where you stop.",
    };
  }

  // ------------------------------------------------------------------ per-frame
  /** Call once per rendered frame after stepping the game. */
  tick(events: GameEvent[]) {
    const g = this.game;
    for (const e of events) this.onEvent(e);
    if (g.phase === "playing") {
      this.sampleWatch();
      this.checkTriggers();
      const lane = g.lane;
      if (lane !== this.lastLane) {
        this.pushEvent(`ball → ${lane} lane`);
        this.lastLane = lane;
      }
    }
    // don't interrupt RIG's own experiment: hold routine triggers while a prediction
    // window is open or an order is armed/running (deaths and contradictions still go through)
    const busy =
      this.watch !== null || g.effects.some((e) => e.phase === "armed" || e.phase === "telegraph" || e.phase === "active");
    const urgent = this.pending !== null && PRIORITY[this.pending] >= 7;
    if (
      this.pending &&
      !this.inFlight &&
      g.phase === "playing" &&
      (!busy || urgent) &&
      g.clock - this.lastCallAt >= MIN_CALL_GAP_MS
    ) {
      const t = this.pending;
      this.pending = null;
      void this.requestTactical(t);
    }
    if (this.eye.until && this.nowWall() > this.eye.until) {
      this.eye = { mood: "tracking", until: 0 };
      this.version++;
    }
  }

  private onEvent(e: GameEvent) {
    const g = this.game;
    switch (e.type) {
      case "telegraph": {
        recordStart(this.fair, e.effect.order.ability, e.effect.order.side, g.clock, g.chamber.index);
        this.pushEvent(`${e.effect.order.ability} ${e.effect.order.side} telegraph`);
        const did = this.watchEffect.get(e.effect.id);
        if (did && this.watch && this.watch.decisionId === did && this.watch.anchorAt === null) {
          this.openWatch(this.watch);
        }
        const log = this.log.find((l) => l.id === e.effect.order.decisionId);
        if (log) log.ruling = "EXECUTED";
        this.track("telegraph", { ability: e.effect.order.ability, side: e.effect.order.side, intensity: e.effect.order.intensity });
        this.version++;
        break;
      }
      case "fizzle": {
        const log = this.log.find((l) => l.id === e.effect.order.decisionId);
        if (log && log.ruling.startsWith("ARMED")) log.ruling = `FIZZLED: ${e.reason}`;
        if (this.watch && this.watchEffect.get(e.effect.id) === this.watch.decisionId) {
          const p = this.watch.prediction;
          if (e.reason === "expired" && (p.event === "enter_lane" || p.event === "avoid_lane") && this.watch.samples.length) {
            // the predicted lane never happened before the order expired: grade the whole armed period
            const first = (this.watch.samples[0] as PreSample | undefined)?._c ?? g.clock;
            this.watch.anchorAt = first;
            this.watch.samples = this.watch.samples.map((q) => ({ ...q, t: (q as PreSample)._c - first }));
            this.closeWatch();
          } else if (e.reason !== "death") {
            this.watch.fizzled = e.reason;
            this.closeWatch();
          }
        }
        this.version++;
        break;
      }
      case "effect_end":
        this.pushEvent(`${e.effect.order.ability} ended${e.effect.killed ? " (kill)" : ""}`);
        break;
      case "death": {
        this.lastDeathAt = g.clock;
        const cause = e.cause !== null ? g.effects.find((q) => q.id === e.cause)?.order.ability : null;
        this.pushEvent(`death at ${e.holeId}${cause ? ` during ${cause}` : ""}`);
        this.track("death", { hole: e.holeId, cause, chamber: g.chamber.index });
        if (this.watch && this.watch.anchorAt !== null && this.watch.diedAtMs === null) {
          this.watch.diedAtMs = g.clock - this.watch.anchorAt;
          this.closeWatch();
        } else if (this.watch && this.watch.anchorAt === null) {
          this.watch = null;
        }
        if (cause) this.setEye("smug", 1800);
        this.queue("death");
        break;
      }
      case "chamber_start": {
        this.fair.jamThisChamber = 0;
        this.chamberCalls = 0;
        this.firstReadDone = this.firstReadDone || e.chamber > 0;
        this.watch = null;
        if (e.chamber > 0) this.queue("chamber_start");
        this.track("chamber_start", { chamber: e.chamber, template: g.chamber.template });
        if (g.chamber.template === "MODEL") this.lastCallAt = -1e9;
        break;
      }
      case "checkpoint": {
        const deaths = g.deathsHere;
        this.chamberStats.push({ template: g.chamber.template, deaths, timeMs: Math.round(g.chamberClock) });
        this.cleanChambers = deaths === 0 ? this.cleanChambers + 1 : 0;
        this.pushEvent(`cleared chamber ${e.chamber + 1} (${deaths} deaths)`);
        this.track("checkpoint", { chamber: e.chamber, deaths, timeMs: Math.round(g.chamberClock) });
        if (this.watch && this.watch.anchorAt !== null) this.closeWatch();
        this.watch = null;
        break;
      }
    }
  }

  // ------------------------------------------------------------------ triggers
  private checkTriggers() {
    const g = this.game;
    const snap = this.model.snapshot();
    const idx = g.chamber.index;
    if (idx === 0 && !this.firstReadDone) {
      const t = g.chamberClock;
      const wallStrong = snap.wallPark.c >= 0.6 && snap.wallPark.v.side !== null;
      const laneStrong = snap.laneBias.c >= 0.7 && Math.max(snap.laneBias.v.L, snap.laneBias.v.R) >= 0.6;
      if ((t > 8000 && (wallStrong || laneStrong)) || t > 15000) {
        this.firstReadDone = true;
        this.queue("first_read");
      }
      return;
    }
    for (const [field, c] of [
      ["laneBias", snap.laneBias.c],
      ["panicDirection", snap.panicDirection.c],
      ["wallPark", snap.wallPark.c],
    ] as const) {
      for (const mark of [0.5, 0.8]) {
        const key = `${field}:${mark}`;
        if (c >= mark && !this.confidenceMarks.has(key)) {
          this.confidenceMarks.add(key);
          if (idx > 0) this.queue("confidence");
        }
      }
    }
    if (idx > 0 && g.clock - this.lastDecisionAt > IDLE_MS && !this.inFlight) this.queue("idle");
    if (idx > 0 && idx < g.totalChambers - 2 && g.progress > 0.45 && !this.plans[idx + 1]) this.queue("plan_next");
    if (idx === g.totalChambers - 2 && g.progress > 0.3 && !this.finalRequested) {
      this.finalRequested = true;
      void this.requestFinal();
    }
  }

  queue(t: TriggerReason) {
    if (this.calls.tactical >= TACTICAL_CAP && t !== "run_end") return;
    if (this.chamberCalls >= PER_CHAMBER_CAP && t !== "chamber_start") return;
    if (!this.pending || PRIORITY[t] > PRIORITY[this.pending]) this.pending = t;
  }

  // ------------------------------------------------------------------ fairness gate
  private ctx(): FairnessContext {
    const g = this.game;
    return {
      chamber: g.chamber.index,
      isFinal: g.chamber.template === "MODEL",
      clock: g.clock,
      deathsHere: g.deathsHere,
      lastDeathAt: this.lastDeathAt,
      cleanChambers: this.cleanChambers,
      progress: g.progress,
      reactionMs: this.model.snapshot().reactionMs.v,
      protectedUntil: g.protectedUntil,
    };
  }

  private gate(_e: Effect) {
    return gapReady(this.ctx(), this.fair);
  }

  // ------------------------------------------------------------------ observation
  buildObservation(trigger: TriggerReason): Observation {
    const g = this.game;
    const snap = this.model.snapshot();
    const ctx = this.ctx();
    const ball = g.ball;
    const holes = g.chamber.holes
      .filter((h) => h.y > ball.y - 40)
      .sort((a, b) => a.y - b.y)
      .slice(0, 8)
      .map((h) => ({ id: h.id, side: laneOf(g.chamber, h.x, h.y), y: Math.round((h.y / g.chamber.H) * 100) / 100 }));
    const now = g.clock;
    return {
      epoch: g.epoch,
      trigger,
      callsLeft: Math.max(0, TACTICAL_CAP - this.calls.tactical),
      runClock: Math.round(now / 100) / 10,
      chamber: {
        n: g.chamber.index + 1,
        of: g.totalChambers,
        template: g.chamber.template,
        progress: Math.round(g.progress * 100) / 100,
        exitSide: laneOf(g.chamber, g.chamber.exit.x, g.chamber.exit.y),
        deathsHere: g.deathsHere,
        holes,
        remainingTemplates: this.remaining.filter((t) => !Object.values(this.plans).some((p) => p.template === t)),
      },
      ball: {
        lane: g.lane,
        vxSign: Math.abs(ball.vx) < 5 ? 0 : ball.vx > 0 ? 1 : -1,
        stationaryMs: 0,
      },
      pressure: pressureFor(ctx, this.fair),
      model: snap,
      events: this.recentEvents.slice(-8).map((e) => `t-${((now - e.at) / 1000).toFixed(1)} ${e.text}`),
      lastOutcome: this.lastOutcome,
      ledger: this.ledger.filter((l) => l.status === "active").slice(-5),
      memory: this.memory,
      variety: { abilityUses: { ...this.abilityUses }, recentTaunts: this.recentTaunts.slice(-5) },
      wantNextChamber:
        g.chamber.index > 0 && g.chamber.index < g.totalChambers - 2 && !this.plans[g.chamber.index + 1] && g.progress > 0.3,
    };
  }

  private digest(o: Observation) {
    const m = o.model;
    const parts: string[] = [];
    parts.push(`lane L${pct(m.laneBias.v.L)} C${pct(m.laneBias.v.C)} R${pct(m.laneBias.v.R)} (c${m.laneBias.c})`);
    if (m.wallPark.n > 0) parts.push(`wall L${m.wallPark.v.L}s R${m.wallPark.v.R}s`);
    if (m.panicDirection.n > 0) parts.push(`panic L${m.panicDirection.v.L}/R${m.panicDirection.v.R}/hold${m.panicDirection.v.hold}`);
    if (m.reactionMs.v) parts.push(`react ${m.reactionMs.v}ms`);
    parts.push(m.style.v.label);
    return parts.join(" · ");
  }

  // ------------------------------------------------------------------ calls
  private async requestTactical(trigger: TriggerReason) {
    const g = this.game;
    if (this.inFlight) return;
    const obs = this.buildObservation(trigger);
    const epochAtRequest = g.epoch;
    const chamberAtRequest = g.chamber.index;
    this.inFlight = { trigger, kind: "tactical", startedAt: this.nowWall() };
    this.lastCallAt = g.clock;
    this.calls.tactical++;
    this.chamberCalls++;
    this.version++;
    let res: DecideResponse<TacticalDecision>;
    try {
      res = await this.transport.decide<TacticalDecision>({ runId: this.runId, kind: "tactical", observation: obs }, 12000);
    } catch {
      this.inFlight = null;
      return;
    }
    this.inFlight = null;
    this.lastDecisionAt = g.clock;
    this.countSource(res);
    this.applyTactical(res, obs, epochAtRequest, chamberAtRequest);
  }

  private countSource(res: DecideResponse<unknown>) {
    if (res.source === "live") {
      this.calls.live++;
      this.liveModel = res.model;
    } else this.calls.local++;
    this.lastSource = res.source;
  }

  applyTactical(res: DecideResponse<TacticalDecision>, obs: Observation, epochAtRequest: string, chamberAtRequest: number) {
    const g = this.game;
    const d = res.decision;
    const id = `d${this.log.length + 1}`;
    const entry: DecisionLog = {
      id,
      at: g.clock,
      chamber: chamberAtRequest,
      trigger: obs.trigger,
      kind: "tactical",
      source: res.source,
      latencyMs: res.latencyMs,
      model: res.model,
      fallbackReason: res.fallbackReason,
      repairs: res.repairs,
      decision: d,
      ruling: "",
      order: null,
      sealed: d.prediction ? describePrediction(d.prediction) : null,
      outcome: null,
      digest: this.digest(obs),
    };
    this.log.push(entry);
    if (this.log.length > 60) this.log.shift();

    // hypothesis ledger is updated even when the action is stale
    const hypId = this.updateLedger(d, res.source);

    // next chamber choice
    if (d.nextChamber && !this.plans[chamberAtRequest + 1] && chamberAtRequest + 1 < g.totalChambers - 1) {
      if (this.remaining.includes(d.nextChamber.template)) {
        this.plans[chamberAtRequest + 1] = {
          template: d.nextChamber.template,
          pressureSide: d.nextChamber.pressureSide,
          density: Math.max(1, Math.min(3, Math.round(d.nextChamber.density))) as 1 | 2 | 3,
          reason: d.nextChamber.reason,
          source: res.source,
        };
        this.note(`next: ${d.nextChamber.template}. ${d.nextChamber.reason}`.slice(0, 80));
      }
    }

    const stale = g.epoch !== epochAtRequest;
    if (stale) {
      entry.ruling = `STALE (${epochAtRequest} → ${g.epoch}): action dropped`;
      if (g.chamber.index === chamberAtRequest && g.phase === "playing" && d.taunt) this.say(d.taunt, res.source, d.tauntRef);
      this.version++;
      return;
    }
    if (g.phase !== "playing") {
      entry.ruling = `DROPPED: machine ${g.phase}`;
      this.version++;
      return;
    }

    this.say(d.taunt, res.source, d.tauntRef);
    this.abilityUses[d.action.ability] = (this.abilityUses[d.action.ability] ?? 0) + 1;

    const ruling = rule(d, id, this.ctx(), this.fair);
    if (!ruling.ok) {
      entry.ruling = d.action.ability === "WAIT" ? "WAIT" : `VETOED: ${ruling.reason}`;
      if (d.prediction && d.action.ability === "WAIT") this.startWatch(id, d.prediction, null, hypId);
      else if (d.action.ability !== "WAIT") this.note(`director vetoed ${d.action.ability}: ${ruling.reason}`, "warn");
      this.version++;
      return;
    }
    // RIG changed its mind: cancel any armed-but-unfired order
    g.cancelArmed();
    const effect = g.enqueue(ruling.order);
    const o = ruling.order;
    entry.order = `${o.ability} ${o.side} i${o.intensity} ${o.telegraphMs}ms ${
      o.trigger.type === "now" ? "now" : o.trigger.type === "ball_enters" ? `when ball enters ${o.trigger.lane}` : `at ${Math.round((o.trigger.progress ?? 0) * 100)}%`
    }`;
    entry.ruling = o.trigger.type === "now" ? "QUEUED" : "ARMED";
    if (ruling.notes.length) entry.repairs = [...entry.repairs, ...ruling.notes.map((n) => `director: ${n}`)];
    if (d.prediction) this.startWatch(id, d.prediction, effect.id, hypId);
    this.version++;
  }

  private updateLedger(d: TacticalDecision, source: RigSource): string {
    const h = d.hypothesis;
    let entry = h.ref !== "new" ? this.ledger.find((l) => l.id === h.ref) : undefined;
    if (!entry || h.status === "new") {
      const active = this.ledger.filter((l) => l.status === "active");
      if (active.length >= 5) {
        const weakest = active.reduce((a, b) => (b.confidence < a.confidence ? b : a));
        weakest.status = "abandoned";
      }
      entry = {
        id: `h${this.ledger.length + 1}`,
        field: h.field,
        claim: h.claim,
        confidence: h.confidence,
        supported: 0,
        weakened: 0,
        status: "active",
        source,
      };
      this.ledger.push(entry);
      return entry.id;
    }
    if (h.status === "abandon") {
      entry.status = "abandoned";
      entry.confidence = h.confidence;
      this.note(`hypothesis ${entry.id} abandoned`);
      return entry.id;
    }
    entry.claim = h.claim || entry.claim;
    entry.field = h.field;
    entry.confidence = h.confidence;
    entry.status = "active";
    return entry.id;
  }

  private startWatch(decisionId: string, p: NonNullable<TacticalDecision["prediction"]>, effectId: number | null, hypId: string) {
    const g = this.game;
    this.watch = {
      decisionId,
      prediction: p,
      anchorAt: null,
      x0: g.ball.x,
      lane0: g.lane,
      samples: [],
      firstInputMs: null,
      diedAtMs: null,
      effectId,
      fizzled: null,
    };
    (this.watch as PredictionWatch & { hypId?: string }).hypId = hypId;
    this.watch.empiricalBaseline = empiricalBaseline(p, this.model.snapshot());
    if (effectId !== null) this.watchEffect.set(effectId, decisionId);
    else this.openWatch(this.watch);
    this.lines.push({ id: lineSeq++, kind: "sealed", text: "PREDICTION SEALED", at: this.nowWall() });
    this.version++;
  }

  private openWatch(w: PredictionWatch) {
    const g = this.game;
    w.anchorAt = g.clock;
    w.x0 = g.ball.x;
    w.lane0 = g.lane;
    w.samples = [];
  }

  private sampleWatch() {
    const w = this.watch;
    const g = this.game;
    if (!w) return;
    const i = g.input;
    const anyInput = i.lUp || i.lDown || i.rUp || i.rDown;
    if (w.anchorAt === null) {
      // pre-anchor samples let enter/avoid-lane predictions be graded even if the trigger never fires
      const last = w.samples.at(-1) as PreSample | undefined;
      if (!last || g.clock - last._c >= 100) {
        const s: PreSample = { t: -1, x: g.ball.x, lane: g.lane, vx: g.ball.vx, input: anyInput, _c: g.clock };
        w.samples.push(s);
      }
      return;
    }
    const t = g.clock - w.anchorAt;
    const pressed =
      (i.lUp && !g.prevInput.lUp) || (i.lDown && !g.prevInput.lDown) || (i.rUp && !g.prevInput.rUp) || (i.rDown && !g.prevInput.rDown);
    if (pressed && w.firstInputMs === null && t >= 120) w.firstInputMs = t;
    const last = w.samples.at(-1);
    if (!last || t - last.t >= 100) w.samples.push({ t, x: g.ball.x, lane: g.lane, vx: g.ball.vx, input: anyInput });
    if (windowClosed(w, g.clock)) this.closeWatch();
  }

  private closeWatch() {
    const w = this.watch;
    if (!w) return;
    this.watch = null;
    w.samples = w.samples.filter((s) => s.t >= 0);
    const cutShort =
      w.anchorAt !== null && w.diedAtMs === null && !w.fizzled && this.game.clock - w.anchorAt < Math.min(700, w.prediction.windowMs);
    const ev = cutShort
      ? { verdict: "INCONCLUSIVE" as const, observed: "window cut short" }
      : evaluate({ ...w, prediction: { ...w.prediction, pBaseline: Math.max(w.prediction.pBaseline, w.empiricalBaseline ?? 0) } });
    const log = this.log.find((l) => l.id === w.decisionId);
    const hypId = (w as PredictionWatch & { hypId?: string }).hypId;
    const hyp = this.ledger.find((l) => l.id === hypId);
    if (hyp) {
      if (ev.verdict === "SUPPORTED") hyp.supported++;
      if (ev.verdict === "WEAKENED") hyp.weakened++;
    }
    const effect = w.effectId !== null ? this.game.effects.find((e) => e.id === w.effectId) : null;
    const outcome: DecisionOutcome = {
      ability: log?.decision?.action.ability ?? "WAIT",
      side: log?.decision?.action.side ?? null,
      hypothesisId: hypId ?? "?",
      prediction: describePrediction(w.prediction).toLowerCase(),
      verdict: ev.verdict,
      observed: ev.observed,
      killed: !!effect?.killed,
    };
    this.lastOutcome = outcome;
    if (log) log.outcome = outcome;
    const ago = log ? ((this.game.clock - log.at) / 1000).toFixed(1) : "?";
    const mark = ev.verdict === "SUPPORTED" ? "CORRECT" : ev.verdict === "WEAKENED" ? "WRONG" : ev.verdict === "TRIVIAL" ? "OBVIOUS" : "VOID";
    this.lines.push({
      id: lineSeq++,
      kind: "verdict",
      text: `SEALED ${ago}s AGO: ${describePrediction(w.prediction)} — ${mark}`,
      at: this.nowWall(),
    });
    if (ev.verdict === "SUPPORTED") this.setEye("smug", 2200);
    if (ev.verdict === "WEAKENED") this.setEye("annoyed", 2600);
    this.track("outcome", { decision: w.decisionId, verdict: ev.verdict, observed: ev.observed });
    this.queue(ev.verdict === "WEAKENED" && (hyp?.confidence ?? 0) >= 0.6 ? "contradiction" : "action_resolved");
    this.version++;
  }

  private async requestFinal() {
    const obs = this.buildObservation("final_plan");
    const res = await this.transport
      .decide<FinalPlan>(
        { runId: this.runId, kind: "final", observation: obs, extra: { restingSpots: this.model.restingSpots() } },
        14000,
      )
      .catch(() => null);
    if (!res) return;
    this.countSource(res);
    this.finalPlan = { plan: res.decision, source: res.source };
    this.log.push({
      id: `d${this.log.length + 1}`,
      at: this.game.clock,
      chamber: this.game.chamber.index,
      trigger: "final_plan",
      kind: "final",
      source: res.source,
      latencyMs: res.latencyMs,
      model: res.model,
      fallbackReason: res.fallbackReason,
      repairs: res.repairs,
      decision: null,
      ruling: `MODEL PLAN: trap ${res.decision.trapSide}, exit ${res.decision.exitSide}, loadout ${res.decision.loadout.join("+")}`,
      order: null,
      sealed: null,
      outcome: null,
      digest: res.decision.claim,
    });
    this.version++;
  }

  async requestRunEnd(summary: unknown): Promise<RunEnd | null> {
    const obs = this.buildObservation("run_end");
    const res = await this.transport
      .decide<RunEnd>({ runId: this.runId, kind: "run_end", observation: obs, extra: { summary } }, 14000)
      .catch(() => null);
    if (!res) return null;
    this.countSource(res);
    this.runEnd = { end: res.decision, source: res.source };
    this.version++;
    return res.decision;
  }

  // ------------------------------------------------------------------ output
  say(text: string, source: RigSource, ref: ModelField | null) {
    if (!text) return;
    this.lines.push({ id: lineSeq++, kind: "say", text, at: this.nowWall(), source });
    this.recentTaunts.push(text);
    if (this.recentTaunts.length > 8) this.recentTaunts.shift();
    if (ref && ["laneBias", "wallPark", "panicDirection", "motorShare"].includes(ref)) {
      if (!this.model.callout || this.model.callout.field !== ref) this.model.noteCallout(ref, this.game.clock);
    }
    this.setEye("glitch", 260);
    this.version++;
  }

  note(text: string, kind: TermKind = "note") {
    this.lines.push({ id: lineSeq++, kind, text, at: this.nowWall() });
    this.version++;
  }

  sys(text: string) {
    this.note(text, "sys");
  }

  setEye(mood: EyeMood, ms: number) {
    this.eye = { mood, until: this.nowWall() + ms };
    this.version++;
  }

  private pushEvent(text: string) {
    this.recentEvents.push({ at: this.game.clock, text });
    if (this.recentEvents.length > 16) this.recentEvents.shift();
  }

  private track(type: string, data: unknown) {
    this.pendingEvents.push({ t: Math.round(this.game.clock), type, data });
  }

  drainTracked() {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  get stats() {
    return this.chamberStats;
  }

  get callsRemaining() {
    return Math.max(0, TACTICAL_CAP - this.calls.tactical);
  }

  get currentWatch() {
    return this.watch;
  }

  /** Strongest-supported active hypothesis (for summaries). */
  topHypotheses(n = 3) {
    return [...this.ledger]
      .sort((a, b) => b.supported - b.weakened + b.confidence - (a.supported - a.weakened + a.confidence))
      .slice(0, n);
  }

  abilityKills(): Partial<Record<Ability, number>> {
    const out: Partial<Record<Ability, number>> = {};
    for (const [k, v] of Object.entries(this.model.abilities)) out[k as Ability] = v?.kills ?? 0;
    return out;
  }

  seededRng() {
    return makeRng(this.runSeed);
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
type PreSample = WatchSample & { _c: number }; // sample taken before the window opened (absolute clock)

/**
 * What the player's own history says would happen anyway. RIG's self-reported
 * baseline can't be trusted, so predicting an 85% habit is graded TRIVIAL.
 */
export function empiricalBaseline(p: NonNullable<TacticalDecision["prediction"]>, m: PlayerModelSnapshot): number {
  const lane = m.laneBias.v;
  const side = p.side;
  switch (p.event) {
    case "enter_lane":
      return side ? lane[side] : 0;
    case "avoid_lane":
      return side ? 1 - lane[side] : 0;
    case "flee": {
      const pd = m.panicDirection.v;
      const n = pd.L + pd.R + pd.hold;
      if (n < 3 || !side) return 0;
      return (side === "L" ? pd.L : side === "R" ? pd.R : pd.hold) / n;
    }
    default:
      return 0;
  }
}
