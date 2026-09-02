import { Hono } from "hono";

/**
 * Endpoints já contratados em docs/API.md mas ainda não implementados respondem 501 com a
 * tarefa responsável, para que a UI e integrações saibam o que esperar.
 */
const PLANNED: [string, string][] = [
];

export function plannedRoutes(): Hono {
  const app = new Hono();
  for (const [route, task] of PLANNED) {
    app.all(route, (c) => c.json({ error: `Endpoint planejado, ainda não implementado (tarefa ${task} em docs/SPRINTS.md).`, task, route }, 501));
    app.all(route + "/*", (c) => c.json({ error: `Endpoint planejado, ainda não implementado (tarefa ${task} em docs/SPRINTS.md).`, task, route }, 501));
  }
  return app;
}
