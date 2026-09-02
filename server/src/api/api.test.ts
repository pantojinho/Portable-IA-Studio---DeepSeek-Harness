import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, type StudioContext } from "../core/context.js";
import { resolvePaths, ensureLayout } from "../core/paths.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { createApp } from "./app.js";

/**
 * API-02. Contract tests against the real server over HTTP: shapes, status codes and error
 * messages the OpenAI SDKs and MCP clients depend on. No model is needed — what is asserted here is
 * the protocol, and "no model installed" is itself one of the answers that must stay correct.
 */
let ctx: StudioContext;
let base: string;
let server: ReturnType<typeof serve>;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-api-"));
  const paths = resolvePaths({ root, dataDir: path.join(root, "data") });
  ensureLayout(paths);
  // os tipos de documento viajam com a instalação (o pacote de release os copia)
  fs.mkdirSync(path.join(root, "documents", "doctypes"), { recursive: true });
  fs.copyFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../documents/doctypes/builtin.yaml"),
    path.join(root, "documents", "doctypes", "builtin.yaml"),
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.server.openBrowser = false;
  ctx = await createContext(paths, config, "test");
  const app = createApp(ctx);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  ctx?.projects.closeAll();
  ctx?.jobStore.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("API — núcleo", () => {
  it("responde saúde, sistema e configuração", async () => {
    const health = await (await get("/api/v1/health")).json() as { ok: boolean; version: string };
    expect(health.ok).toBe(true);
    expect((await get("/api/v1/system")).status).toBe(200);
    const cfg = await (await get("/api/v1/config")).json() as { config: { server: { apiKey: string | null } }; editable: string[] };
    expect(cfg.config.server.apiKey).toBeNull();
    expect(cfg.editable).toContain("engines.idleUnloadMinutes");
    // /api/v1/system consulta wmic/nvidia-smi/df: nos runners do Windows isso passa de 5 s
  }, 30_000);

  it("valida a configuração e recusa campos protegidos", async () => {
    const ok = await fetch(`${base}/api/v1/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ui: { theme: "dark" } }) });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { changed: string[] }).changed).toEqual(["ui.theme"]);
    const bad = await fetch(`${base}/api/v1/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ui: { theme: "roxo" }, server: { apiKey: "x" } }) });
    expect(bad.status).toBe(422);
    const body = await bad.json() as { errors: string[] };
    expect(body.errors.some((e) => e.includes("ui.theme"))).toBe(true);
    expect(body.errors.some((e) => e.includes("apiKey"))).toBe(true);
  });

  it("lista trabalhos e devolve 404 para um id inventado", async () => {
    expect((await (await get("/api/v1/jobs")).json() as { jobs: unknown[] }).jobs).toEqual([]);
    expect((await get("/api/v1/jobs/nao-existe")).status).toBe(404);
  });
});

describe("API — compatível com OpenAI", () => {
  it("/v1/models tem o formato de lista da OpenAI", async () => {
    const data = await (await get("/v1/models")).json() as { object: string; data: unknown[]; running: unknown[] };
    expect(data.object).toBe("list");
    expect(Array.isArray(data.data)).toBe(true);
  });

  it("erros seguem o envelope da OpenAI, em português", async () => {
    const noModel = await post("/v1/chat/completions", { messages: [{ role: "user", content: "oi" }] });
    expect(noModel.status).toBe(400);
    const err = await noModel.json() as { error: { message: string; type: string; param: string | null } };
    expect(err.error.type).toBe("invalid_request_error");
    expect(err.error.param).toBe("model");
    expect(err.error.message).toMatch(/informe 'model'/);

    const unknown = await post("/v1/chat/completions", { model: "nao-existe", messages: [] });
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("model_not_found");

    const badJson = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(badJson.status).toBe(400);
  });

  it("imagens, fala e transcrição validam a entrada antes de chamar motor nenhum", async () => {
    expect((await post("/v1/images/generations", {})).status).toBe(400);
    expect((await post("/v1/audio/speech", { voice: "x" })).status).toBe(400);
    const speech = await post("/v1/audio/speech", { input: "olá" });
    expect([503, 404]).toContain(speech.status);            // sem voz instalada, mas o contrato responde
    const noFile = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: new FormData() });
    expect(noFile.status).toBe(400);
  });

  it("exige chave quando existe uma configurada", async () => {
    ctx.config.server.apiKey = "segredo-123";
    try {
      expect((await get("/api/v1/health")).status).toBe(401);
      const ok = await fetch(`${base}/api/v1/health`, { headers: { authorization: "Bearer segredo-123" } });
      expect(ok.status).toBe(200);
      const viaHeader = await fetch(`${base}/api/v1/health`, { headers: { "x-api-key": "segredo-123" } });
      expect(viaHeader.status).toBe(200);
    } finally { ctx.config.server.apiKey = null; }
  });
});

describe("API — projetos e MCP", () => {
  it("cria projeto, ingere um documento e responde a busca", async () => {
    const created = await post("/api/v1/projects", { name: "API Teste" });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };

    const file = path.join(root, "nota.md");
    fs.writeFileSync(file, "# Nota 777\n\nFornecedor: Gráfica Central\nValor total: R$ 300,00");
    const added = await post(`/api/v1/projects/${project.id}/sources`, { paths: [file], ingest: false });
    expect(added.status).toBe(201);

    const { ingestSources } = await import("../documents/ingest.js");
    await ingestSources(ctx, project.id, {});

    const search = await post(`/api/v1/projects/${project.id}/search`, { query: "gráfica central", hybrid: false });
    const hits = await search.json() as { hits: { source: { name: string } }[] };
    expect(hits.hits[0]!.source.name).toBe("nota.md");

    const report = await (await get(`/api/v1/projects/${project.id}/report`)).json() as { totals: { sources: number; indexed: number } };
    expect(report.totals.indexed).toBe(1);

    expect((await get("/api/v1/projects/nao-existe")).status).toBe(404);
  });

  it("não deixa a URL virar caminho de arquivo", async () => {
    // %2F é decodificado dentro do segmento: sem validação isso lia qualquer .json do disco
    const traversal = await get("/api/v1/projects/api-teste/chats/..%2F..%2F..%2Fdata%2Fmodel-settings");
    expect(traversal.status).toBe(400);
    expect((await traversal.json() as { error: string }).error).toMatch(/inválido/i);
    expect((await get("/api/v1/meetings/..%2F..%2Fconfig")).status).toBe(404);
  });

  it("expõe os tipos de documento como dados", async () => {
    const data = await (await get("/api/v1/doctypes")).json() as { doctypes: { id: string; validators: string[] }[] };
    const nfe = data.doctypes.find((d) => d.id === "nfe");
    expect(nfe?.validators).toContain("nfeKey");
  });

  it("fala MCP: initialize, tools/list e tools/call", async () => {
    const init = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "1" } } });
    const initBody = await init.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("AI Studio");

    const list = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (await list.json() as { result: { tools: { name: string; inputSchema: unknown }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["chat", "search_project", "extract_fields", "ocr_file", "speak", "generate_image"]));
    expect(tools.every((t) => t.inputSchema && typeof t.inputSchema === "object")).toBe(true);

    const call = await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    const result = await call.json() as { result: { structuredContent: { projects: unknown[] }; isError: boolean } };
    expect(result.result.isError).toBe(false);
    expect(Array.isArray(result.result.structuredContent.projects)).toBe(true);

    // erro de ferramenta vira conteúdo (o agente precisa ler o motivo), não erro de protocolo
    const failing = await post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_document", arguments: { project: "x", source: "y" } } });
    const failed = await failing.json() as { result: { isError: boolean; content: { text: string }[] } };
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0]!.text).toMatch(/projeto|documento/i);

    // método inexistente é erro de protocolo
    const bad = await post("/mcp", { jsonrpc: "2.0", id: 5, method: "nao/existe" });
    expect((await bad.json() as { error: { code: number } }).error.code).toBe(-32601);

    // notificação não gera resposta
    expect((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("serve a interface e cai no index.html para rotas do app", async () => {
    const page = await get("/");
    expect([200, 503]).toContain(page.status);
    if (page.status === 200) expect((await page.text()).toLowerCase()).toContain("<!doctype html");
  });
});
