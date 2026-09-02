import { Hono } from "hono";
import fs from "node:fs";
import type { StudioContext } from "../../core/context.js";
import type { ModelKind } from "../../core/paths.js";
import { MODEL_KINDS } from "../../core/paths.js";
import { inspectFile } from "../../models/inspect.js";
import { defaultMigrationSources, scanForMigration } from "../../models/registry.js";
import type { DownloadPlan } from "../../models/types.js";

/**
 * /api/v1/models — library, resolution, downloads, recipes, migration, tokens.
 * Every long operation returns a job id; follow it on /api/v1/events (topic "job").
 */
export function modelsRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  const svc = ctx.models;

  app.get("/", (c) => {
    const kind = c.req.query("kind") as ModelKind | undefined;
    if (kind && !MODEL_KINDS.includes(kind)) return c.json({ error: `kind inválido. Use: ${MODEL_KINDS.join(", ")}` }, 400);
    if (c.req.query("refresh") === "1") svc.registry.scan();
    return c.json({ kinds: MODEL_KINDS, models: svc.registry.list(kind) });
  });

  app.get("/recipes", (c) => c.json({ recipes: svc.recipes.list() }));
  app.post("/recipes/reload", (c) => { svc.recipes.reload(); return c.json({ ok: true, count: svc.recipes.list().length }); });

  app.get("/resolve", async (c) => {
    const ref = c.req.query("ref");
    if (!ref) return c.json({ error: "ref é obrigatório (link, org/repo ou recipe:id)" }, 400);
    try { return c.json(await svc.resolve(ref, { quant: c.req.query("quant") ?? null })); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.post("/pull", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ref?: string; quant?: string; plan?: DownloadPlan };
    try {
      const plan = body.plan ?? (body.ref ? await svc.resolve(body.ref, { quant: body.quant ?? null }) : null);
      if (!plan) return c.json({ error: "informe ref ou plan" }, 400);
      if (plan.files.length === 0) return c.json({ error: "plano sem arquivos", plan }, 422);
      const job = svc.pull(plan);
      return c.json({ job, plan });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const kind = c.req.query("kind") as ModelKind | undefined;
    const pipeline = kind === "image" ? "text-to-image" : kind === "speech" ? "automatic-speech-recognition" : kind === "tts" ? "text-to-speech" : kind === "embeddings" ? "feature-extraction" : undefined;
    const filter = kind === "text" || kind === "ocr" ? ["gguf"] : [];
    try {
      const results = await svc.hf.search(q, { limit: 25, pipeline, filter });
      return c.json({ results: results.map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes, pipeline: m.pipeline_tag, gated: !!m.gated, tags: (m.tags ?? []).filter((t) => /^(gguf|safetensors|onnx|diffusers)$/.test(t)) })) });
    } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  app.get("/inspect", (c) => {
    const p = c.req.query("path");
    if (!p || !fs.existsSync(p)) return c.json({ error: "path inexistente" }, 400);
    return c.json({ path: p, sizeBytes: fs.statSync(p).size, inspection: inspectFile(p) });
  });

  app.post("/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; kind?: ModelKind; subdir?: string; move?: boolean };
    if (!body.path) return c.json({ error: "path é obrigatório" }, 400);
    try { return c.json({ model: svc.registry.importFile(body.path, { kind: body.kind, subdir: body.subdir, move: !!body.move }) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.delete("/", (c) => {
    const id = c.req.query("id");
    if (!id) return c.json({ error: "id é obrigatório" }, 400);
    try { return c.json({ deleted: svc.registry.delete(id) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 403); }
  });

  app.get("/migrate/scan", (c) => {
    const source = c.req.query("source");
    const sources = source ? [source] : defaultMigrationSources(ctx.paths);
    const candidates = sources.flatMap((s) => scanForMigration(s));
    return c.json({ sources, candidates });
  });

  app.post("/migrate/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { paths?: string[]; move?: boolean };
    const results = (body.paths ?? []).map((p) => { try { return { path: p, ok: true, model: svc.registry.importFile(p, { move: !!body.move }) }; } catch (e) { return { path: p, ok: false, error: (e as Error).message }; } });
    return c.json({ results });
  });

  app.get("/tokens", (c) => c.json({ hf: !!svc.readSecret("hf_token"), civitai: !!svc.readSecret("civitai_token") }));
  app.put("/tokens", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { hf?: string | null; civitai?: string | null };
    if ("hf" in body) svc.writeSecret("hf_token", body.hf ?? null);
    if ("civitai" in body) svc.writeSecret("civitai_token", body.civitai ?? null);
    return c.json({ hf: !!svc.readSecret("hf_token"), civitai: !!svc.readSecret("civitai_token") });
  });

  return app;
}
