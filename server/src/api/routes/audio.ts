import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../../core/context.js";
import type { Transcript } from "../../audio/types.js";
import { oaiError } from "./v1.js";

/** AUD-01 (minimal): POST /v1/audio/transcriptions (multipart: file, model?, language?, response_format?). */
export function audioRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  app.post("/transcriptions", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return c.json(oaiError("envie o campo 'file' (multipart/form-data)", "invalid_request_error", "file"), 400);
    const modelRef = String(form.get("model") ?? "") || ctx.models.registry.list("speech").find((m) => m.inspection.role === "main")?.id;
    if (!modelRef) return c.json(oaiError("nenhum modelo de fala na biblioteca. Ex.: aistudio models pull recipe:whisper-small", "invalid_request_error", "model"), 404);
    const found = ctx.engines.findModel(modelRef, ["speech"]);
    if (!found) return c.json(oaiError(`modelo '${modelRef}' não encontrado`, "invalid_request_error", "model", "model_not_found"), 404);
    const tmpDir = path.join(ctx.paths.cache, "uploads"); fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${Date.now()}-${path.basename(file.name || "audio.wav")}`);
    fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
    try {
      const inst = await ctx.engines.ensureInstalled("whispercpp");
      const instance = await ctx.engines.supervisor.ensure("whispercpp", { model: found.model, backend: inst.backend });
      const r = await ctx.engines.registry.get("whispercpp")!.run(instance, { task: "stt", input: { file: tmp, language: String(form.get("language") ?? "auto"), timestamps: String(form.get("timestamp_granularities[]") ?? "segment") }, signal: c.req.raw.signal });
      const t = r.output as unknown as Transcript;
      const fmt = String(form.get("response_format") ?? "json");
      if (fmt === "text") return c.text(t.text);
      if (fmt === "srt") return c.text(t.segments.map((s, i) => `${i + 1}\n${srt(s.start)} --> ${srt(s.end)}\n${s.text}\n`).join("\n"));
      if (fmt === "verbose_json") return c.json({ task: "transcribe", language: t.language, duration: t.duration, text: t.text, segments: t.segments.map((s, i) => ({ id: i, start: s.start, end: s.end, text: s.text })) });
      return c.json({ text: t.text });
    } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 503); }
    finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
  });
  return app;
}

function srt(sec: number): string { const ms = Math.round(sec * 1000); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`; }
