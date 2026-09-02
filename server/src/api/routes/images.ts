import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../../core/context.js";
import type { ImageParams } from "../../engines/sdcpp.js";
import { oaiError } from "./v1.js";

/** ENG-07 + ENG-10 (minimal): image generation as a job, OpenAI-compatible wrapper, outputs gallery. */
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
    return adapter.run(instance, { task: params.initImage ? (params.mask ? "inpaint" : "img2img") : "txt2img", input: params as unknown as Record<string, unknown>, signal });
  };

  native.post("/image", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ImageParams & { model?: string; wait?: boolean };
    if (!body.prompt) return c.json({ error: "prompt é obrigatório" }, 400);
    const job = ctx.jobs.create("generate", `Imagem: ${body.prompt.slice(0, 60)}`, (j) => generate(body.model, body, j.signal), { model: body.model ?? null });
    return c.json({ job });
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

  outputs.get("/", (c) => {
    const dir = path.join(ctx.paths.outputs, "images");
    if (!fs.existsSync(dir)) return c.json({ items: [] });
    const items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      try { const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return { id: f.replace(/\.json$/, ""), file: path.join(dir, f.replace(/\.json$/, ".png")), ...meta }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b!.createdAt).localeCompare(String(a!.createdAt)));
    return c.json({ items });
  });
  outputs.get("/file", (c) => {
    const p = c.req.query("path") ?? "";
    const root = path.resolve(ctx.paths.outputs);
    if (!path.resolve(p).startsWith(root + path.sep) || !fs.existsSync(p)) return c.text("not found", 404);
    return new Response(fs.createReadStream(p) as unknown as ReadableStream, { headers: { "content-type": p.endsWith(".png") ? "image/png" : "application/octet-stream", "cache-control": "public, max-age=86400" } });
  });
  outputs.delete("/:id", (c) => {
    const dir = path.join(ctx.paths.outputs, "images");
    const id = path.basename(c.req.param("id"));
    let n = 0;
    for (const ext of [".png", ".json"]) { const f = path.join(dir, id + ext); if (fs.existsSync(f)) { fs.unlinkSync(f); n++; } }
    return c.json({ deleted: n > 0 });
  });

  return { native, openai, outputs };
}
