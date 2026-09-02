import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { bus } from "../core/events.js";
import { liveStats, systemInfo } from "../core/system.js";
import { logger } from "../core/log.js";
import { addApiKey, fingerprint, keyMatches, RateLimiter, readApiKeys, removeApiKey } from "../core/auth.js";
import { applyConfigPatch, EDITABLE, saveConfig } from "../core/config.js";
import { modelsRoutes } from "./routes/models.js";
import { plannedRoutes } from "./routes/planned.js";
import { enginesRoutes } from "./routes/engines.js";
import { v1Routes } from "./routes/v1.js";
import { imagesRoutes } from "./routes/images.js";
import { audioRoutes } from "./routes/audio.js";
import { agentRoutes } from "./routes/agent.js";
import { projectsRoutes, memoryRoutes } from "./routes/projects.js";
import { meetingsRoutes } from "./routes/meetings.js";

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
  const limiter = new RateLimiter(() => ctx.config.server.rateLimitPerMinute);
  app.use("/api/*", authGuard(ctx, limiter));
  app.use("/v1/*", authGuard(ctx, limiter));
  app.use("/mcp", authGuard(ctx, limiter));
  app.use("/mcp/*", authGuard(ctx, limiter));

  app.get("/api/v1/health", (c) => c.json({ ok: true, version: ctx.version, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }));
  app.get("/api/v1/system", async (c) => c.json(await systemInfo(ctx.paths.root)));
  app.get("/api/v1/system/live", async (c) => c.json(await liveStats()));
  app.get("/api/v1/config", (c) => c.json({ config: redactConfig(ctx), editable: Object.keys(EDITABLE) }));

  // CORE-02: partial update with validation; what can be applied hot is applied hot.
  app.put("/api/v1/config", async (c) => {
    let patch: unknown;
    try { patch = await c.req.json(); } catch { return c.json({ error: "corpo JSON inválido" }, 400); }
    const r = applyConfigPatch(ctx.config, patch);
    if (r.errors.length) return c.json({ error: r.errors[0]!, errors: r.errors }, 422);
    Object.assign(ctx.config, r.config);
    saveConfig(ctx.paths, ctx.config);
    ctx.jobs.setLimit("download", ctx.config.downloads.parallelFiles);
    log.info(`config atualizada: ${r.changed.join(", ") || "nada mudou"}`);
    return c.json({ ok: true, changed: r.changed, needsRestart: r.needsRestart, config: redactConfig(ctx) });
  });

  // API-01: chaves de acesso (nunca devolvidas inteiras depois de criadas).
  app.get("/api/v1/config/api-keys", (c) => c.json({
    keys: readApiKeys(ctx.paths, ctx.config).map((k) => fingerprint(k)),
    required: !isLoopbackHost(ctx.config.server.host),
  }));
  app.post("/api/v1/config/api-key", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { key?: string };
    const key = addApiKey(ctx.paths, body.key);
    return c.json({ key, warning: "Guarde agora: esta é a única vez que a chave aparece inteira." }, 201);
  });
  app.delete("/api/v1/config/api-key", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { key?: string };
    if (!body.key) return c.json({ error: "informe 'key'" }, 400);
    return removeApiKey(ctx.paths, body.key) ? c.json({ ok: true }) : c.json({ error: "chave não encontrada" }, 404);
  });

  app.route("/api/v1/models", modelsRoutes(ctx));
  app.route("/api/v1/engines", enginesRoutes(ctx));
  app.route("/v1", v1Routes(ctx));
  const img = imagesRoutes(ctx);
  app.route("/api/v1/generate", img.native);
  app.route("/v1/images", img.openai);
  app.route("/api/v1/outputs", img.outputs);
  const audio = audioRoutes(ctx);
  app.route("/v1/audio", audio.openai);
  app.route("/api/v1/voices", audio.voices);
  app.route("/api/v1/audio", audio.native);
  app.route("/api/v1/agent", agentRoutes(ctx));
  const docs = projectsRoutes(ctx);
  app.route("/api/v1/projects", docs.projects);
  app.route("/api/v1/doctypes", docs.doctypes);
  app.route("/api/v1/ocr", docs.ocr);
  app.route("/api/v1/memory", memoryRoutes(ctx));
  app.route("/api/v1/meetings", meetingsRoutes(ctx));
  app.route("/", plannedRoutes());

  app.get("/api/v1/jobs", (c) => {
    const live = ctx.jobs.list();
    if (c.req.query("history") !== "1") return c.json({ jobs: live });
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100) || 100);
    const seen = new Set(live.map((j) => j.id));
    const history = ctx.jobStore.history(limit, c.req.query("kind")).filter((j) => !seen.has(j.id));
    return c.json({ jobs: [...live, ...history].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit) });
  });
  app.get("/api/v1/jobs/:id", (c) => {
    const j = ctx.jobs.get(c.req.param("id")) ?? ctx.jobStore.get(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "job não encontrado" }, 404);
  });
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

function isLoopbackHost(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }

function authGuard(ctx: StudioContext, limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const keys = readApiKeys(ctx.paths, ctx.config);
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-api-key") ?? c.req.query("api_key") ?? "";
    if (keys.length > 0 && !keyMatches(given, keys)) {
      return c.json({ error: { message: "Chave de API inválida ou ausente. Envie 'Authorization: Bearer <chave>'.", type: "authentication_error" } }, 401);
    }
    const client = given ? fingerprint(given).sha256 : (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local");
    const wait = limiter.take(client);
    if (wait !== null) {
      return c.json({ error: { message: `Muitas requisições. Tente de novo em ${wait} s.`, type: "rate_limit_error" } }, 429, { "retry-after": String(wait) });
    }
    return next();
  };
}

function redactConfig(ctx: StudioContext) {
  const c = structuredClone(ctx.config);
  c.server.apiKey = c.server.apiKey ? "•••" : null;
  return c;
}
