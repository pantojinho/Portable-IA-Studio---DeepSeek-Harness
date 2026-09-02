import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, type StudioContext } from "../core/context.js";
import { resolvePaths, ensureLayout } from "../core/paths.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { ingestSources } from "./ingest.js";
import { searchProject, chunkMarkdown, reciprocalRankFusion, snippet, estimateTokens } from "./search.js";
import { addMemory, listMemory, writeMemoryFile } from "./memory.js";
import { citationsFor } from "./ask.js";
import type { SearchHit } from "./types.js";

let ctx: StudioContext;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-proj-"));
  const paths = resolvePaths({ root, dataDir: path.join(root, "data") });
  ensureLayout(paths);
  ctx = await createContext(paths, structuredClone(DEFAULT_CONFIG), "test");
});

afterAll(() => {
  ctx?.projects.closeAll();
  ctx?.jobStore.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("documents/projects (DOC-01/02/04)", () => {
  it("cria o projeto com pastas, índice e memória", () => {
    const p = ctx.projects.create({ name: "Notas 2026" });
    expect(p.id).toBe("notas-2026");
    for (const dir of ["sources", "derived", "chats"]) expect(fs.existsSync(path.join(ctx.projects.dir(p.id), dir))).toBe(true);
    expect(fs.existsSync(path.join(ctx.projects.dir(p.id), "index.sqlite"))).toBe(true);
    expect(fs.readFileSync(ctx.projects.memoryFile(p.id), "utf8")).toContain("Notas 2026");
    expect(ctx.projects.list().map((x) => x.id)).toContain("notas-2026");
  });

  it("copia documentos para dentro do projeto e ignora duplicatas por hash", async () => {
    const p = ctx.projects.create({ name: "Contratos" });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-"));
    const a = path.join(tmpDir, "contrato.md");
    fs.writeFileSync(a, "# Contrato de locação\n\nO valor mensal é de R$ 2.500,00 e o vencimento é todo dia 10.");
    const b = path.join(tmpDir, "copia.md");
    fs.copyFileSync(a, b);
    const r = await ctx.projects.addSourceFiles(p.id, [a, b], { ingest: false });
    expect(r.sources).toHaveLength(2);
    expect(new Set(r.sources.map((s) => s.id)).size).toBe(1);   // mesmo conteúdo = mesma fonte
    expect(ctx.projects.sources(p.id)).toHaveLength(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("faz a ingestão e acha o documento pela busca textual (sem modelo de embeddings)", async () => {
    const p = ctx.projects.create({ name: "Financeiro" });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-"));
    const md = path.join(tmpDir, "nota.md");
    fs.writeFileSync(md, "# Nota fiscal 12345\n\nEmitente: Padaria do Bairro LTDA\nValor total: R$ 1.234,56\nVencimento: 10/10/2026");
    const csv = path.join(tmpDir, "tabela.csv");
    fs.writeFileSync(csv, "numero;valor\n12345;1234,56\n999;10,00\n");
    await ctx.projects.addSourceFiles(p.id, [md, csv], { ingest: false });

    const result = await ingestSources(ctx, p.id, {});
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(2);
    expect(result.chunks).toBeGreaterThan(0);
    expect(ctx.projects.sources(p.id).every((s) => s.status === "done")).toBe(true);

    const hits = await searchProject(ctx, { projectId: p.id, query: "padaria do bairro", hybrid: false });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.text).toContain("Padaria do Bairro");
    expect(hits[0]!.source.name).toBe("nota.md");

    const byNumber = await searchProject(ctx, { projectId: p.id, query: "12345", hybrid: false });
    expect(byNumber.length).toBeGreaterThan(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("guarda memória do projeto e espelha em memory.md", () => {
    const p = ctx.projects.create({ name: "Memória" });
    addMemory(ctx, p.id, { text: "O contador é o Sr. Silva.", kind: "user" });
    addMemory(ctx, p.id, { text: "NF-e da Padaria vence dia 10.", kind: "fact" });
    expect(listMemory(ctx, p.id)).toHaveLength(2);
    writeMemoryFile(ctx, p.id);
    const md = fs.readFileSync(ctx.projects.memoryFile(p.id), "utf8");
    expect(md).toContain("## Anotado por você");
    expect(md).toContain("- O contador é o Sr. Silva.");
    expect(md).toContain("## Fatos");
  });

  it("apagar um projeto move para a lixeira, nunca some com os arquivos", () => {
    const p = ctx.projects.create({ name: "Temporário" });
    const { trash } = ctx.projects.delete(p.id);
    expect(fs.existsSync(trash)).toBe(true);
    expect(ctx.projects.get(p.id)).toBeNull();
    expect(fs.existsSync(path.join(trash, "project.json"))).toBe(true);
  });
});

describe("documents/search (DOC-04/05)", () => {
  it("divide o texto respeitando títulos, tabelas e páginas", () => {
    const md = ["<!-- página 1 -->", "# Contrato", "Parágrafo um.", "", "<!-- página 2 -->", "## Valores",
      "| item | valor |", "| --- | --- |", "| aluguel | 2500 |", "", "Parágrafo final."].join("\n");
    const chunks = chunkMarkdown(md, { chunkTokens: 40, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.locator.page).toBe(1);
    expect(chunks.some((c) => c.locator.page === 2)).toBe(true);
    const table = chunks.find((c) => c.text.includes("| aluguel |"));
    expect(table).toBeDefined();
    expect(table!.text).toContain("| item | valor |");   // tabela não é partida ao meio
    expect(chunks.every((c) => c.tokens > 0)).toBe(true);
  });

  it("funde os dois rankings por posição (RRF)", () => {
    const lex = [{ id: "a", score: 9 }, { id: "b", score: 8 }];
    const vec = [{ id: "b", score: 0.9 }, { id: "c", score: 0.8 }];
    const fused = reciprocalRankFusion([lex, vec], 3);
    expect(fused[0]!.id).toBe("b");        // aparece bem nos dois
    expect(fused.map((f) => f.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("recorta o trecho em volta do termo procurado", () => {
    const text = `${"x".repeat(400)} palavra-chave ${"y".repeat(400)}`;
    const s = snippet(text, "palavra-chave", 100);
    expect(s).toContain("palavra-chave");
    expect(s.length).toBeLessThan(140);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("mapeia as citações [n] para arquivo e página", () => {
    const hits = [
      { chunk: { id: "1", sourceId: "s1", ordinal: 0, text: "t1", tokens: 1, locator: { page: 3 } }, score: 1, source: { id: "s1", name: "nota.pdf", path: "/x" }, snippet: "trecho 1" },
      { chunk: { id: "2", sourceId: "s2", ordinal: 0, text: "t2", tokens: 1, locator: {} }, score: 1, source: { id: "s2", name: "contrato.pdf", path: "/y" }, snippet: "trecho 2" },
    ] as SearchHit[];
    const cites = citationsFor("O valor está em [2] e a data em [1].", hits);
    expect(cites.map((c) => c.name)).toEqual(["contrato.pdf", "nota.pdf"]);
    expect(cites[1]!.page).toBe(3);
  });
});
