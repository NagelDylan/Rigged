import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { classifyError, LiveRig, LiveRigError, type LlmClient } from "../server/rigLive";
import { RigService } from "../server/rigService";
import { MemoryStore } from "../server/store";
import { makeDecision, makeObservation, PROFILES } from "./fixtures";

const obs = makeObservation({ model: PROFILES.RIGHT_HUGGER });
const reply = (text: string, extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  ...extra,
});
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Fake SDK client: `beta` and `plain` are the two create() implementations. */
function fakeClient(beta: (body: any) => unknown, plain: (body: any) => unknown = beta) {
  const calls = { beta: [] as any[], plain: [] as any[] };
  const client: LlmClient = {
    beta: { messages: { create: async (body: any) => (calls.beta.push(body), beta(body)) } },
    messages: { create: async (body: any) => (calls.plain.push(body), plain(body)) },
  };
  return { client, calls };
}

const rigWith = (client: LlmClient, timeoutMs = 9000) => new LiveRig({ client, systemPrompt: "SYS", timeoutMs, log: () => {} });

describe("LiveRig", () => {
  it("returns a validated live decision and sends the right request", async () => {
    const { client, calls } = fakeClient(() => reply(JSON.stringify(makeDecision())));
    const out = await rigWith(client).decide("tactical", obs);
    expect(out.decision.action.ability).toBe("SHIFT");
    expect(out.model).toBe("claude-opus-5-5");
    const body = calls.beta[0];
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.messages[0].content).toContain("OBSERVATION:");
  });

  it("rejects malformed JSON and schema mismatches", async () => {
    await expect(rigWith(fakeClient(() => reply("{not json")).client).decide("tactical", obs)).rejects.toMatchObject({ reason: "malformed_json" });
    await expect(rigWith(fakeClient(() => reply('{"hello":1}')).client).decide("tactical", obs)).rejects.toMatchObject({ reason: "schema" });
    await expect(rigWith(fakeClient(() => reply("", { stop_reason: "refusal" })).client).decide("tactical", obs)).rejects.toMatchObject({ reason: "refusal" });
    await expect(rigWith(fakeClient(() => reply("{", { stop_reason: "max_tokens" })).client).decide("tactical", obs)).rejects.toMatchObject({ reason: "max_tokens" });
  });

  it("times out when the transport hangs", async () => {
    const { client } = fakeClient(() => new Promise(() => {}));
    await expect(rigWith(client, 300).decide("tactical", obs)).rejects.toMatchObject({ reason: "timeout" });
  });

  it("does not retry billing errors on the plain endpoint", async () => {
    const { client, calls } = fakeClient(() => {
      throw apiError(400, "Your credit balance is too low to access the Anthropic API.");
    });
    await expect(rigWith(client).decide("tactical", obs)).rejects.toMatchObject({ reason: "billing" });
    expect(calls.plain).toHaveLength(0);
  });

  it("retries without the beta when the beta is rejected, then remembers", async () => {
    const { client, calls } = fakeClient(
      () => {
        throw apiError(400, "fallbacks: Extra inputs are not permitted");
      },
      () => reply(JSON.stringify(makeDecision())),
    );
    const rig = rigWith(client);
    expect((await rig.decide("tactical", obs)).decision.action.ability).toBe("SHIFT");
    expect(calls.plain[0].betas).toBeUndefined();
    expect(calls.plain[0].fallbacks).toBeUndefined();
    await rig.decide("tactical", obs);
    expect(calls.beta).toHaveLength(1);
    expect(calls.plain).toHaveLength(2);
  });

  it("classifies SDK errors", () => {
    expect(classifyError(new Anthropic.APIConnectionTimeoutError())).toBe("timeout");
    expect(classifyError(new Anthropic.APIConnectionError({ message: "boom" }))).toBe("network");
    expect(classifyError(apiError(401, "bad key"))).toBe("auth");
    expect(classifyError(apiError(429, "slow down"))).toBe("rate_limit");
    expect(classifyError(apiError(529, "overloaded"))).toBe("overloaded");
    expect(classifyError(new LiveRigError("schema"))).toBe("schema");
  });
});

describe("RigService fallback", () => {
  it("falls back to local with a reason, warns once, and opens the circuit on billing", async () => {
    const log = vi.fn();
    const { client, calls } = fakeClient(() => {
      throw apiError(400, "Your credit balance is too low");
    });
    const store = new MemoryStore();
    const svc = new RigService({ live: rigWith(client), store, log });
    const a = await svc.decide({ runId: "r1", kind: "tactical", observation: obs });
    expect(a.source).toBe("local");
    expect(a.fallbackReason).toBe("billing");
    const b = await svc.decide({ runId: "r1", kind: "tactical", observation: { ...obs, epoch: "c2.l2" } });
    expect(b.fallbackReason).toBe("billing");
    expect(calls.beta).toHaveLength(1); // circuit open: no second network call
    expect(log).toHaveBeenCalledTimes(1);
    expect(store.decisions).toHaveLength(2);
  });

  it("dedupes identical in-flight requests and enforces the per-run budget", async () => {
    const { client, calls } = fakeClient(() => reply(JSON.stringify(makeDecision())));
    const svc = new RigService({ live: rigWith(client), store: new MemoryStore(), log: () => {} });
    const req = { runId: "r2", kind: "tactical" as const, observation: obs };
    const [x, y] = await Promise.all([svc.decide(req), svc.decide(req)]);
    expect(x).toBe(y);
    expect(calls.beta).toHaveLength(1);
    for (let i = 1; i < 28; i++) await svc.decide({ ...req, observation: { ...obs, epoch: `e${i}` } });
    const over = await svc.decide({ ...req, observation: { ...obs, epoch: "over" } });
    expect(over.source).toBe("local");
    expect(over.fallbackReason).toBe("budget");
  });

  it("reports local mode without a live rig", async () => {
    const svc = new RigService({ live: null, store: new MemoryStore(), localReason: "no_key" });
    const out = await svc.decide({ runId: null, kind: "final", observation: obs });
    expect(out.source).toBe("local");
    expect(out.fallbackReason).toBe("no_key");
    expect(svc.mode).toBe("local");
  });
});
