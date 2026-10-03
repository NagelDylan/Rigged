// Thin client for the persistence API. Every call is best-effort: the game
// must keep working if the server or database is unavailable.
import type { MemorySummary, PersistedMemory, RigSource, RunEnd, RunSummary, SessionResponse } from "../shared/rig";

const PLAYER_KEY = "rigged.playerId";

function storedPlayerId(): string | null {
  try {
    return localStorage.getItem(PLAYER_KEY);
  } catch {
    return null;
  }
}

async function post<T>(url: string, body: unknown, timeoutMs = 5000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface Session {
  playerId: string;
  rigMode: RigSource;
  model: string | null;
  memory: PersistedMemory | null;
  memorySummary: MemorySummary | null;
  online: boolean;
}

export async function openSession(): Promise<Session> {
  const res = await post<SessionResponse>("/api/session", { playerId: storedPlayerId() ?? undefined });
  if (!res) {
    const id = storedPlayerId() ?? "offline";
    return { playerId: id, rigMode: "local", model: null, memory: null, memorySummary: null, online: false };
  }
  try {
    localStorage.setItem(PLAYER_KEY, res.playerId);
  } catch {
    /* private mode: memory still works for this tab via the server */
  }
  return { playerId: res.playerId, rigMode: res.rigMode, model: res.model, memory: res.memory, memorySummary: res.memorySummary, online: true };
}

export async function startRun(playerId: string): Promise<string | null> {
  const r = await post<{ runId: string }>("/api/run/start", { playerId });
  return r?.runId ?? null;
}

export function sendEvents(runId: string | null, events: { t: number; type: string; data: unknown }[]) {
  if (!runId || events.length === 0) return;
  void post("/api/run/events", { runId, events: events.slice(0, 200) });
}

export async function endRun(runId: string | null, playerId: string, summary: RunSummary, rigEnd: RunEnd | null) {
  if (!runId) return null;
  return post<{ memory: PersistedMemory; memorySummary: MemorySummary | null }>("/api/run/end", {
    runId,
    playerId,
    summary,
    rigEnd: rigEnd ?? undefined,
  });
}

export function playerTag(id: string) {
  return `P-${id.slice(0, 4).toUpperCase()}`;
}
