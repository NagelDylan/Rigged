// Single entry point. Dev: Vite in middleware mode. Prod: static ./dist with
// SPA fallback. The API lives under /api in both.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { anthropicKey, loadDotEnv } from "./env";
import { createAnthropicClient, LiveRig, type Effort } from "./rigLive";
import { RigService } from "./rigService";
import { createApi, sendJson, serveApi } from "./routes";
import { openStore } from "./store";

loadDotEnv();

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 5173;
const ROOT = process.cwd();

const store = openStore(process.env.RIGGED_DB_PATH || path.join("data", "rigged.db"));

function makeRig(): RigService {
  const key = anthropicKey();
  const forcedLocal = (process.env.RIG_MODE ?? "").toLowerCase() === "local";
  if (!key || forcedLocal) return new RigService({ live: null, store, localReason: forcedLocal ? "local_mode" : "no_key" });
  const systemPrompt = fs.readFileSync(path.join(ROOT, "prompts", "rig-system.md"), "utf8");
  const client = createAnthropicClient(key);
  // In-play tactics need low latency (measured ~3 s Sonnet 5.5 vs ~5 s Opus 5.5 at low effort);
  // the MODEL-chamber plan and end-of-run memory are latency-hidden, so they get the deeper model.
  const live = new LiveRig({
    client,
    systemPrompt,
    model: process.env.RIG_MODEL || "claude-sonnet-5-5",
    effort: (process.env.RIG_EFFORT as Effort) || "low",
  });
  const planner = new LiveRig({
    client,
    systemPrompt,
    model: process.env.RIG_PLANNER_MODEL || "claude-opus-5-5",
    effort: (process.env.RIG_PLANNER_EFFORT as Effort) || "low",
    timeoutMs: 20000,
  });
  return new RigService({ live, planner, store });
}

const rig = makeRig();
const api = createApi({ store, rig });

// ------------------------------------------------------------- static (prod)
const DIST = path.join(ROOT, "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) return sendJson(res, 403, { error: "forbidden" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(urlPath)) return sendJson(res, 404, { error: "not found" }); // missing asset, not a route
    file = path.join(DIST, "index.html"); // SPA fallback
  }
  if (!fs.existsSync(file)) return sendJson(res, 503, { error: "build missing: run npm run build" });
  const immutable = urlPath.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

// -------------------------------------------------------------------- server
async function main() {
  let vite: import("vite").ViteDevServer | null = null;
  if (!PROD) {
    const { createServer } = await import("vite");
    // HMR websocket port derived from PORT so several dev servers can run side by side
    vite = await createServer({ server: { middlewareMode: true, hmr: { port: PORT + 19000 } }, appType: "spa" });
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/")) {
      serveApi(api, req, res).catch((e) => {
        console.error("[api] unhandled:", (e as Error).message);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => sendJson(res, 404, { error: "not found" }));
      return;
    }
    try {
      serveStatic(req, res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  });

  server.listen(PORT, () => {
    const rigLine = rig.mode === "live" ? `LIVE ${rig.model}` : `LOCAL fallback (${anthropicKey() ? "RIG_MODE=local" : "no API key"})`;
    const storeLine = store.kind === "sqlite" ? `sqlite ${store.location}` : "memory";
    console.log(`RIGGED ${PROD ? "prod" : "dev"} on http://localhost:${PORT}  ·  RIG: ${rigLine}  ·  storage: ${storeLine}`);
  });

  const shutdown = () => {
    server.close();
    vite?.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[rigged] failed to start:", (e as Error).message);
  process.exit(1);
});
