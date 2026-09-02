import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../../core/context.js";
import type { ImageParams } from "../../engines/sdcpp.js";
import { oaiError } from "./v1.js";

/**
 * ENG-07 + ENG-10 + VID-01: image generation as a job, OpenAI-compatible wrappers
 * (/v1/images/generations and /edits), upscale, video (frames → mp4) and the outputs gallery.
 */
export function imagesRoutes(ctx: StudioContext): { native: Hono; openai: Hono; outputs: Hono } {
  const native = new Hono();
  const openai = new Hono();
  const outputs = new Hono();

  const generate = async (modelRef: string | undefined, params: ImageParams, signal?: AbortSignal) => {
    const ref = modelRef || ctx.models.registry.list("image").find((m) => m.inspection.role === "main" || m.inspection.role === "diffusion")?.id;
    if (!ref) throw new Error("nenhum modelo de imagem na biblioteca. Ex.: aistudio models pull https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0");
    const found = ctx.engines.findModel(ref, ["image", "video"]);
    if (!found) throw new Error(`modelo de imagem '${ref}' não encontrado na biblioteca`);
    const recipe = found.model.recipe ? ctx.models.recipes.get(found.model.recipe.id) : undefined;
    const inst = await ctx.engines.ensureInstalled("sdcpp");
    const instance = await ctx.engines.supervisor.ensure("sdcpp", { model: found.model, companions: found.companions, backend: inst.backend, recipeArgs: recipe?.engineArgs?.sdcpp, signal });
    const adapter = ctx.engines.registry.get("sdcpp")!;
    const task = params.task ?? (params.initImage ? (params.mask ? "inpaint" : "img2img") : "txt2img");
    return adapter.run(instance, { task, input: params as unknown as Record<string, unknown>, signal });
  };

  /** Save an uploaded image (edits/upscale/img2vid) where sd.cpp can read it. */
  const saveUpload = async (file: File, tag: string): Promise<string> => {
    const dir = path.join(ctx.paths.cache, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}-${tag}-${path.basename(file.name || "imagem.png").replace(/[^\w.-]/g, "_")}`);
    fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    return dest;
  };

  native.post("/image", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ImageParams & { model?: string; wait?: boolean };
    if (!body.prompt) return c.json({ error: "prompt é obrigatório" }, 400);
    const job = ctx.jobs.create("generate", `Imagem: ${body.prompt.slice(0, 60)}`, (j) => generate(body.model, body, j.signal), { model: body.model ?? null });
    return c.json({ job });
  });

  // ENG-05b: upscale com ESRGAN
  native.post("/upscale", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { image?: string; model?: string; upscaleModel?: string; repeats?: number };
    if (!body.image || !fs.existsSync(body.image)) return c.json({ error: "informe 'image' com o caminho de uma imagem existente" }, 400);
    const job = ctx.jobs.create("generate", `Ampliar ${path.basename(body.image)}`, (j) => generate(body.model, {
      prompt: "", task: "upscale", initImage: body.image, upscaleModel: body.upscaleModel, upscaleRepeats: body.repeats,
    } as ImageParams, j.signal));
    return c.json({ job }, 202);
  });

  // VID-01: vídeo pelo sd.cpp (vid_gen) e os quadros viram mp4 com o ffmpeg
  native.post("/video", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ImageParams & { model?: string; initImage?: string };
    if (!body.prompt?.trim()) return c.json({ error: "prompt é obrigatório" }, 400);
    const job = ctx.jobs.create("generate", `Vídeo: ${body.prompt.slice(0, 50)}`, async (j) => {
      j.setProgress(-1, "gerando os quadros (isso demora)");
      const r = await generate(body.model, {
        ...body, task: body.initImage ? "img2vid" : "txt2vid",
        frames: body.frames ?? 33, fps: body.fps ?? 16,
        width: body.width ?? 512, height: body.height ?? 512,
      } as ImageParams, j.signal);
      const frames = (r.files ?? []).filter((f) => f.endsWith(".png")).sort();
      if (frames.length < 2) return { ...r.output, video: null, note: "o motor devolveu um quadro só; sem vídeo para montar" };
      j.setProgress(0.9, `montando o mp4 com ${frames.length} quadros`);
      const { Ffmpeg } = await import("../../audio/ffmpeg.js");
      const dir = path.join(ctx.paths.outputs, "video");
      fs.mkdirSync(dir, { recursive: true });
      const stem = path.basename(frames[0]!).replace(/\.png$/, "");
      const seqDir = path.join(ctx.paths.cache, "frames", stem);
      fs.rmSync(seqDir, { recursive: true, force: true });
      fs.mkdirSync(seqDir, { recursive: true });
      frames.forEach((f, i) => fs.copyFileSync(f, path.join(seqDir, `f-${String(i + 1).padStart(4, "0")}.png`)));
      const output = path.join(dir, `${stem}.mp4`);
      await new Ffmpeg(ctx).framesToMp4(path.join(seqDir, "f-%04d.png"), body.fps ?? 16, output, j.signal);
      fs.rmSync(seqDir, { recursive: true, force: true });
      fs.writeFileSync(`${output}.json`, JSON.stringify({ kind: "video", ...body, frames: frames.length, createdAt: new Date().toISOString() }, null, 2));
      return { ...r.output, video: output, frames: frames.length };
    }, { model: body.model ?? null });
    return c.json({ job }, 202);
  });

  // OpenAI: waits for the result (their API is synchronous)
  openai.post("/generations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; model?: string; n?: number; size?: string; response_format?: string; negative_prompt?: string; steps?: number; seed?: number; cfg?: number };
    if (!body.prompt) return c.json(oaiError("prompt é obrigatório", "invalid_request_error", "prompt"), 400);
    const [w, h] = (body.size ?? "1024x1024").split("x").map(Number);
    try {
      const r = await generate(body.model, { prompt: body.prompt, negative: body.negative_prompt, width: w, height: h, n: body.n, steps: body.steps, seed: body.seed, cfg: body.cfg }, c.req.raw.signal);
      const files = r.files ?? [];
      const data = files.map((f) => body.response_format === "url"
        ? { url: `${new URL(c.req.url).origin}/api/v1/outputs/file?path=${encodeURIComponent(f)}` }
        : { b64_json: fs.readFileSync(f).toString("base64") });
      return c.json({ created: Math.floor(Date.now() / 1000), data });
    } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 503); }
  });

  // OpenAI /v1/images/edits: multipart com image (+ mask) vira img2img/inpaint
  openai.post("/edits", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const image = form?.get("image");
    const prompt = String(form?.get("prompt") ?? "").trim();
    if (!form || !(image instanceof File) || !prompt) return c.json(oaiError("envie 'image' (multipart) e 'prompt'", "invalid_request_error", "image"), 400);
    const mask = form.get("mask");
    try {
      const initImage = await saveUpload(image, "edit");
      const maskPath = mask instanceof File ? await saveUpload(mask, "mask") : undefined;
      const [w, h] = String(form.get("size") ?? "").split("x").map(Number);
      const r = await generate(String(form.get("model") ?? "") || undefined, {
        prompt, initImage, mask: maskPath, strength: Number(form.get("strength") ?? 0.6),
        width: w || undefined, height: h || undefined, n: Number(form.get("n") ?? 1),
      }, c.req.raw.signal);
      const files = r.files ?? [];
      const data = files.map((f) => String(form.get("response_format") ?? "b64_json") === "url"
        ? { url: `${new URL(c.req.url).origin}/api/v1/outputs/file?path=${encodeURIComponent(f)}` }
        : { b64_json: fs.readFileSync(f).toString("base64") });
      return c.json({ created: Math.floor(Date.now() / 1000), data });
    } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 503); }
  });

  outputs.get("/", (c) => {
    const wanted = c.req.query("kind");
    const items: Record<string, unknown>[] = [];
    // a galeria mostra tudo que o Studio produziu: imagens, vídeos, fala e música
    for (const [folder, kind, ext] of [["images", "image", ".png"], ["video", "video", ".mp4"], ["speech", "speech", ""], ["music", "music", ""]] as const) {
      const dir = path.join(ctx.paths.outputs, folder);
      if (!fs.existsSync(dir) || (wanted && wanted !== kind)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
          const base = f.replace(/\.json$/, "");
          const file = ext ? path.join(dir, base.replace(new RegExp(`\\${ext}$`), "") + ext) : path.join(dir, base);
          items.push({ id: base, kind, file, ...meta });
        } catch { /* metadado pela metade */ }
      }
    }
    return c.json({ items: items.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))) });
  });
  outputs.get("/file", (c) => {
    const p = c.req.query("path") ?? "";
    const root = path.resolve(ctx.paths.outputs);
    if (!path.resolve(p).startsWith(root + path.sep) || !fs.existsSync(p)) return c.text("not found", 404);
    const mime = p.endsWith(".png") ? "image/png" : p.endsWith(".mp4") ? "video/mp4" : p.endsWith(".wav") ? "audio/wav"
      : p.endsWith(".mp3") ? "audio/mpeg" : p.endsWith(".ogg") ? "audio/ogg" : p.endsWith(".flac") ? "audio/flac" : "application/octet-stream";
    return new Response(fs.createReadStream(p) as unknown as ReadableStream, { headers: { "content-type": mime, "cache-control": "public, max-age=86400" } });
  });
  outputs.delete("/:id", (c) => {
    const id = path.basename(c.req.param("id"));
    let n = 0;
    for (const folder of ["images", "video", "speech", "music"]) {
      const dir = path.join(ctx.paths.outputs, folder);
      for (const name of [id, `${id}.png`, `${id}.mp4`, `${id}.json`, `${id}.png.json`, `${id}.mp4.json`]) {
        const f = path.join(dir, name);
        if (f.startsWith(path.resolve(ctx.paths.outputs)) && fs.existsSync(f) && fs.statSync(f).isFile()) { fs.unlinkSync(f); n++; }
      }
    }
    return c.json({ deleted: n > 0, files: n });
  });

  return { native, openai, outputs };
}
