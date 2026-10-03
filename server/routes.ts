// JSON API. `handle` is transport-free (used directly by tests); `serveApi`
// adapts it to node:http with a body-size limit and safe error handling.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import type { DecideRequest, SessionResponse } from "../src/shared/rig";
import type { RigService } from "./rigService";
import { mergeRun, summarizeMemory, type Store } from "./store";
import { DecideRequestSchema, RunEndRequestSchema, RunEventsSchema, RunStartSchema, SessionRequestSchema } from "./schemas";

export const BODY_LIMIT = 64 * 1024;
const EVENTS_PER_CALL = 200;
const EVENT_DATA_CHARS = 2000;

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ApiDeps {
  store: Store;
  rig: RigService;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `invalid body: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "bad input"}`);
  }
  return r.data;
}

export function createApi({ store, rig, now = () => new Date() }: ApiDeps) {
  const routes: Record<string, (body: unknown) => Promise<unknown> | unknown> = {
    "GET /api/health": () => ({ ok: true, rigMode: rig.mode, model: rig.model, storage: store.kind }),

    "POST /api/session": (body): SessionResponse => {
      const { playerId } = parse(SessionRequestSchema, body);
      const p = store.ensurePlayer(playerId);
      return {
        playerId: p.id,
        rigMode: rig.mode,
        model: rig.model,
        memory: p.memory,
        memorySummary: summarizeMemory(p.memory, now()),
        storage: store.kind,
      };
    },

    "POST /api/run/start": (body) => {
      const { playerId } = parse(RunStartSchema, body);
      const p = store.ensurePlayer(playerId);
      return { runId: store.startRun(p.id), playerId: p.id };
    },

    "POST /api/rig/decide": (body) => rig.decide(parse(DecideRequestSchema, body) as DecideRequest),

    "POST /api/run/events": (body) => {
      const { runId, events } = parse(RunEventsSchema, body);
      if (!store.getRun(runId)) throw new HttpError(404, "unknown run");
      const kept = events.slice(0, EVENTS_PER_CALL).map((e) => {
        const json = e.data === undefined ? undefined : JSON.stringify(e.data);
        return { t: e.t, type: e.type, data: json && json.length > EVENT_DATA_CHARS ? { truncated: true } : e.data };
      });
      return { stored: store.recordEvents(runId, kept), dropped: events.length - kept.length };
    },

    "POST /api/run/end": (body) => {
      const { runId, playerId, summary, rigEnd } = parse(RunEndRequestSchema, body);
      const run = store.getRun(runId);
      if (!run) throw new HttpError(404, "unknown run");
      if (run.playerId !== playerId) throw new HttpError(403, "run belongs to another player");
      const p = store.ensurePlayer(playerId);
      if (run.endedAt) return { memory: p.memory, memorySummary: summarizeMemory(p.memory, now()), alreadyEnded: true };
      const memory = mergeRun(p.memory, summary, rigEnd ?? null, now());
      store.endRun(runId, summary);
      store.saveMemory(p.id, memory);
      return { memory, memorySummary: summarizeMemory(memory, now()) };
    },
  };

  async function handle(method: string, path: string, body: unknown): Promise<ApiResult> {
    const route = routes[`${method} ${path}`];
    if (!route) return { status: 404, body: { error: "not found" } };
    try {
      return { status: 200, body: await route(body) };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(`[api] ${method} ${path} failed:`, (e as Error).message);
      return { status: 500, body: { error: "internal error" } };
    }
  }

  return { handle };
}

export type Api = ReturnType<typeof createApi>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, "body too large"));
        req.removeAllListeners("data");
        req.resume(); // drain the rest so the 413 response can still be delivered
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

/** node:http adapter. */
export async function serveApi(api: Api, req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  let body: unknown = undefined;
  if (req.method === "POST") {
    try {
      const text = await readBody(req);
      body = text.trim() ? JSON.parse(text) : {};
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      return sendJson(res, status, { error: status === 413 ? "body too large" : "invalid JSON" });
    }
  }
  const out = await api.handle(req.method ?? "GET", path, body);
  sendJson(res, out.status, out.body);
}
