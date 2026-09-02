import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import { chatJson } from "../core/llm.js";
import { logger } from "../core/log.js";
import type { MemoryEntry } from "./types.js";

const log = logger("memory");

/**
 * DOC-06. Two memories: the project's (facts and glossary learned while reading its documents, plus
 * whatever the user pins) and a global one in data/memory.md. Both are plain Markdown the user can
 * edit by hand — the SQLite table is only the index.
 */
export function listMemory(ctx: StudioContext, projectId: string): MemoryEntry[] {
  const rows = ctx.projects.db(projectId).prepare("SELECT * FROM memory ORDER BY pinned DESC, createdAt DESC").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id), projectId, text: String(r.text), kind: (r.kind as MemoryEntry["kind"]) ?? "fact",
    sourceId: r.sourceId == null ? undefined : String(r.sourceId), createdAt: String(r.createdAt ?? ""), pinned: Number(r.pinned ?? 0) === 1,
  }));
}

export function addMemory(ctx: StudioContext, projectId: string, input: { text: string; kind?: MemoryEntry["kind"]; sourceId?: string; pinned?: boolean }): MemoryEntry {
  const text = input.text.trim();
  if (!text) throw new Error("a lembrança está vazia");
  const entry: MemoryEntry = {
    id: randomUUID(), projectId, text, kind: input.kind ?? "user", sourceId: input.sourceId,
    createdAt: new Date().toISOString(), pinned: input.pinned ?? (input.kind ?? "user") === "user",
  };
  ctx.projects.db(projectId).prepare("INSERT INTO memory (id, text, kind, sourceId, createdAt, pinned) VALUES (?,?,?,?,?,?)")
    .run(entry.id, entry.text, entry.kind, entry.sourceId ?? null, entry.createdAt, entry.pinned ? 1 : 0);
  writeMemoryFile(ctx, projectId);
  return entry;
}

export function deleteMemory(ctx: StudioContext, projectId: string, id: string): boolean {
  const r = ctx.projects.db(projectId).prepare("DELETE FROM memory WHERE id=?").run(id);
  if (Number(r.changes ?? 0) === 0) return false;
  writeMemoryFile(ctx, projectId);
  return true;
}

/** memory.md mirrors the table so the user can read (and edit) it outside the Studio. */
export function writeMemoryFile(ctx: StudioContext, projectId: string): void {
  const project = ctx.projects.require(projectId);
  const entries = listMemory(ctx, projectId);
  const section = (kind: MemoryEntry["kind"], title: string) => {
    const items = entries.filter((e) => e.kind === kind);
    return items.length ? [`## ${title}`, "", ...items.map((e) => `- ${e.text}`), ""] : [];
  };
  const md = [
    `# Memória do projeto ${project.name}`, "",
    "Escrito pelo Studio ao ler os documentos e pelo que você mandou lembrar. Pode editar à mão.", "",
    ...section("user", "Anotado por você"),
    ...section("fact", "Fatos"),
    ...section("glossary", "Glossário"),
    ...section("summary", "Resumos"),
  ].join("\n");
  fs.writeFileSync(ctx.projects.memoryFile(projectId), md);
}

/** Read back what the user edited by hand (the file wins over the table for `user` entries). */
export function memoryPrompt(ctx: StudioContext, projectId: string, limit = 40): string {
  const entries = listMemory(ctx, projectId).slice(0, limit);
  const global = globalMemory(ctx);
  const parts: string[] = [];
  if (global) parts.push(`Memória geral do usuário:\n${global}`);
  if (entries.length) parts.push(`Memória deste projeto:\n${entries.map((e) => `- ${e.text}`).join("\n")}`);
  return parts.join("\n\n");
}

export function globalMemory(ctx: StudioContext): string {
  const file = path.join(ctx.paths.data, "memory.md");
  try { return fs.readFileSync(file, "utf8").replace(/^#.*$/gm, "").trim().slice(0, 4000); } catch { return ""; }
}

export function setGlobalMemory(ctx: StudioContext, text: string): void {
  fs.mkdirSync(ctx.paths.data, { recursive: true });
  fs.writeFileSync(path.join(ctx.paths.data, "memory.md"), text);
}

/**
 * After a document is indexed, a small model pulls out the few facts worth keeping. Failure here is
 * never fatal: memory is a convenience, the index is the source of truth.
 */
export async function rememberSource(ctx: StudioContext, projectId: string, sourceId: string, markdown: string, o: { model?: string; signal?: AbortSignal } = {}): Promise<MemoryEntry[]> {
  if (markdown.length < 400) return [];
  const source = ctx.projects.source(projectId, sourceId);
  const data = await chatJson<{ facts?: string[]; glossary?: string[]; summary?: string }>(ctx, {
    model: o.model,
    temperature: 0,
    maxTokens: 700,
    signal: o.signal,
    messages: [
      { role: "system", content: "Você extrai memória de documentos em português do Brasil. Só registre o que está escrito; nada de suposições." },
      { role: "user", content: `Documento: ${source?.name ?? sourceId}\n\n${markdown.slice(0, 12000)}\n\nResponda em JSON: {"summary": "resumo em 2 linhas", "facts": ["fatos objetivos, com números e datas"], "glossary": ["termo — significado usado neste projeto"]}` },
    ],
  });
  const created: MemoryEntry[] = [];
  const add = (text: string, kind: MemoryEntry["kind"]) => {
    const clean = text.trim();
    if (clean.length < 3 || clean.length > 400) return;
    if (listMemory(ctx, projectId).some((e) => e.text === clean)) return;
    created.push(addMemory(ctx, projectId, { text: clean, kind, sourceId, pinned: false }));
  };
  if (data.summary) add(`${source?.name ?? "documento"}: ${data.summary}`, "summary");
  for (const f of (data.facts ?? []).slice(0, 8)) add(String(f), "fact");
  for (const g of (data.glossary ?? []).slice(0, 8)) add(String(g), "glossary");
  log.debug(`${created.length} lembrança(s) de ${source?.name ?? sourceId}`);
  return created;
}
