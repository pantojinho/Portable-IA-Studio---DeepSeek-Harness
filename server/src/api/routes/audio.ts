import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../../core/context.js";
import type { Transcript, Voice } from "../../audio/types.js";
import { transcribeFile } from "../../audio/stt.js";
import { toSrt, toVtt } from "../../engines/whispercpp.js";
import { Ffmpeg } from "../../audio/ffmpeg.js";
import { oaiError } from "./v1.js";

const AUDIO_MIME: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac" };

/**
 * AUD-01 + AUD-02 + AUD-09. `/v1/audio/*` mirrors OpenAI (speech, transcriptions, translations);
 * `/api/v1/voices` and `/api/v1/audio/*` are the native surface the UI uses.
 */
export function audioRoutes(ctx: StudioContext): { openai: Hono; voices: Hono; native: Hono } {
  const openai = new Hono();

  // ------------------------------------------------------------ speech ---
  openai.post("/speech", async (c) => {
    let body: { input?: string; text?: string; voice?: string; model?: string; response_format?: string; speed?: number; language?: string };
    try { body = await c.req.json(); } catch { return c.json(oaiError("corpo JSON inválido", "invalid_request_error"), 400); }
    const text = body.input ?? body.text ?? "";
    if (!text.trim()) return c.json(oaiError("informe 'input' com o texto a falar", "invalid_request_error", "input"), 400);
    const format = normalizeFormat(body.response_format);
    try {
      const r = await ctx.tts.speak({ text, voice: body.voice ?? body.model, format, speed: body.speed, language: body.language, signal: c.req.raw.signal });
      const data = fs.readFileSync(r.file);
      return new Response(new Uint8Array(data), { headers: { "content-type": AUDIO_MIME[r.format] ?? "application/octet-stream", "x-aistudio-voice": r.voice.id, "x-aistudio-file": path.basename(r.file) } });
    } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 503); }
  });

  // --------------------------------------------- transcriptions/translations ---
  const stt = (translate: boolean) => async (c: import("hono").Context) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return c.json(oaiError("envie o campo 'file' (multipart/form-data)", "invalid_request_error", "file"), 400);
    const tmpDir = path.join(ctx.paths.cache, "uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${Date.now()}-${path.basename(file.name || "audio.wav").replace(/[^\w.-]/g, "_")}`);
    fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
    const granularity = String(form.get("timestamp_granularities[]") ?? form.get("timestamp_granularities") ?? "segment");
    try {
      const t = await transcribeFile(ctx, tmp, {
        model: str(form.get("model")) || undefined,
        language: str(form.get("language")) || undefined,
        translateToEnglish: translate,
        timestamps: granularity === "word" ? "word" : "segment",
        diarize: truthy(form.get("diarize")),
        prompt: str(form.get("prompt")) || undefined,
        signal: c.req.raw.signal,
      });
      return transcriptResponse(c, t, String(form.get("response_format") ?? "json"), translate);
    } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 503); }
    finally { try { fs.unlinkSync(tmp); } catch { /* já removido */ } }
  };
  openai.post("/transcriptions", stt(false));
  openai.post("/translations", stt(true));

  // ------------------------------------------------------------ voices ---
  const voices = new Hono();
  voices.get("/", (c) => c.json({
    voices: ctx.voices.list(c.req.query("refresh") === "1"),
    default: ctx.voices.defaultFor(c.req.query("language") ?? ctx.config.ui.language)?.id ?? null,
  }));
  voices.get("/:id", (c) => {
    const v = ctx.voices.get(c.req.param("id"));
    return v ? c.json(v) : c.json({ error: "voz não encontrada" }, 404);
  });
  voices.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as (Partial<Voice> & { name?: string; engine?: string }) | null;
    if (!body?.name || !body.engine) return c.json({ error: "informe ao menos 'name' e 'engine'" }, 400);
    return c.json(ctx.voices.save({ ...body, name: body.name, engine: body.engine }), 201);
  });
  voices.delete("/:id", (c) => {
    try { return ctx.voices.delete(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "voz não encontrada" }, 404); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });
  voices.post("/:id/preview", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { text?: string };
    const text = body.text ?? "Olá! Esta é uma prévia da minha voz no AI Studio.";
    try {
      const r = await ctx.tts.speak({ text, voice: c.req.param("id"), format: "wav", signal: c.req.raw.signal });
      return new Response(new Uint8Array(fs.readFileSync(r.file)), { headers: { "content-type": "audio/wav" } });
    } catch (e) { return c.json({ error: (e as Error).message }, 503); }
  });
  // AUD-06: cloning = a sample plus the engine that will imitate it
  voices.post("/clone", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const sample = form?.get("sample");
    const name = String(form?.get("name") ?? "").trim();
    if (!form || !(sample instanceof File) || !name) return c.json({ error: "envie 'name' e o arquivo 'sample' (multipart/form-data)" }, 400);
    const engine = String(form.get("engine") ?? "tts-clone");
    const id = String(form.get("id") ?? name);
    const voice = ctx.voices.save({
      id, name, engine, language: String(form.get("language") ?? "pt-BR"),
      params: { cloneEngine: String(form.get("cloneEngine") ?? "chatterbox"), refText: String(form.get("refText") ?? "") },
    });
    const dir = path.join(ctx.paths.voices, voice.id);
    const wavRaw = path.join(dir, "sample-original" + (path.extname(sample.name) || ".wav"));
    fs.writeFileSync(wavRaw, Buffer.from(await sample.arrayBuffer()));
    // cloning engines want a clean mono WAV; convert when ffmpeg is around, otherwise keep the upload
    let sampleFile = wavRaw;
    try {
      sampleFile = await new Ffmpeg(ctx).toWav16k(wavRaw, path.join(dir, "sample.wav"), c.req.raw.signal);
      fs.unlinkSync(wavRaw);
    } catch { /* sem ffmpeg: usa o arquivo como veio */ }
    const saved = ctx.voices.save({ ...voice, sample: sampleFile });
    return c.json({ voice: saved, hint: "Instale o motor com POST /api/v1/audio/packages/tts-clone/install antes do primeiro uso." }, 201);
  });

  // ------------------------------------------------------------ native ---
  const native = new Hono();
  native.get("/devices", async (c) => c.json({ devices: await new Ffmpeg(ctx).devices(), platform: process.platform }));
  native.get("/packages", (c) => c.json({ packages: ctx.python.status() }));
  native.post("/packages/:id/install", (c) => {
    const id = c.req.param("id");
    const job = ctx.jobs.create("download", `Instalar ambiente Python: ${id}`, (j) => ctx.python.install(id, j));
    return c.json({ job }, 202);
  });

  // AUD-09: music always as a job — minutes of GPU work
  native.post("/music", async (c) => {
    const body = await c.req.json().catch(() => null) as { prompt?: string; lyrics?: string; durationSec?: number; engine?: string; seed?: number; steps?: number } | null;
    if (!body?.prompt?.trim()) return c.json({ error: "informe 'prompt' (o estilo/descrição da música)" }, 400);
    const engine = body.engine ?? "musicgen";
    const output = path.join(ctx.paths.outputs, "music", `${new Date().toISOString().replace(/[:.]/g, "-")}-${engine}.wav`);
    const job = ctx.jobs.create("generate", `Música: ${body.prompt.slice(0, 40)}`, async (j) => {
      j.setProgress(-1, `gerando com ${engine} (o primeiro uso baixa o modelo)`);
      const r = await ctx.python.music("music", { ...body, engine, output }, j.signal);
      fs.writeFileSync(`${r.file}.json`, JSON.stringify({ kind: "music", ...body, engine, createdAt: new Date().toISOString() }, null, 2));
      return r;
    }, { engine, prompt: body.prompt });
    return c.json({ job }, 202);
  });

  return { openai, voices, native };
}

function normalizeFormat(f?: string): "wav" | "mp3" | "ogg" | "flac" {
  const v = (f ?? "wav").toLowerCase();
  if (v === "mp3" || v === "mpeg") return "mp3";
  if (v === "ogg" || v === "opus") return "ogg";
  if (v === "flac") return "flac";
  return "wav";
}

type FormValue = string | File | null;
function str(v: FormValue): string { return typeof v === "string" ? v : ""; }
function truthy(v: FormValue): boolean { return ["1", "true", "sim", "yes"].includes(str(v).toLowerCase()); }

function transcriptResponse(c: import("hono").Context, t: Transcript, format: string, translate: boolean): Response {
  if (format === "text") return c.text(t.text);
  if (format === "srt") return c.text(toSrt(t), 200, { "content-type": "text/plain; charset=utf-8" });
  if (format === "vtt") return c.text(toVtt(t), 200, { "content-type": "text/vtt; charset=utf-8" });
  if (format === "verbose_json") {
    return c.json({
      task: translate ? "translate" : "transcribe", language: t.language, duration: t.duration, text: t.text,
      segments: t.segments.map((s, id) => ({ id, start: s.start, end: s.end, text: s.text, speaker: s.speaker, avg_logprob: s.confidence })),
      words: t.segments.flatMap((s) => s.words ?? []),
    });
  }
  return c.json({ text: t.text });
}
