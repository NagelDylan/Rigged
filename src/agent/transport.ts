// How the client reaches RIG. The server holds the API key and decides live vs
// local; if the server itself is unreachable the browser falls back to the same
// deterministic local RIG so the game never stalls.
import type { DecideRequest, DecideResponse, FinalPlan, RunEnd, TacticalDecision } from "../shared/rig";
import type { RigTransport } from "./director";
import { localFinalPlan, localRunEnd, localTactical } from "./localRig";

export function localDecide<T>(req: DecideRequest, reason: string | null): DecideResponse<T> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const out =
    req.kind === "tactical"
      ? localTactical(req.observation)
      : req.kind === "final"
        ? localFinalPlan(req.observation)
        : localRunEnd(req.observation, req.extra);
  return {
    decision: out.decision as unknown as T,
    source: "local",
    latencyMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
    model: null,
    fallbackReason: reason,
    repairs: out.repairs,
  };
}

export class HttpTransport implements RigTransport {
  async decide<T>(req: DecideRequest, timeoutMs: number): Promise<DecideResponse<T>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch("/api/rig/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as DecideResponse<T>;
    } catch (err) {
      return localDecide<T>(req, `client fallback: ${(err as Error).name === "AbortError" ? "timeout" : "server unreachable"}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** In-process transport for tests and headless simulation (optional fake latency in game-clock-free ms). */
export class LocalTransport implements RigTransport {
  constructor(private delayMs = 0) {}
  async decide<T>(req: DecideRequest): Promise<DecideResponse<T>> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return localDecide<T>(req, null);
  }
}

export type { TacticalDecision, FinalPlan, RunEnd };
