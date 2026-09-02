import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../../core/context.js";
import { searchProject } from "../../documents/search.js";
import { askProject, askProjectStream, listChats } from "../../documents/ask.js";
import { addMemory, deleteMemory, listMemory, setGlobalMemory, globalMemory } from "../../documents/memory.js";
import { extractFieldsForSources, validateSources } from "../../documents/fields.js";
import { ocrFileToMarkdown } from "../../documents/ocr.js";

/** DOC-01…DOC-09: projects, sources, ingestion, search, answers with citations, fields and OCR. */
export function projectsRoutes(ctx: StudioContext): { projects: Hono; doctypes: Hono; ocr: Hono } {
  const app = new Hono();

  app.get("/", (c) => c.json({ projects: ctx.projects.list() }));

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null) as { name?: string; id?: string; watch?: string[]; settings?: Record<string, unknown> } | null;
    if (!body?.name?.trim()) return c.json({ error: "informe 'name' (o nome do projeto)" }, 400);
    try { return c.json(ctx.projects.create({ name: body.name, id: body.id, watch: body.watch, settings: body.settings as never }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get("/:id", (c) => {
    const p = ctx.projects.get(c.req.param("id"));
    return p ? c.json({ project: p, sources: ctx.projects.sources(p.id), chats: listChats(ctx, p.id) }) : c.json({ error: "projeto não encontrado" }, 404);
  });

  app.patch("/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; watch?: string[]; settings?: Record<string, unknown> };
    try { return c.json(ctx.projects.update(c.req.param("id"), body as never)); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  app.delete("/:id", (c) => {
    try { return c.json({ ok: true, ...ctx.projects.delete(c.req.param("id")) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  // ------------------------------------------------------------ sources ---
  app.get("/:id/sources", (c) => {
    try { return c.json({ sources: ctx.projects.sources(c.req.param("id")) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  app.post("/:id/sources", async (c) => {
    const id = c.req.param("id");
    try {
      ctx.projects.require(id);
      const type = c.req.header("content-type") ?? "";
      if (type.includes("multipart/form-data")) {
        const form = await c.req.formData();
        const files = form.getAll("file").filter((f): f is File => f instanceof File);
        if (!files.length) return c.json({ error: "envie ao menos um arquivo no campo 'file'" }, 400);
        const added = [];
        for (const f of files) added.push(ctx.projects.addUpload(id, f.name, Buffer.from(await f.arrayBuffer())));
        const job = String(form.get("ingest") ?? "1") !== "0" ? ctx.projects.ingest(id, { sourceIds: added.map((s) => s.id) }) : undefined;
        return c.json({ sources: added, job }, 201);
      }
      const body = await c.req.json().catch(() => null) as { paths?: string[]; move?: boolean; ingest?: boolean } | null;
      if (!body?.paths?.length) return c.json({ error: "informe 'paths' (arquivos ou pastas) ou envie multipart com 'file'" }, 400);
      const r = await ctx.projects.addSourceFiles(id, body.paths, { move: body.move, ingest: body.ingest });
      return c.json(r, 201);
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.delete("/:id/sources/:sid", (c) => {
    try { return ctx.projects.removeSource(c.req.param("id"), c.req.param("sid")) ? c.json({ ok: true }) : c.json({ error: "documento não encontrado" }, 404); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  app.get("/:id/sources/:sid/content", (c) => {
    const s = ctx.projects.source(c.req.param("id"), c.req.param("sid"));
    if (!s) return c.json({ error: "documento não encontrado" }, 404);
    const md = s.derived.markdown && fs.existsSync(s.derived.markdown) ? fs.readFileSync(s.derived.markdown, "utf8") : "";
    return c.json({ source: s, markdown: md });
  });

  app.get("/:id/sources/:sid/file", (c) => {
    const s = ctx.projects.source(c.req.param("id"), c.req.param("sid"));
    if (!s || !fs.existsSync(s.path)) return c.json({ error: "arquivo não encontrado" }, 404);
    return new Response(fs.createReadStream(s.path) as unknown as ReadableStream, {
      headers: { "content-type": s.mime || "application/octet-stream", "content-disposition": `inline; filename="${encodeURIComponent(s.name)}"` },
    });
  });

  app.post("/:id/ingest", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sourceIds?: string[]; force?: boolean };
    try { return c.json({ job: ctx.projects.ingest(c.req.param("id"), body) }, 202); }
    catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  // ------------------------------------------------------------- search ---
  app.post("/:id/search", async (c) => {
    const body = await c.req.json().catch(() => null) as { query?: string; k?: number; hybrid?: boolean; rerank?: boolean; sourceIds?: string[]; docType?: string } | null;
    if (!body?.query?.trim()) return c.json({ error: "informe 'query'" }, 400);
    try {
      const hits = await searchProject(ctx, {
        projectId: c.req.param("id"), query: body.query, k: body.k, hybrid: body.hybrid, rerank: body.rerank,
        filters: { sourceIds: body.sourceIds, docType: body.docType }, signal: c.req.raw.signal,
      });
      return c.json({ hits });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.post("/:id/ask", async (c) => {
    const body = await c.req.json().catch(() => null) as { question?: string; model?: string; k?: number; rerank?: boolean; sourceIds?: string[]; chatId?: string; stream?: boolean } | null;
    if (!body?.question?.trim()) return c.json({ error: "informe 'question'" }, 400);
    const options = { projectId: c.req.param("id"), question: body.question, model: body.model, k: body.k, rerank: body.rerank, sourceIds: body.sourceIds, chatId: body.chatId, signal: c.req.raw.signal };
    if (!body.stream) {
      try { return c.json(await askProject(ctx, options)); }
      catch (e) { return c.json({ error: (e as Error).message }, 422); }
    }
    return streamSSE(c, async (stream) => {
      try {
        for await (const ev of askProjectStream(ctx, options)) {
          if (ev.delta) await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.delta }) });
          if (ev.done) await stream.writeSSE({ event: "done", data: JSON.stringify(ev.done) });
        }
      } catch (e) { await stream.writeSSE({ event: "error", data: JSON.stringify({ error: (e as Error).message }) }); }
    });
  });

  app.get("/:id/chats", (c) => c.json({ chats: listChats(ctx, c.req.param("id")) }));
  app.get("/:id/chats/:chatId", (c) => {
    const file = path.join(ctx.projects.chatsDir(c.req.param("id")), `${c.req.param("chatId")}.json`);
    if (!fs.existsSync(file)) return c.json({ error: "conversa não encontrada" }, 404);
    return c.json(JSON.parse(fs.readFileSync(file, "utf8")));
  });

  // ------------------------------------------------------------- memory ---
  app.get("/:id/memory", (c) => c.json({ memory: listMemory(ctx, c.req.param("id")), global: globalMemory(ctx) }));
  app.post("/:id/memory", async (c) => {
    const body = await c.req.json().catch(() => null) as { text?: string; kind?: "fact" | "glossary" | "summary" | "user"; pinned?: boolean } | null;
    if (!body?.text?.trim()) return c.json({ error: "informe 'text' (o que lembrar)" }, 400);
    try { return c.json(addMemory(ctx, c.req.param("id"), { text: body.text, kind: body.kind, pinned: body.pinned }), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });
  app.delete("/:id/memory/:mid", (c) => deleteMemory(ctx, c.req.param("id"), c.req.param("mid")) ? c.json({ ok: true }) : c.json({ error: "lembrança não encontrada" }, 404));

  // ------------------------------------------------- fields / validation ---
  app.post("/:id/extract", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sourceIds?: string[]; docType?: string; model?: string; force?: boolean };
    const id = c.req.param("id");
    try { ctx.projects.require(id); } catch (e) { return c.json({ error: (e as Error).message }, 404); }
    const job = ctx.jobs.create("ocr", `Extrair campos em ${id}`, (j) => extractFieldsForSources(ctx, id, { ...body, job: j }), { projectId: id });
    return c.json({ job }, 202);
  });

  app.post("/:id/validate", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sourceIds?: string[] };
    try { return c.json({ results: validateSources(ctx, c.req.param("id"), body.sourceIds) }); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.post("/:id/crosscheck", async (c) => {
    const body = await c.req.json().catch(() => null) as { tablePath?: string; docType?: string } | null;
    if (!body?.tablePath || !body.docType) return c.json({ error: "informe 'tablePath' (CSV/XLSX) e 'docType'" }, 400);
    if (!fs.existsSync(body.tablePath)) return c.json({ error: `arquivo não encontrado: ${body.tablePath}` }, 404);
    try { return c.json(ctx.doctypes.crossCheckWithTable(c.req.param("id"), body.tablePath, body.docType)); }
    catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });

  app.get("/:id/report", (c) => {
    const id = c.req.param("id");
    try {
      const sources = ctx.projects.sources(id);
      const withFields = sources.filter((s) => s.fields);
      return c.json({
        project: ctx.projects.require(id),
        totals: {
          sources: sources.length,
          indexed: sources.filter((s) => s.status === "done").length,
          failed: sources.filter((s) => s.status === "failed").length,
          extracted: withFields.length,
          withIssues: withFields.filter((s) => s.validation && !s.validation.ok).length,
        },
        byType: countBy(withFields.map((s) => s.docType ?? "sem tipo")),
        issues: withFields.filter((s) => s.validation && !s.validation.ok)
          .map((s) => ({ sourceId: s.id, name: s.name, docType: s.docType, issues: s.validation!.issues })),
      });
    } catch (e) { return c.json({ error: (e as Error).message }, 404); }
  });

  // ------------------------------------------------------------ watching ---
  app.post("/:id/watch", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { folders?: string[] };
    try {
      const p = body.folders ? ctx.projects.update(c.req.param("id"), { watch: body.folders }) : ctx.projects.require(c.req.param("id"));
      ctx.projects.watch(p.id);
      return c.json({ ok: true, watch: p.watch });
    } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  });
  app.delete("/:id/watch", (c) => { ctx.projects.unwatch(c.req.param("id")); return c.json({ ok: true }); });

  // ------------------------------------------------------------ doctypes ---
  const doctypes = new Hono();
  doctypes.get("/", (c) => c.json({ doctypes: ctx.doctypes.all(c.req.query("refresh") === "1") }));
  doctypes.get("/:id", (c) => {
    const dt = ctx.doctypes.get(c.req.param("id"));
    return dt ? c.json(dt) : c.json({ error: "tipo não encontrado" }, 404);
  });

  // ----------------------------------------------------------------- OCR ---
  const ocr = new Hono();
  ocr.post("/", async (c) => {
    const type = c.req.header("content-type") ?? "";
    let files: string[] = [];
    let model: string | undefined;
    let prompt: string | undefined;
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const uploads = form.getAll("file").filter((f): f is File => f instanceof File);
      if (!uploads.length) return c.json({ error: "envie ao menos um arquivo no campo 'file'" }, 400);
      const dir = path.join(ctx.paths.cache, "ocr-uploads");
      fs.mkdirSync(dir, { recursive: true });
      for (const f of uploads) {
        const dest = path.join(dir, `${Date.now()}-${path.basename(f.name).replace(/[^\w.-]/g, "_")}`);
        fs.writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
        files.push(dest);
      }
      model = String(form.get("model") ?? "") || undefined;
      prompt = String(form.get("prompt") ?? "") || undefined;
    } else {
      const body = await c.req.json().catch(() => null) as { paths?: string[]; model?: string; prompt?: string } | null;
      if (!body?.paths?.length) return c.json({ error: "informe 'paths' ou envie os arquivos por multipart" }, 400);
      files = body.paths;
      model = body.model; prompt = body.prompt;
    }
    const job = ctx.jobs.create("ocr", `OCR de ${files.length} arquivo(s)`, async (j) => {
      const results = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        const r = await ocrFileToMarkdown(ctx, file, {
          model, prompt, signal: j.signal,
          onPage: (page, total) => j.setProgress((i + page / Math.max(1, total)) / files.length, `${path.basename(file)}: página ${page}/${total}`),
        });
        results.push({ file: path.basename(file), pages: r.pages.length, markdown: r.markdown, model: r.model });
      }
      return { files: results };
    }, { files: files.map((f) => path.basename(f)) });
    return c.json({ job }, 202);
  });

  ocr.get("/:jobId/result", (c) => {
    const job = ctx.jobs.get(c.req.param("jobId")) ?? ctx.jobStore.get(c.req.param("jobId"));
    if (!job) return c.json({ error: "trabalho não encontrado" }, 404);
    if (job.status !== "done") return c.json({ error: `o trabalho está '${job.status}'`, job }, 409);
    const result = job.result as { files: { file: string; markdown: string; pages: number }[] } | undefined;
    const format = c.req.query("format") ?? "json";
    if (format === "md") return c.text((result?.files ?? []).map((f) => `# ${f.file}\n\n${f.markdown}`).join("\n\n---\n\n"));
    if (format === "csv") {
      const rows = [["arquivo", "paginas", "caracteres"], ...(result?.files ?? []).map((f) => [f.file, String(f.pages), String(f.markdown.length)])];
      return c.text(rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(",")).join("\n"), 200, { "content-type": "text/csv; charset=utf-8" });
    }
    return c.json(result ?? {});
  });

  return { projects: app, doctypes, ocr };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Global memory lives outside any project (DOC-06). */
export function memoryRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({ text: globalMemory(ctx) }));
  app.put("/", async (c) => {
    const body = await c.req.json().catch(() => null) as { text?: string } | null;
    if (typeof body?.text !== "string") return c.json({ error: "informe 'text'" }, 400);
    setGlobalMemory(ctx, body.text);
    return c.json({ ok: true });
  });
  return app;
}
