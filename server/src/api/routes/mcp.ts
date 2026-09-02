import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../../core/context.js";
import { chat } from "../../core/llm.js";
import { searchProject } from "../../documents/search.js";
import { askProject } from "../../documents/ask.js";
import { extractFieldsForSources } from "../../documents/fields.js";
import { ocrFileToMarkdown } from "../../documents/ocr.js";
import { transcribeFile } from "../../audio/stt.js";
import { runValidators } from "../../documents/validators.js";
import { logger } from "../../core/log.js";

const log = logger("mcp");
const PROTOCOL_VERSION = "2025-06-18";

/**
 * AGT-04 + DOC-10. The Studio speaks MCP so the embedded agent (dsh) — and any other MCP client —
 * can use the local models: chat, images, video, speech, transcription, OCR, project search and
 * invoice extraction. Streamable HTTP is plain JSON-RPC over POST, so this needs no SDK and adds no
 * dependency to the bundle (AGENTS.md §2.3). Tools never run arbitrary shell (AGENTS.md §2.10).
 */
interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: StudioContext, signal?: AbortSignal) => Promise<unknown>;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function prop(type: string, description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, description, ...extra };
}

export const MCP_TOOLS: ToolDef[] = [
  {
    name: "chat",
    description: "Conversa com um modelo de texto local (ou de um provedor configurado) e devolve a resposta.",
    schema: {
      type: "object",
      properties: {
        prompt: prop("string", "A pergunta ou instrução."),
        system: prop("string", "Instrução de sistema (opcional)."),
        model: prop("string", "Id do modelo na biblioteca, id de receita ou 'provedor:modelo'."),
        max_tokens: prop("number", "Limite de tokens da resposta."),
      },
      required: ["prompt"],
    },
    run: async (a, ctx, signal) => {
      const text = await chat(ctx, {
        model: str(a.model) || undefined, maxTokens: num(a.max_tokens) ?? 1024, signal,
        messages: [...(a.system ? [{ role: "system" as const, content: str(a.system) }] : []), { role: "user" as const, content: str(a.prompt) }],
      });
      return { text };
    },
  },
  {
    name: "list_models",
    description: "Lista os modelos da biblioteca local e os provedores remotos com chave configurada.",
    schema: { type: "object", properties: { kind: prop("string", "Filtra por tipo: text, image, speech, tts, embeddings, ocr…") } },
    run: async (a, ctx) => ({
      local: ctx.models.registry.list(str(a.kind) ? (str(a.kind) as never) : undefined)
        .filter((m) => m.inspection.role === "main" || m.inspection.role === "diffusion")
        .map((m) => ({ id: m.id, kind: m.kind, quant: m.inspection.quant, sizeBytes: m.sizeBytes })),
      remote: ctx.providers.advertised().map((r) => r.id),
      running: ctx.engines.registry.running().map((i) => ({ id: i.id, status: i.status })),
    }),
  },
  {
    name: "download_model",
    description: "Baixa um modelo por link (Hugging Face, CivitAI) ou receita. Devolve o trabalho em andamento.",
    schema: { type: "object", properties: { ref: prop("string", "Link, 'org/repo', 'org/repo:Q4_K_M' ou 'recipe:<id>'."), quant: prop("string", "Quantização preferida.") }, required: ["ref"] },
    run: async (a, ctx) => {
      const plan = await ctx.models.resolve(str(a.ref), { quant: str(a.quant) || null });
      const job = ctx.models.pull(plan);
      return { job: job.id, title: plan.title, files: plan.files.map((f) => f.filename), totalBytes: plan.totalBytes, warnings: plan.warnings };
    },
  },
  {
    name: "generate_image",
    description: "Gera uma imagem com o motor local (stable-diffusion.cpp). Devolve o caminho do arquivo.",
    schema: {
      type: "object",
      properties: {
        prompt: prop("string", "Descrição da imagem."), negative: prop("string", "O que evitar."),
        width: prop("number", "Largura em pixels."), height: prop("number", "Altura em pixels."),
        steps: prop("number", "Passos de amostragem."), seed: prop("number", "Semente."), model: prop("string", "Modelo de imagem."),
      },
      required: ["prompt"],
    },
    run: async (a, ctx, signal) => {
      const r = await generateImage(ctx, a, signal);
      return { files: r.files, params: r.output };
    },
  },
  {
    name: "generate_video",
    description: "Gera um vídeo curto (sd.cpp vid_gen) e monta o mp4. Demora minutos.",
    schema: {
      type: "object",
      properties: {
        prompt: prop("string", "Descrição do vídeo."), frames: prop("number", "Quantidade de quadros."),
        fps: prop("number", "Quadros por segundo."), width: prop("number", ""), height: prop("number", ""), model: prop("string", ""),
      },
      required: ["prompt"],
    },
    run: async (a, ctx, signal) => {
      const r = await generateImage(ctx, { ...a, task: "txt2vid", frames: num(a.frames) ?? 33, fps: num(a.fps) ?? 16 }, signal);
      return { files: r.files, note: "os quadros estão em data/outputs/images; use /api/v1/generate/video para o mp4 pronto" };
    },
  },
  {
    name: "speak",
    description: "Converte texto em fala com uma voz instalada. Devolve o caminho do áudio.",
    schema: {
      type: "object",
      properties: { text: prop("string", "O que falar."), voice: prop("string", "Id da voz (veja list_voices)."), format: prop("string", "wav, mp3, ogg ou flac."), speed: prop("number", "1 = normal.") },
      required: ["text"],
    },
    run: async (a, ctx, signal) => {
      const r = await ctx.tts.speak({ text: str(a.text), voice: str(a.voice) || undefined, format: (str(a.format) || "wav") as "wav", speed: num(a.speed), signal });
      return { file: r.file, voice: r.voice.id, ms: r.ms };
    },
  },
  {
    name: "list_voices",
    description: "Lista as vozes disponíveis para o speak.",
    schema: { type: "object", properties: {} },
    run: async (_a, ctx) => ({ voices: ctx.voices.list().map((v) => ({ id: v.id, name: v.name, engine: v.engine, language: v.language })) }),
  },
  {
    name: "transcribe",
    description: "Transcreve um arquivo de áudio ou vídeo com o whisper local.",
    schema: {
      type: "object",
      properties: { file: prop("string", "Caminho do arquivo."), language: prop("string", "Idioma (pt, en…) ou 'auto'."), diarize: prop("boolean", "Separar falantes."), translate: prop("boolean", "Traduzir para inglês.") },
      required: ["file"],
    },
    run: async (a, ctx, signal) => {
      const t = await transcribeFile(ctx, str(a.file), { language: str(a.language) || undefined, diarize: a.diarize === true, translateToEnglish: a.translate === true, signal });
      return { text: t.text, language: t.language, duration: t.duration, segments: t.segments.length };
    },
  },
  {
    name: "ocr_file",
    description: "Lê um PDF escaneado ou uma imagem com o modelo de visão e devolve Markdown.",
    schema: { type: "object", properties: { file: prop("string", "Caminho do PDF ou da imagem."), model: prop("string", "Modelo de OCR."), max_pages: prop("number", "Limite de páginas.") }, required: ["file"] },
    run: async (a, ctx, signal) => {
      const r = await ocrFileToMarkdown(ctx, str(a.file), { model: str(a.model) || undefined, maxPages: num(a.max_pages), signal });
      return { markdown: r.markdown, pages: r.pages.length, model: r.model };
    },
  },
  {
    name: "list_projects",
    description: "Lista os projetos de documentos do Studio.",
    schema: { type: "object", properties: {} },
    run: async (_a, ctx) => ({ projects: ctx.projects.list().map((p) => ({ id: p.id, name: p.name, sources: p.stats.sources, chunks: p.stats.chunks })) }),
  },
  {
    name: "search_project",
    description: "Busca trechos nos documentos de um projeto (texto + significado) e devolve as citações.",
    schema: {
      type: "object",
      properties: { project: prop("string", "Id do projeto."), query: prop("string", "O que procurar."), k: prop("number", "Quantos trechos (padrão 8).") },
      required: ["project", "query"],
    },
    run: async (a, ctx, signal) => {
      const hits = await searchProject(ctx, { projectId: str(a.project), query: str(a.query), k: num(a.k) ?? 8, signal });
      return { hits: hits.map((h) => ({ source: h.source.name, page: h.chunk.locator.page, score: h.score, text: h.snippet })) };
    },
  },
  {
    name: "ask_project",
    description: "Pergunta aos documentos de um projeto e devolve a resposta com citações.",
    schema: {
      type: "object",
      properties: { project: prop("string", "Id do projeto."), question: prop("string", "A pergunta."), model: prop("string", "Modelo a usar.") },
      required: ["project", "question"],
    },
    run: async (a, ctx, signal) => askProject(ctx, { projectId: str(a.project), question: str(a.question), model: str(a.model) || undefined, signal }),
  },
  {
    name: "read_document",
    description: "Devolve o texto (Markdown) já extraído de um documento do projeto.",
    schema: { type: "object", properties: { project: prop("string", "Id do projeto."), source: prop("string", "Id ou nome do documento.") }, required: ["project", "source"] },
    run: async (a, ctx) => {
      const sources = ctx.projects.sources(str(a.project));
      const s = sources.find((x) => x.id === str(a.source)) ?? sources.find((x) => x.name === str(a.source));
      if (!s) throw new Error(`documento '${str(a.source)}' não existe no projeto`);
      const md = s.derived.markdown && fs.existsSync(s.derived.markdown) ? fs.readFileSync(s.derived.markdown, "utf8") : "";
      return { name: s.name, status: s.status, pages: s.pages, docType: s.docType, markdown: md.slice(0, 200_000) };
    },
  },
  {
    name: "extract_fields",
    description: "Classifica e extrai os campos dos documentos de um projeto (NF-e, boleto, contrato…).",
    schema: {
      type: "object",
      properties: { project: prop("string", "Id do projeto."), sources: prop("array", "Ids dos documentos (vazio = todos).", { items: { type: "string" } }), doc_type: prop("string", "Forçar um tipo.") },
      required: ["project"],
    },
    run: async (a, ctx, signal) => {
      const ids = Array.isArray(a.sources) ? (a.sources as unknown[]).map(String) : undefined;
      void signal;
      const r = await extractFieldsForSources(ctx, str(a.project), { sourceIds: ids, docType: str(a.doc_type) || undefined });
      return { ok: r.ok, comProblema: r.withIssues, falhas: r.failed, resultados: r.results.map((x) => ({ documento: x.name, tipo: x.docType, campos: x.fields, problemas: x.validation?.issues ?? [] })) };
    },
  },
  {
    name: "validate_document",
    description: "Roda as verificações brasileiras (chave NF-e, CNPJ, CPF, soma de itens, datas) sobre campos já extraídos.",
    schema: {
      type: "object",
      properties: { fields: prop("object", "Campos do documento."), doc_type: prop("string", "Tipo do documento (nfe, nfse, boleto…).") },
      required: ["fields"],
    },
    run: async (a, ctx) => {
      const docType = str(a.doc_type) ? ctx.doctypes.get(str(a.doc_type)) : undefined;
      const validators = docType?.validators ?? ["nfeKey", "cnpj", "cpf", "itemsSum", "dates", "positiveAmounts"];
      return runValidators(validators, (a.fields ?? {}) as Record<string, unknown>, docType?.id);
    },
  },
  {
    name: "check_against_table",
    description: "Cruza os documentos extraídos de um projeto com uma planilha (CSV/XLSX) e aponta as divergências.",
    schema: {
      type: "object",
      properties: { project: prop("string", "Id do projeto."), table: prop("string", "Caminho do CSV ou XLSX."), doc_type: prop("string", "Tipo de documento a cruzar.") },
      required: ["project", "table", "doc_type"],
    },
    run: async (a, ctx) => ctx.doctypes.crossCheckWithTable(str(a.project), str(a.table), str(a.doc_type)),
  },
];

async function generateImage(ctx: StudioContext, a: Record<string, unknown>, signal?: AbortSignal) {
  const ref = str(a.model) || ctx.models.registry.list("image").find((m) => m.inspection.role === "main" || m.inspection.role === "diffusion")?.id;
  if (!ref) throw new Error("nenhum modelo de imagem na biblioteca");
  const found = ctx.engines.findModel(ref, ["image", "video"]);
  if (!found) throw new Error(`modelo '${ref}' não encontrado`);
  const recipe = found.model.recipe ? ctx.models.recipes.get(found.model.recipe.id) : undefined;
  const install = await ctx.engines.ensureInstalled("sdcpp");
  const instance = await ctx.engines.supervisor.ensure("sdcpp", { model: found.model, companions: found.companions, backend: install.backend, recipeArgs: recipe?.engineArgs?.sdcpp, signal });
  const adapter = ctx.engines.registry.get("sdcpp")!;
  return adapter.run(instance, { task: (str(a.task) || "txt2img") as "txt2img", input: a, signal });
}

export function mcpRoutes(ctx: StudioContext): Hono {
  const app = new Hono();
  const sessions = new Set<string>();

  const handle = async (req: JsonRpcRequest, signal?: AbortSignal): Promise<Record<string, unknown> | null> => {
    switch (req.method) {
      case "initialize": {
        const session = randomUUID();
        sessions.add(session);
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "AI Studio", version: ctx.version },
          instructions: "Ferramentas do AI Studio local: modelos de texto e imagem, fala, transcrição, OCR e projetos de documentos. Caminhos de arquivo são do computador onde o Studio roda.",
          _sessionId: session,
        };
      }
      case "notifications/initialized": return null;
      case "ping": return {};
      case "tools/list":
        return { tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) };
      case "tools/call": {
        const name = str(req.params?.name);
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) throw Object.assign(new Error(`ferramenta '${name}' não existe`), { code: -32602 });
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await tool.run(args, ctx, signal);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown>, isError: false };
        } catch (e) {
          // MCP: a tool failure is content, not a protocol error — the agent needs to read the reason
          log.warn(`${name}: ${(e as Error).message}`);
          return { content: [{ type: "text", text: `Erro em ${name}: ${(e as Error).message}` }], isError: true };
        }
      }
      case "resources/list": return { resources: [] };
      case "prompts/list": return { prompts: [] };
      default:
        throw Object.assign(new Error(`método '${req.method}' não suportado`), { code: -32601 });
    }
  };

  app.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }, 400); }
    const batch = Array.isArray(body) ? body as JsonRpcRequest[] : [body as JsonRpcRequest];
    const responses: Record<string, unknown>[] = [];
    let sessionId: string | undefined;
    for (const req of batch) {
      if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
        responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "requisição JSON-RPC inválida" } });
        continue;
      }
      try {
        const result = await handle(req, c.req.raw.signal);
        if (result && "_sessionId" in result) { sessionId = String(result._sessionId); delete result._sessionId; }
        if (req.id !== undefined && req.id !== null) responses.push({ jsonrpc: "2.0", id: req.id, result: result ?? {} });
      } catch (e) {
        const err = e as Error & { code?: number };
        if (req.id !== undefined && req.id !== null) responses.push({ jsonrpc: "2.0", id: req.id, error: { code: err.code ?? -32603, message: err.message } });
      }
    }
    if (!responses.length) return new Response(null, { status: 202 });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers });
  });

  // Streamable HTTP allows a GET for server-initiated messages; the Studio has none to push.
  app.get("/", (c) => c.json({ error: "este servidor MCP só usa POST (JSON-RPC)", tools: MCP_TOOLS.length }, 405));
  app.delete("/", (c) => { sessions.clear(); return c.body(null, 204); });
  return app;
}

/** The dsh (and any MCP client) needs this snippet to reach the Studio. */
export function mcpClientConfig(ctx: StudioContext): Record<string, unknown> {
  const url = `http://127.0.0.1:${ctx.config.server.port}/mcp`;
  return { mcpServers: { aistudio: { type: "http", url, ...(ctx.config.server.apiKey ? { headers: { Authorization: `Bearer ${ctx.config.server.apiKey}` } } : {}) } } };
}

export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name);
