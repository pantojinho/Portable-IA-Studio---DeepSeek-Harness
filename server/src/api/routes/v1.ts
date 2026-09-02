import { Hono, type Context } from "hono";
import type { StudioContext } from "../../core/context.js";
import { logger } from "../../core/log.js";

const log = logger("v1");

/**
 * ENG-06/08: OpenAI-compatible surface. Local models start on demand (llama-server) and the request is
 * proxied byte-for-byte (streaming included); "<provider>:<model>" goes to a remote provider.
 */
export function v1Routes(ctx: StudioContext): Hono {
  const app = new Hono();

  app.get("/models", (c) => {
    const local = ctx.models.registry.list().filter((m) => ["text", "ocr", "embeddings", "rerank"].includes(m.kind) && m.inspection.role === "main")
      .map((m) => ({ id: m.id, object: "model", owned_by: "local", created: Math.floor(m.mtimeMs / 1000), meta: { kind: m.kind, arch: m.inspection.arch, quant: m.inspection.quant, sizeBytes: m.sizeBytes } }));
    const remote = ctx.providers.advertised().map((r) => ({ id: r.id, object: "model", owned_by: r.provider, created: 0 }));
    const running = ctx.engines.registry.running().map((i) => i.model?.id).filter(Boolean);
    return c.json({ object: "list", data: [...local, ...remote], running });
  });

  const proxy = (subpath: string, kinds: ("text" | "ocr" | "embeddings" | "rerank")[]) => async (c: Context) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json(oaiError("corpo JSON inválido", "invalid_request_error"), 400); }
    const modelRef = String(body.model ?? "");
    if (!modelRef) return c.json(oaiError("informe 'model' (id da biblioteca, id de receita ou provedor:modelo)", "invalid_request_error", "model"), 400);
    const signal = c.req.raw.signal;

    const remote = ctx.providers.split(modelRef);
    if (remote) {
      try {
        const up = await ctx.providers.forward(remote.id, remote.cfg, subpath, { ...body, model: remote.model }, signal);
        return passthrough(up);
      } catch (e) { return c.json(oaiError((e as Error).message, "api_error"), 502); }
    }

    const found = ctx.engines.findModel(modelRef, kinds);
    if (!found) {
      const hint = ctx.models.recipes.get(modelRef) ? ` A receita existe mas não foi baixada: aistudio models pull recipe:${modelRef}` : " Baixe com: aistudio models pull <link do Hugging Face>";
      return c.json(oaiError(`modelo '${modelRef}' não encontrado na biblioteca.${hint}`, "invalid_request_error", "model", "model_not_found"), 404);
    }
    try {
      const inst = await ctx.engines.start(found.model.id, undefined, signal);
      const up = await fetch(`${inst.baseUrl}${subpath}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, model: found.model.id }), signal });
      inst.lastUsedAt = Date.now();
      return passthrough(up);
    } catch (e) {
      log.error(`${subpath} ${modelRef}: ${(e as Error).message}`);
      return c.json(oaiError((e as Error).message, "api_error"), 503);
    }
  };

  app.post("/chat/completions", proxy("/v1/chat/completions", ["text", "ocr"]));
  app.post("/completions", proxy("/v1/completions", ["text"]));
  app.post("/embeddings", proxy("/v1/embeddings", ["embeddings", "text"]));
  app.post("/rerank", proxy("/v1/rerank", ["rerank"]));
  return app;
}

function passthrough(up: Response): Response {
  const headers = new Headers();
  for (const h of ["content-type", "cache-control", "x-request-id"]) { const v = up.headers.get(h); if (v) headers.set(h, v); }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(up.body, { status: up.status, headers });
}

export function oaiError(message: string, type: string, param: string | null = null, code: string | null = null) {
  return { error: { message, type, param, code } };
}
