import { Hono } from "hono";
import type { StudioContext } from "../../core/context.js";

/** AUD-08: gravar, acompanhar a transcrição (SSE `meeting.transcript`), resumir e exportar. */
export function meetingsRoutes(ctx: StudioContext): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({
    meetings: ctx.meetings.list().map((m) => ({ ...m, recording: ctx.meetings.isRecording(m.id), transcript: undefined, segments: m.transcript?.segments.length ?? 0 })),
    recording: ctx.meetings.recordingIds(),
  }));

  app.get("/devices", async (c) => {
    try { return c.json(await ctx.meetings.devices()); }
    catch (e) { return c.json({ error: (e as Error).message }, 503); }
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; sources?: ("mic" | "system")[]; mic?: string; system?: string; projectId?: string; language?: string; diarize?: boolean };
    try { return c.json(await ctx.meetings.start(body), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get("/:id", (c) => {
    const m = ctx.meetings.get(c.req.param("id"));
    return m ? c.json({ ...m, recording: ctx.meetings.isRecording(m.id) }) : c.json({ error: "reunião não encontrada" }, 404);
  });

  app.post("/:id/stop", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { summarize?: boolean; model?: string; language?: string };
    try { return c.json(await ctx.meetings.stop(c.req.param("id"), body)); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get("/:id/export", (c) => {
    const m = ctx.meetings.get(c.req.param("id"));
    if (!m) return c.json({ error: "reunião não encontrada" }, 404);
    const format = (c.req.query("format") ?? "md") as "md" | "srt" | "vtt" | "txt" | "json";
    if (!["md", "srt", "vtt", "txt", "json"].includes(format)) return c.json({ error: "formato: md, srt, vtt, txt ou json" }, 400);
    const body = ctx.meetings.exportText(m, format);
    const mime = format === "json" ? "application/json" : format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8";
    return new Response(body, { headers: { "content-type": mime, "content-disposition": `attachment; filename="${m.id}.${format}"` } });
  });

  app.post("/:id/to-project", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { projectId?: string };
    const m = ctx.meetings.get(c.req.param("id"));
    if (!m) return c.json({ error: "reunião não encontrada" }, 404);
    if (!body.projectId) return c.json({ error: "informe 'projectId'" }, 400);
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = path.join(ctx.paths.recordings, `${m.id}.md`);
      fs.writeFileSync(file, ctx.meetings.exportText(m, "md"));
      const r = await ctx.projects.addSourceFiles(body.projectId, [file], { ingest: true });
      return c.json(r, 201);
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.delete("/:id", (c) => {
    try { return ctx.meetings.delete(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "reunião não encontrada" }, 404); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  return app;
}
