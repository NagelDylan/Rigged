// Persistence behind a small Store interface. SqliteStore (better-sqlite3) is
// the default; MemoryStore is used automatically if SQLite cannot open. The
// interface is deliberately synchronous-free of SQLite specifics so a
// libSQL/Turso adapter could implement it later (wrap calls in async there).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  ABILITIES,
  EMPTY_MEMORY,
  type Ability,
  type MemorySummary,
  type PersistedMemory,
  type RunEnd,
  type RunSummary,
  type Side,
  type TemplateName,
} from "../src/shared/rig";

export const newId = () => randomBytes(6).toString("hex"); // 12 hex chars

export interface DecisionRecord {
  runId: string;
  kind: string;
  trigger: string;
  source: string;
  model: string | null;
  latencyMs: number;
  decision: unknown;
  repairs: string[];
  fallbackReason: string | null;
}

export interface RunEvent {
  t: number;
  type: string;
  data?: unknown;
}

export interface Store {
  readonly kind: "sqlite" | "memory";
  readonly location: string; // file path or ":memory:"
  /** Returns the player, creating it (with a fresh id if needed) when unknown. */
  ensurePlayer(id?: string | null): { id: string; memory: PersistedMemory; created: boolean };
  saveMemory(playerId: string, memory: PersistedMemory): void;
  startRun(playerId: string): string;
  getRun(runId: string): { id: string; playerId: string; endedAt: string | null } | null;
  endRun(runId: string, summary: RunSummary): void;
  recordDecision(rec: DecisionRecord): void;
  recordEvents(runId: string, events: RunEvent[]): number;
  close(): void;
}

// -------------------------------------------------------------- memory logic
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const finOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const freshMemory = (): PersistedMemory => structuredClone(EMPTY_MEMORY);

/** Parse persisted memory defensively; anything malformed falls back to defaults. Never throws. */
export function parseMemory(json: string | null | undefined): PersistedMemory {
  const m = freshMemory();
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    return m;
  }
  if (!isObj(raw)) return m;
  m.runs = Math.max(0, Math.floor(fin(raw.runs, 0)));
  m.wins = Math.max(0, Math.floor(fin(raw.wins, 0)));
  m.bestTimeMs = finOrNull(raw.bestTimeMs);
  if (isObj(raw.laneBias)) m.laneBias = { L: fin(raw.laneBias.L, 0), C: fin(raw.laneBias.C, 0), R: fin(raw.laneBias.R, 0) };
  if (isObj(raw.panic)) m.panic = { L: fin(raw.panic.L, 0), R: fin(raw.panic.R, 0), hold: fin(raw.panic.hold, 0) };
  if (isObj(raw.wallPark)) m.wallPark = { L: fin(raw.wallPark.L, 0), R: fin(raw.wallPark.R, 0) };
  m.reactionMs = finOrNull(raw.reactionMs);
  m.style = typeof raw.style === "string" ? raw.style.slice(0, 20) : null;
  if (isObj(raw.abilityStats)) {
    for (const ab of ABILITIES) {
      const s = raw.abilityStats[ab];
      if (isObj(s)) m.abilityStats[ab] = { used: fin(s.used, 0), kills: fin(s.kills, 0), evaded: fin(s.evaded, 0) };
    }
  }
  if (Array.isArray(raw.restingSpots)) m.restingSpots = m.restingSpots.map((_, i) => fin((raw.restingSpots as unknown[])[i], 0));
  if (Array.isArray(raw.notes)) m.notes = raw.notes.filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 80)).slice(-6);
  m.lastRunAt = typeof raw.lastRunAt === "string" ? raw.lastRunAt : null;
  if (isObj(raw.deathsByTemplate)) {
    for (const [k, v] of Object.entries(raw.deathsByTemplate)) if (typeof v === "number" && Number.isFinite(v)) m.deathsByTemplate[k as TemplateName] = v;
  }
  return m;
}

const DECAY = 0.7;
const EMA = 0.5;
const ema = (prev: number | null, next: number) => (prev == null ? next : prev * (1 - EMA) + next * EMA);

/** Fold one finished run into the player's durable memory (pure). */
export function mergeRun(prev: PersistedMemory, s: RunSummary, rigEnd: RunEnd | null | undefined, now: Date): PersistedMemory {
  const m = parseMemory(JSON.stringify(prev)); // defensive deep copy
  const mod = s.model;
  m.runs += 1;
  if (s.result === "escaped") {
    m.wins += 1;
    m.bestTimeMs = m.bestTimeMs == null ? s.durationMs : Math.min(m.bestTimeMs, s.durationMs);
  }
  if (mod.laneBias.c > 0) {
    const v = mod.laneBias.v;
    const prevLB = m.laneBias;
    m.laneBias = { L: r3(ema(prevLB?.L ?? null, v.L)), C: r3(ema(prevLB?.C ?? null, v.C)), R: r3(ema(prevLB?.R ?? null, v.R)) };
  }
  if (mod.reactionMs.v != null) m.reactionMs = Math.round(ema(m.reactionMs, mod.reactionMs.v));
  if (mod.style.c > 0.2) m.style = mod.style.v.label;

  // counts: decay the old evidence first, then add this run's
  m.panic = {
    L: r3(m.panic.L * DECAY + fin(mod.panicDirection.v.L, 0)),
    R: r3(m.panic.R * DECAY + fin(mod.panicDirection.v.R, 0)),
    hold: r3(m.panic.hold * DECAY + fin(mod.panicDirection.v.hold, 0)),
  };
  m.wallPark = { L: r3(m.wallPark.L * DECAY + fin(mod.wallPark.v.L, 0)), R: r3(m.wallPark.R * DECAY + fin(mod.wallPark.v.R, 0)) };
  for (const ab of ABILITIES) {
    const old = m.abilityStats[ab];
    const add = mod.abilityWeakness.v?.[ab];
    if (!old && !add) continue;
    m.abilityStats[ab] = {
      used: r3((old?.used ?? 0) * DECAY + fin(add?.used, 0)),
      kills: r3((old?.kills ?? 0) * DECAY + fin(add?.kills, 0)),
      evaded: r3((old?.evaded ?? 0) * DECAY + fin(add?.evaded, 0)),
    };
  }
  const deaths: Partial<Record<TemplateName, number>> = {};
  for (const [k, v] of Object.entries(m.deathsByTemplate)) deaths[k as TemplateName] = r3(v * DECAY);
  for (const ch of s.chambers) deaths[ch.template] = r3((deaths[ch.template] ?? 0) + fin(ch.deaths, 0));
  m.deathsByTemplate = deaths;
  m.restingSpots = m.restingSpots.map((v, i) => r3(v * DECAY + fin(s.restingSpots[i], 0)));

  if (rigEnd?.memoryNotes?.length) m.notes = [...m.notes, ...rigEnd.memoryNotes.map((n) => n.slice(0, 80))].slice(-6);
  m.lastRunAt = now.toISOString();
  return m;
}

const argmaxKey = <K extends string>(o: Record<K, number>, keys: K[], min = 0): K | null => {
  let best: K | null = null;
  let bv = min;
  for (const k of keys) if (o[k] > bv) [best, bv] = [k, o[k]];
  return best;
};

/** Compact prior for the observation. Null when there is no real history (never fake it). */
export function summarizeMemory(mem: PersistedMemory, now: Date): MemorySummary | null {
  if (!mem || mem.runs === 0) return null;
  const panicKey = argmaxKey(mem.panic, ["L", "R", "hold"], 0.5);
  const panicSide: Side | null = panicKey === "hold" ? "C" : panicKey;
  const wallParkSide = argmaxKey(mem.wallPark, ["L", "R"], 2) as Side | null;
  let bestAbility: Ability | null = null;
  let worstAbility: Ability | null = null;
  let bestKill = 0;
  let bestEvade = 0;
  for (const ab of ABILITIES) {
    const s = mem.abilityStats[ab];
    if (!s || s.used < 1.5) continue;
    const kill = s.kills / s.used;
    const evade = s.evaded / s.used;
    if (kill > bestKill) [bestAbility, bestKill] = [ab, kill];
    if (evade > bestEvade) [worstAbility, bestEvade] = [ab, evade];
  }
  const last = mem.lastRunAt ? Date.parse(mem.lastRunAt) : NaN;
  return {
    runs: mem.runs,
    wins: mem.wins,
    bestTimeMs: mem.bestTimeMs,
    prior: { laneBias: mem.laneBias, panicSide, wallParkSide, reactionMs: mem.reactionMs, style: mem.style, bestAbility, worstAbility },
    notes: mem.notes.slice(-3),
    lastSeenHoursAgo: Number.isFinite(last) ? Math.max(0, Math.round(((now.getTime() - last) / 3_600_000) * 10) / 10) : null,
  };
}

// --------------------------------------------------------------- SqliteStore
const MIGRATIONS: string[] = [
  `CREATE TABLE players (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, memory_json TEXT NOT NULL);
   CREATE TABLE runs (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), started_at TEXT NOT NULL,
     ended_at TEXT, result TEXT, duration_ms INTEGER, deaths INTEGER, summary_json TEXT);
   CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL,
     trigger TEXT, source TEXT NOT NULL, model TEXT, latency_ms INTEGER, decision_json TEXT NOT NULL, repairs_json TEXT, fallback_reason TEXT);
   CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t REAL NOT NULL, type TEXT NOT NULL, data_json TEXT);
   CREATE INDEX idx_runs_player ON runs(player_id);
   CREATE INDEX idx_decisions_run ON decisions(run_id);
   CREATE INDEX idx_events_run ON events(run_id);`,
];

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private db: Database.Database;

  constructor(readonly location: string) {
    if (location !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(location)), { recursive: true });
    this.db = new Database(location);
    try {
      if (location !== ":memory:") this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  /** Applies pending migrations; idempotent (tracked via PRAGMA user_version). */
  migrate(): number {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** Test/maintenance hook. */
  rawDb() {
    return this.db;
  }

  ensurePlayer(id?: string | null) {
    if (id) {
      const row = this.db.prepare("SELECT memory_json FROM players WHERE id = ?").get(id) as { memory_json: string } | undefined;
      if (row) return { id, memory: parseMemory(row.memory_json), created: false };
    }
    const newPlayerId = id && /^[a-f0-9]{12}$/.test(id) ? id : newId();
    const memory = freshMemory();
    this.db.prepare("INSERT INTO players (id, created_at, memory_json) VALUES (?, ?, ?)").run(newPlayerId, new Date().toISOString(), JSON.stringify(memory));
    return { id: newPlayerId, memory, created: true };
  }

  saveMemory(playerId: string, memory: PersistedMemory) {
    this.db.prepare("UPDATE players SET memory_json = ? WHERE id = ?").run(JSON.stringify(memory), playerId);
  }

  startRun(playerId: string) {
    const id = newId();
    this.db.prepare("INSERT INTO runs (id, player_id, started_at) VALUES (?, ?, ?)").run(id, playerId, new Date().toISOString());
    return id;
  }

  getRun(runId: string) {
    const row = this.db.prepare("SELECT id, player_id, ended_at FROM runs WHERE id = ?").get(runId) as
      | { id: string; player_id: string; ended_at: string | null }
      | undefined;
    return row ? { id: row.id, playerId: row.player_id, endedAt: row.ended_at } : null;
  }

  endRun(runId: string, s: RunSummary) {
    this.db
      .prepare("UPDATE runs SET ended_at = ?, result = ?, duration_ms = ?, deaths = ?, summary_json = ? WHERE id = ?")
      .run(new Date().toISOString(), s.result, Math.round(s.durationMs), s.deaths, JSON.stringify(s), runId);
  }

  recordDecision(r: DecisionRecord) {
    this.db
      .prepare(
        `INSERT INTO decisions (run_id, created_at, kind, trigger, source, model, latency_ms, decision_json, repairs_json, fallback_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.runId, new Date().toISOString(), r.kind, r.trigger, r.source, r.model, Math.round(r.latencyMs), JSON.stringify(r.decision), JSON.stringify(r.repairs), r.fallbackReason);
  }

  recordEvents(runId: string, events: RunEvent[]) {
    const ins = this.db.prepare("INSERT INTO events (run_id, t, type, data_json) VALUES (?, ?, ?, ?)");
    this.db.transaction(() => {
      for (const e of events) ins.run(runId, e.t, e.type, e.data === undefined ? null : JSON.stringify(e.data));
    })();
    return events.length;
  }

  close() {
    this.db.close();
  }
}

// --------------------------------------------------------------- MemoryStore
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  readonly location = ":memory:";
  private players = new Map<string, string>(); // id -> memory json
  private runs = new Map<string, { id: string; playerId: string; endedAt: string | null; summary?: RunSummary }>();
  readonly decisions: DecisionRecord[] = [];
  readonly events: (RunEvent & { runId: string })[] = [];

  ensurePlayer(id?: string | null) {
    if (id && this.players.has(id)) return { id, memory: parseMemory(this.players.get(id)), created: false };
    const pid = id && /^[a-f0-9]{12}$/.test(id) ? id : newId();
    const memory = freshMemory();
    this.players.set(pid, JSON.stringify(memory));
    return { id: pid, memory, created: true };
  }
  saveMemory(playerId: string, memory: PersistedMemory) {
    this.players.set(playerId, JSON.stringify(memory));
  }
  startRun(playerId: string) {
    const id = newId();
    this.runs.set(id, { id, playerId, endedAt: null });
    return id;
  }
  getRun(runId: string) {
    const r = this.runs.get(runId);
    return r ? { id: r.id, playerId: r.playerId, endedAt: r.endedAt } : null;
  }
  endRun(runId: string, summary: RunSummary) {
    const r = this.runs.get(runId);
    if (r) Object.assign(r, { endedAt: new Date().toISOString(), summary });
  }
  recordDecision(rec: DecisionRecord) {
    this.decisions.push(rec);
    if (this.decisions.length > 2000) this.decisions.shift();
  }
  recordEvents(runId: string, events: RunEvent[]) {
    for (const e of events) this.events.push({ ...e, runId });
    if (this.events.length > 10000) this.events.splice(0, this.events.length - 10000);
    return events.length;
  }
  close() {}
}

/** Open SQLite, or fall back to memory (logging once) if it cannot open/migrate. */
export function openStore(location: string, log: (msg: string) => void = console.warn): Store {
  try {
    return new SqliteStore(location);
  } catch (e) {
    log(`[rigged] SQLite unavailable at ${location} (${(e as Error).message}); using in-memory store.`);
    return new MemoryStore();
  }
}
