// Live RIG: one structured-output call to Claude per decision. Any failure
// (HTTP, timeout, refusal, malformed or invalid JSON) becomes a LiveRigError
// with a short reason so the caller can fall back to the local RIG.
import Anthropic from "@anthropic-ai/sdk";
import type { CallKind, FinalPlan, Observation, RunEnd, TacticalDecision } from "../src/shared/rig";
import { RigOutputError, validateFinal, validateRunEnd, validateTactical, type Validated } from "../src/agent/validate";
import { JSON_SCHEMAS } from "./jsonSchemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the SDK client we use — injectable so tests never touch the network. */
export interface LlmClient {
  messages: { create(body: any, opts?: any): PromiseLike<any> };
  beta: { messages: { create(body: any, opts?: any): PromiseLike<any> } };
}

export type LiveFailure =
  | "billing"
  | "auth"
  | "timeout"
  | "network"
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "bad_request"
  | "refusal"
  | "max_tokens"
  | "empty"
  | "malformed_json"
  | "schema";

export class LiveRigError extends Error {
  constructor(
    readonly reason: LiveFailure,
    readonly detail = "",
  ) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
  }
}

export interface LiveRigOptions {
  client: LlmClient;
  systemPrompt: string;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const RETRYABLE: LiveFailure[] = ["rate_limit", "overloaded", "server_error"];

const INSTRUCTIONS: Record<CallKind, string> = {
  tactical:
    "Decide your next move against this player. Follow observe -> hypothesize -> act -> predict. Return one TacticalDecision.",
  final:
    "Design the final MODEL chamber. Synthesize the strongest, best-supported signals (ledger, model, memory). Return one FinalPlan; revealLine <= 10 words.",
  run_end:
    "The run is over (see EXTRA). Return one RunEnd: a verdict <= 12 words, 1-3 durable, specific memory notes with numbers (<= 80 chars each) for next time, and a closing taunt.",
};

export function buildUserContent(kind: CallKind, obs: Observation, extra?: Record<string, unknown>): string {
  const parts = [`KIND: ${kind}`, `TASK: ${INSTRUCTIONS[kind]}`];
  if (kind === "tactical" && obs.wantNextChamber) parts.push("Also choose nextChamber from chamber.remainingTemplates.");
  parts.push(`OBSERVATION: ${JSON.stringify(obs)}`);
  if (extra && Object.keys(extra).length) parts.push(`EXTRA: ${JSON.stringify(extra)}`);
  return parts.join("\n");
}

/** Map an SDK (or SDK-shaped) error to a short fallback reason. */
export function classifyError(e: unknown): LiveFailure {
  if (e instanceof LiveRigError) return e.reason;
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError) return "timeout";
  if (e instanceof Anthropic.APIConnectionError) return "network";
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined;
  if (status === undefined) return (e as Error)?.name === "AbortError" ? "timeout" : "network";
  if (status === 401 || status === 403) return "auth";
  // Billing has no dedicated error class: it is a 400 invalid_request_error, so we
  // must look at the message ("Your credit balance is too low ...").
  if (status === 402 || (status === 400 && /credit balance|billing|purchase credits/i.test(String((e as Error).message)))) return "billing";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server_error";
  return "bad_request";
}

export class LiveRig {
  readonly model: string;
  readonly effort: Effort;
  private useBeta = true;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: LiveRigOptions) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "low";
    this.timeoutMs = opts.timeoutMs ?? 9000;
    this.log = opts.log ?? console.warn;
  }

  async decide(kind: "tactical", obs: Observation, extra?: Record<string, unknown>): Promise<Validated<TacticalDecision> & { model: string }>;
  async decide(kind: CallKind, obs: Observation, extra?: Record<string, unknown>): Promise<Validated<TacticalDecision | FinalPlan | RunEnd> & { model: string }>;
  async decide(kind: CallKind, obs: Observation, extra?: Record<string, unknown>) {
    const deadline = Date.now() + this.timeoutMs;
    const body = {
      model: this.model,
      max_tokens: 2000,
      system: [{ type: "text", text: this.opts.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserContent(kind, obs, extra) }],
      output_config: {
        // Haiku 4.5 does not accept the effort parameter
        ...(this.model.startsWith("claude-haiku") ? {} : { effort: this.effort }),
        format: { type: "json_schema", schema: JSON_SCHEMAS[kind] },
      },
    };
    const msg = await this.callWithRecovery(body, deadline);

    if (msg?.stop_reason === "refusal") throw new LiveRigError("refusal", msg.stop_details?.category ?? "");
    if (msg?.stop_reason === "max_tokens") throw new LiveRigError("max_tokens");
    const text = (Array.isArray(msg?.content) ? msg.content : [])
      .filter((b: { type?: string }) => b?.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("")
      .trim();
    if (!text) throw new LiveRigError("empty");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new LiveRigError("malformed_json", text.slice(0, 60));
    }
    try {
      const validated = kind === "tactical" ? validateTactical(raw, obs) : kind === "final" ? validateFinal(raw, obs) : validateRunEnd(raw, obs);
      return { ...validated, model: typeof msg.model === "string" ? msg.model : this.model };
    } catch (e) {
      if (e instanceof RigOutputError) throw new LiveRigError("schema", e.message);
      throw e;
    }
  }

  private async callWithRecovery(body: Record<string, unknown>, deadline: number): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(body, deadline, this.useBeta);
      } catch (e) {
        const reason = classifyError(e);
        // A non-billing 400 on the beta path most likely means the fallback beta /
        // param was rejected: retry once on the plain endpoint and stop using it.
        if (reason === "bad_request" && this.useBeta) {
          try {
            const msg = await this.send(body, deadline, false);
            this.useBeta = false;
            this.log(`[rig] server-side fallback beta rejected; using plain messages.create from now on.`);
            return msg;
          } catch (e2) {
            throw new LiveRigError(classifyError(e2), errMessage(e2));
          }
        }
        if (RETRYABLE.includes(reason) && attempt === 0 && deadline - Date.now() > 3000) continue;
        throw new LiveRigError(reason, errMessage(e));
      }
    }
  }

  private send(body: Record<string, unknown>, deadline: number, beta: boolean): Promise<any> {
    const remaining = deadline - Date.now();
    if (remaining < 250) return Promise.reject(new LiveRigError("timeout"));
    const ac = new AbortController();
    const reqOpts = { timeout: remaining, maxRetries: 0, signal: ac.signal };
    const call = beta
      ? this.opts.client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: "default" }, reqOpts)
      : this.opts.client.messages.create(body, reqOpts);
    // Belt and braces: never wait past the deadline even if the transport ignores it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new LiveRigError("timeout"));
      }, remaining);
    });
    return Promise.race([Promise.resolve(call), timeout]).finally(() => clearTimeout(timer));
  }
}

const errMessage = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 160);

/** Real SDK client. The key never leaves the server. */
export function createAnthropicClient(apiKey: string): LlmClient {
  return new Anthropic({ apiKey, maxRetries: 0 }) as unknown as LlmClient;
}
