import { describe, expect, it } from "vitest";
import { createApi } from "../server/routes";
import { RigService } from "../server/rigService";
import { mergeRun, MemoryStore, openStore, parseMemory, SqliteStore, summarizeMemory } from "../server/store";
import { EMPTY_MEMORY, type RunSummary } from "../src/shared/rig";
import { makeObservation, neutralModel, PROFILES } from "./fixtures";
import { deepMerge } from "./fixtures";

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  result: "escaped",
  durationMs: 180_000,
  deaths: 3,
  chambers: [
    { template: "CALIBRATION", deaths: 0, timeMs: 30_000 },
    { template: "FUNNEL", deaths: 3, timeMs: 60_000 },
  ],
  model: deepMerge(neutralModel(), {
    ...PROFILES.RIGHT_HUGGER,
    reactionMs: { v: 500, c: 0.6, n: 8 },
    panicDirection: { v: { L: 1, R: 4, hold: 0, side: "R" }, c: 0.6, n: 5 },
    abilityWeakness: { v: { CRUSH: { used: 3, kills: 2, evaded: 1 } }, c: 0.5, n: 3 },
  }),
  restingSpots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 3, 5],
  ledger: [],
  calls: { live: 0, local: 12 },
  ...over,
});

describe("SqliteStore", () => {
  it("runs a full player/run/decision/event lifecycle", () => {
    const s = new SqliteStore(":memory:");
    const p = s.ensurePlayer(null);
    expect(p.id).toMatch(/^[a-f0-9]{12}$/);
    expect(p.created).toBe(true);
    expect(s.ensurePlayer(p.id).created).toBe(false);
    const runId = s.startRun(p.id);
    expect(s.getRun(runId)).toEqual({ id: runId, playerId: p.id, endedAt: null });
    s.recordDecision({ runId, kind: "tactical", trigger: "confidence", source: "local", model: null, latencyMs: 3, decision: { a: 1 }, repairs: [], fallbackReason: "no_key" });
    expect(s.recordEvents(runId, [{ t: 1, type: "death", data: { cause: "hole" } }, { t: 2, type: "escape" }])).toBe(2);
    s.endRun(runId, summary());
    expect(s.getRun(runId)?.endedAt).toBeTruthy();
    const db = s.rawDb();
    expect((db.prepare("SELECT COUNT(*) n FROM decisions").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBe(2);
    s.close();
  });

  it("migrations are idempotent", () => {
    const s = new SqliteStore(":memory:");
    const v = s.migrate();
    expect(s.migrate()).toBe(v);
    expect(v).toBeGreaterThan(0);
    s.close();
  });

  it("recovers from malformed persisted memory", () => {
    const s = new SqliteStore(":memory:");
    const p = s.ensurePlayer(null);
    s.rawDb().prepare("UPDATE players SET memory_json = ? WHERE id = ?").run("{oops", p.id);
    expect(s.ensurePlayer(p.id).memory).toEqual(EMPTY_MEMORY);
    s.rawDb().prepare("UPDATE players SET memory_json = ? WHERE id = ?").run(JSON.stringify({ runs: "x", panic: 5, notes: [1, "kept"], restingSpots: [1] }), p.id);
    const m = s.ensurePlayer(p.id).memory;
    expect(m.runs).toBe(0);
    expect(m.panic).toEqual(EMPTY_MEMORY.panic);
    expect(m.notes).toEqual(["kept"]);
    expect(m.restingSpots).toHaveLength(12);
    s.close();
  });

  it("falls back to memory when sqlite cannot open", () => {
    const logs: string[] = [];
    const s = openStore("/dev/null/nope/rigged.db", (m) => logs.push(m));
    expect(s.kind).toBe("memory");
    expect(logs).toHaveLength(1);
  });
});

describe("memory merge", () => {
  it("merges a run with EMA, decay and notes", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const m1 = mergeRun(parseMemory(null), summary(), { verdict: "v", memoryNotes: ["Hugs right."], taunt: "t" }, now);
    expect(m1.runs).toBe(1);
    expect(m1.wins).toBe(1);
    expect(m1.bestTimeMs).toBe(180_000);
    expect(m1.laneBias?.R).toBeCloseTo(0.75);
    expect(m1.reactionMs).toBe(500);
    expect(m1.deathsByTemplate.FUNNEL).toBe(3);
    expect(m1.notes).toEqual(["Hugs right."]);

    const m2 = mergeRun(m1, summary({ result: "abandoned", durationMs: 90_000, model: deepMerge(neutralModel(), { reactionMs: { v: 300, c: 0.5, n: 5 } }) }), null, now);
    expect(m2.runs).toBe(2);
    expect(m2.wins).toBe(1);
    expect(m2.bestTimeMs).toBe(180_000);
    expect(m2.reactionMs).toBe(400);
    expect(m2.wallPark.R).toBeCloseTo(11 * 0.7);
    expect(m2.deathsByTemplate.FUNNEL).toBeCloseTo(3 * 0.7 + 3);

    const notes = Array.from({ length: 8 }, (_, i) => `n${i}`);
    expect(mergeRun(m2, summary(), { verdict: "v", memoryNotes: notes, taunt: "t" }, now).notes).toHaveLength(6);
  });

  it("summarizes only real history", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(summarizeMemory(parseMemory(null), now)).toBeNull();
    const m = mergeRun(parseMemory(null), summary(), null, new Date("2026-10-03T09:00:00Z"));
    const s = summarizeMemory(m, now)!;
    expect(s.runs).toBe(1);
    expect(s.prior.panicSide).toBe("R");
    expect(s.prior.wallParkSide).toBe("R");
    expect(s.prior.bestAbility).toBe("CRUSH");
    expect(s.lastSeenHoursAgo).toBe(3);
  });
});

describe("API handlers", () => {
  const setup = () => {
    const store = new MemoryStore();
    const api = createApi({ store, rig: new RigService({ live: null, store, localReason: "no_key" }) });
    return { api, store };
  };

  it("runs session -> start -> decide -> events -> end", async () => {
    const { api } = setup();
    expect((await api.handle("GET", "/api/health", undefined)).body).toMatchObject({ ok: true, rigMode: "local", storage: "memory" });
    const sess = (await api.handle("POST", "/api/session", {})).body as { playerId: string; memorySummary: unknown };
    expect(sess.memorySummary).toBeNull();
    const { runId } = (await api.handle("POST", "/api/run/start", { playerId: sess.playerId })).body as { runId: string };
    const dec = await api.handle("POST", "/api/rig/decide", { runId, kind: "tactical", observation: makeObservation({ model: PROFILES.LEFT_HUGGER }) });
    expect(dec.status).toBe(200);
    expect(dec.body).toMatchObject({ source: "local", fallbackReason: "no_key" });
    expect((await api.handle("POST", "/api/run/events", { runId, events: Array.from({ length: 250 }, (_, i) => ({ t: i, type: "tick" })) })).body).toEqual({ stored: 200, dropped: 50 });
    const end = await api.handle("POST", "/api/run/end", { runId, playerId: sess.playerId, summary: summary() });
    expect(end.status).toBe(200);
    expect((end.body as { memorySummary: { runs: number } }).memorySummary.runs).toBe(1);
    const again = (await api.handle("POST", "/api/session", { playerId: sess.playerId })).body as { memory: { runs: number } };
    expect(again.memory.runs).toBe(1);
  });

  it("returns 400 on bad bodies and 404 on unknown routes", async () => {
    const { api } = setup();
    expect((await api.handle("POST", "/api/rig/decide", { kind: "tactical" })).status).toBe(400);
    expect((await api.handle("POST", "/api/run/start", {})).status).toBe(400);
    expect((await api.handle("GET", "/api/nope", undefined)).status).toBe(404);
  });
});
