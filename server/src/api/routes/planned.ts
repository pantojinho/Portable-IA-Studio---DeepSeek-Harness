import { Hono } from "hono";

/**
 * Endpoints já contratados em docs/API.md mas ainda não implementados respondem 501 com a
 * tarefa responsável, para que a UI e integrações saibam o que esperar.
 */
const PLANNED: [string, string][] = [
  ["/v1/images/edits", "ENG-07"],
  ["/v1/audio/speech", "AUD-02"], ["/v1/audio/transcriptions", "AUD-01"], ["/v1/audio/translations", "AUD-01"],
  ["/api/v1/generate/video", "VID-01"],
  ["/api/v1/voices", "AUD-02"], ["/api/v1/meetings", "AUD-08"], ["/api/v1/audio/music", "AUD-09"],
  ["/api/v1/projects", "DOC-01"], ["/api/v1/ocr", "DOC-03"], ["/api/v1/doctypes", "DOC-07"],
  ["/api/v1/agent", "AGT-01"], ["/mcp", "AGT-04"],
];

export function plannedRoutes(): Hono {
  const app = new Hono();
  for (const [route, task] of PLANNED) {
    app.all(route, (c) => c.json({ error: `Endpoint planejado, ainda não implementado (tarefa ${task} em docs/SPRINTS.md).`, task, route }, 501));
    app.all(route + "/*", (c) => c.json({ error: `Endpoint planejado, ainda não implementado (tarefa ${task} em docs/SPRINTS.md).`, task, route }, 501));
  }
  return app;
}
