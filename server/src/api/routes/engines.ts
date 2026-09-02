import { Hono } from "hono";
import type { StudioContext } from "../../core/context.js";
import type { Backend } from "../../core/system.js";
import type { EngineId } from "../../engines/types.js";

/** ENG-09: engines status, adopt/install, start/stop instances. */
export function enginesRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  const svc = ctx.engines;

  app.get("/", async (c) => c.json({ ...svc.status(), preferredBackend: await svc.preferredBackend(), catalog: Object.keys(svc.installer.catalog()).filter((k) => k !== "version") }));
  app.post("/adopt", (c) => c.json(svc.adoptAll()));
  app.post("/:id/install", async (c) => {
    const id = c.req.param("id") as EngineId;
    const backend = (c.req.query("backend") as Backend | undefined) ?? (await svc.preferredBackend());
    const job = ctx.jobs.create("download", `Instalar ${id} (${backend})`, (j) => svc.installer.install(id, backend, j));
    return c.json({ job });
  });
  app.post("/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: string; settings?: Record<string, unknown> };
    if (!body.model) return c.json({ error: "model é obrigatório" }, 400);
    try { return c.json({ instance: await svc.start(body.model, body.settings) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });
  app.post("/instances/:id/stop", async (c) => { await svc.supervisor.stop(decodeURIComponent(c.req.param("id"))); return c.json({ ok: true }); });
  app.post("/stop-all", async (c) => { await svc.supervisor.stopAll(); return c.json({ ok: true }); });

  app.get("/providers", (c) => c.json({ providers: Object.entries(ctx.providers.all()).map(([id, p]) => ({ id, ...p, hasKey: !!ctx.providers.key(id) })) }));
  app.put("/providers/:id/key", async (c) => { const b = (await c.req.json().catch(() => ({}))) as { key?: string | null }; ctx.providers.setKey(c.req.param("id"), b.key ?? null); return c.json({ ok: true, hasKey: !!ctx.providers.key(c.req.param("id")) }); });
  return app;
}
