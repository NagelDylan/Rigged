// Routes each decide request to the live RIG or the local one, enforcing the
// per-run live budget, request de-duplication, a billing/auth circuit breaker
// and persistence of every decision.
import type { DecideRequest, DecideResponse, FinalPlan, RunEnd, TacticalDecision } from "../src/shared/rig";
import { localFinalPlan, localRunEnd, localTactical } from "../src/agent/localRig";
import type { Validated } from "../src/agent/validate";
import { LiveRigError, type LiveRig } from "./rigLive";
import type { Store } from "./store";

export const LIVE_CALLS_PER_RUN = 28;
const CIRCUIT_MS = 5 * 60_000; // after billing/auth failures, stay local for a while

type AnyDecision = TacticalDecision | FinalPlan | RunEnd;

export interface RigServiceOptions {
  live: LiveRig | null;
  /** Optional deeper model for the latency-hidden calls (final plan, run end). */
  planner?: LiveRig | null;
  store: Store;
  /** Why live is off when `live` is null ("no_key" | "local_mode"). */
  localReason?: string;
  log?: (msg: string) => void;
  now?: () => number;
}

export class RigService {
  private inflight = new Map<string, Promise<DecideResponse>>();
  private liveCalls = new Map<string, number>();
  private warned = new Set<string>();
  private circuitUntil = 0;
  private circuitReason = "";
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: RigServiceOptions) {
    this.log = opts.log ?? console.warn;
    this.now = opts.now ?? Date.now;
  }

  get mode(): "live" | "local" {
    return this.opts.live ? "live" : "local";
  }
  get model(): string | null {
    return this.opts.live?.model ?? null;
  }

  decide(req: DecideRequest): Promise<DecideResponse> {
    const key = `${req.runId ?? "-"}|${req.kind}|${req.observation.epoch}|${req.observation.trigger}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.run(req).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(req: DecideRequest): Promise<DecideResponse> {
    const t0 = this.now();
    let res: DecideResponse;
    const skip = this.liveSkipReason(req.runId);
    if (skip) {
      res = this.local(req, t0, skip);
    } else {
      const runKey = req.runId ?? "-";
      this.liveCalls.set(runKey, (this.liveCalls.get(runKey) ?? 0) + 1);
      try {
        const rig = req.kind !== "tactical" && this.opts.planner ? this.opts.planner : this.opts.live!;
        const out = await rig.decide(req.kind, req.observation, req.extra);
        res = { decision: out.decision, source: "live", latencyMs: this.now() - t0, model: out.model, fallbackReason: null, repairs: out.repairs };
      } catch (e) {
        const reason = e instanceof LiveRigError ? e.reason : "internal";
        this.warnOnce(reason, e instanceof LiveRigError ? e.detail : String(e));
        if (reason === "billing" || reason === "auth") {
          this.circuitUntil = this.now() + CIRCUIT_MS;
          this.circuitReason = reason;
        }
        res = this.local(req, t0, reason);
      }
    }
    this.persist(req, res);
    return res;
  }

  private liveSkipReason(runId: string | null): string | null {
    if (!this.opts.live) return this.opts.localReason ?? "local_mode";
    if (this.now() < this.circuitUntil) return this.circuitReason;
    if ((this.liveCalls.get(runId ?? "-") ?? 0) >= LIVE_CALLS_PER_RUN) return "budget";
    return null;
  }

  private local(req: DecideRequest, t0: number, fallbackReason: string): DecideResponse {
    const out: Validated<AnyDecision> =
      req.kind === "tactical" ? localTactical(req.observation) : req.kind === "final" ? localFinalPlan(req.observation) : localRunEnd(req.observation, req.extra);
    return { decision: out.decision, source: "local", latencyMs: this.now() - t0, model: null, fallbackReason, repairs: out.repairs };
  }

  private persist(req: DecideRequest, res: DecideResponse) {
    if (!req.runId) return;
    try {
      this.opts.store.recordDecision({
        runId: req.runId,
        kind: req.kind,
        trigger: req.observation.trigger,
        source: res.source,
        model: res.model,
        latencyMs: res.latencyMs,
        decision: res.decision,
        repairs: res.repairs,
        fallbackReason: res.fallbackReason,
      });
    } catch (e) {
      this.warnOnce("persist", (e as Error).message);
    }
  }

  /** One concise warning line per distinct failure reason, not per call. */
  private warnOnce(reason: string, detail: string) {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    this.log(`[rig] live call failed (${reason})${detail ? `: ${detail.slice(0, 120)}` : ""} -> local RIG fallback`);
  }
}
