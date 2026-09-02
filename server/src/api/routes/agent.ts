import { Hono } from "hono";
import type { StudioContext } from "../../core/context.js";

/** AGT-01…05 routes. The dsh UI itself is served by dsh on its own port (state.url). */
export function agentRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json(ctx.agent.status()));
  app.post("/install", (c) => c.json({ job: ctx.jobs.create("download", "Instalar DeepSeek Harness (dsh)", (j) => ctx.agent.install(j)) }));
  app.post("/start", async (c) => { try { return c.json(await ctx.agent.start()); } catch (e) { return c.json({ error: (e as Error).message, state: ctx.agent.status() }, 503); } });
  app.post("/stop", async (c) => { await ctx.agent.stop(); return c.json(ctx.agent.status()); });
  app.get("/settings", (c) => c.json({ file: ctx.agent.writeSettings() }));
  app.post("/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { task?: string; workspace?: string; timeoutSec?: number };
    if (!body.task) return c.json({ error: "task é obrigatório" }, 400);
    const job = ctx.jobs.create("agent", `Agente: ${body.task.slice(0, 60)}`, () => ctx.agent.run({ task: body.task!, workspace: body.workspace, timeoutSec: body.timeoutSec }));
    return c.json({ job });
  });
  return app;
}
