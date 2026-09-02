import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { bus } from "../core/events.js";
import { liveStats, systemInfo } from "../core/system.js";
import { logger } from "../core/log.js";

const log = logger("http");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json", ".webmanifest": "application/manifest+json",
};

export function createApp(ctx: StudioContext): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: (o) => (ctx.config.server.corsOrigins.length === 0 ? o || "*" : ctx.config.server.corsOrigins.includes(o) ? o : "") }));

  // Optional API key: protects /api and /v1, never the static UI (the UI sends the key itself).
  app.use("/api/*", authGuard(ctx));
  app.use("/v1/*", authGuard(ctx));

  app.get("/api/v1/health", (c) => c.json({ ok: true, version: ctx.version, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }));
  app.get("/api/v1/system", async (c) => c.json(await systemInfo(ctx.paths.root)));
  app.get("/api/v1/system/live", async (c) => c.json(await liveStats()));
  app.get("/api/v1/config", (c) => c.json(redactConfig(ctx)));

  app.get("/api/v1/jobs", (c) => c.json({ jobs: ctx.jobs.list() }));
  app.get("/api/v1/jobs/:id", (c) => { const j = ctx.jobs.get(c.req.param("id")); return j ? c.json(j) : c.json({ error: "job não encontrado" }, 404); });
  app.post("/api/v1/jobs/:id/cancel", (c) => c.json({ cancelled: ctx.jobs.cancel(c.req.param("id")) }));

  // One event stream for everything: jobs, downloads, engines, system.
  app.get("/api/v1/events", (c) =>
    streamSSE(c, async (stream) => {
      const topics = (c.req.query("topics") ?? "*").split(",");
      const unsub = topics.map((t) => bus.subscribe(t.trim(), (ev) => { void stream.writeSSE({ event: ev.topic, data: JSON.stringify(ev.data), id: String(ev.at) }); }));
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ version: ctx.version }) });
      const ping = setInterval(() => { void stream.writeSSE({ event: "ping", data: String(Date.now()) }); }, 15000);
      stream.onAbort(() => { clearInterval(ping); unsub.forEach((u) => u()); });
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    }));

  // Static UI (web/dist) with SPA fallback.
  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.join(ctx.paths.web, rel);
    if (!file.startsWith(ctx.paths.web)) return c.text("forbidden", 403);
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(ctx.paths.web, "index.html");
    if (!fs.existsSync(target)) return c.text("UI não construída. Rode `npm run build:web`.", 503);
    const ext = path.extname(target).toLowerCase();
    return new Response(fs.createReadStream(target) as unknown as ReadableStream, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600" },
    });
  });

  app.onError((err, c) => { log.error(`${c.req.method} ${c.req.path}: ${err.message}`); return c.json({ error: err.message }, 500); });
  return app;
}

function authGuard(ctx: StudioContext) {
  return async (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined }; json: (b: unknown, s: 401) => Response }, next: () => Promise<void>) => {
    const key = ctx.config.server.apiKey;
    if (!key) return next();
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? c.req.query("api_key");
    if (given !== key) return c.json({ error: { message: "API key inválida ou ausente.", type: "authentication_error" } }, 401);
    return next();
  };
}

function redactConfig(ctx: StudioContext) {
  const c = structuredClone(ctx.config);
  c.server.apiKey = c.server.apiKey ? "•••" : null;
  return c;
}
