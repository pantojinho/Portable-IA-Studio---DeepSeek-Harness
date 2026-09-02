import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import { cosineSimilarity, ftsQuery, packVector, unpackVector } from "../core/db.js";
import { logger } from "../core/log.js";
import type { Chunk, SearchHit, SearchQuery } from "./types.js";

const log = logger("search");

/**
 * DOC-04. Chunking → embeddings → hybrid search. Two rankings are merged with Reciprocal Rank Fusion:
 * FTS5 finds the exact words (a NF-e number, a CNPJ) and the vectors find the meaning; RRF needs no
 * score calibration between them, which matters because every embedding model scores differently.
 */

export interface ChunkInput { text: string; locator: Chunk["locator"]; ordinal: number; tokens: number }

/**
 * Structure-aware chunking: headings start a new chunk and are repeated as context, tables stay
 * whole (a split table is useless for citations), and page markers keep the page number for the
 * citation.
 */
export function chunkMarkdown(markdown: string, o: { chunkTokens?: number; overlap?: number; startPage?: number } = {}): ChunkInput[] {
  const maxTokens = o.chunkTokens ?? 400;
  const overlap = Math.min(o.overlap ?? 60, Math.floor(maxTokens / 2));
  const out: ChunkInput[] = [];
  let page = o.startPage ?? undefined;
  let heading: string | undefined;
  let buffer: string[] = [];
  let bufferTokens = 0;
  let ordinal = 0;

  const flush = () => {
    const text = buffer.join("\n\n").trim();
    buffer = [];
    const tokens = bufferTokens;
    bufferTokens = 0;
    if (!text) return;
    out.push({ text: heading && !text.startsWith("#") ? `${heading}\n\n${text}` : text, locator: { page, heading }, ordinal: ordinal++, tokens });
  };

  for (const block of splitBlocks(markdown)) {
    const pageMark = /^<!--\s*página\s+(\d+)\s*-->$/i.exec(block.trim());
    if (pageMark) { flush(); page = Number(pageMark[1]); continue; }
    if (/^#{1,6}\s/.test(block)) {
      flush();
      heading = block.replace(/^#+\s*/, "").trim();
      buffer.push(block);
      bufferTokens += estimateTokens(block);
      continue;
    }
    const blockTokens = estimateTokens(block);
    const isTable = block.trimStart().startsWith("|");
    if (bufferTokens + blockTokens > maxTokens && bufferTokens > 0) {
      const tail = overlap > 0 && !isTable ? lastWords(buffer.join("\n\n"), overlap) : "";
      flush();
      if (tail) { buffer.push(tail); bufferTokens += estimateTokens(tail); }
    }
    if (blockTokens > maxTokens && !isTable) {
      for (const piece of splitLongBlock(block, maxTokens)) {
        buffer.push(piece);
        bufferTokens += estimateTokens(piece);
        flush();
      }
      continue;
    }
    buffer.push(block);
    bufferTokens += blockTokens;
  }
  flush();
  return out;
}

function splitBlocks(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] = [];
  let inTable = false;
  const push = () => { const t = cur.join("\n").trim(); if (t) blocks.push(t); cur = []; };
  for (const line of lines) {
    const isTableRow = line.trimStart().startsWith("|");
    if (!line.trim()) { if (!inTable) push(); else cur.push(line); continue; }
    if (/^#{1,6}\s/.test(line) || /^<!--\s*página/i.test(line)) { push(); blocks.push(line.trim()); inTable = false; continue; }
    if (isTableRow !== inTable) { push(); inTable = isTableRow; }
    cur.push(line);
  }
  push();
  return blocks;
}

function splitLongBlock(block: string, maxTokens: number): string[] {
  const sentences = block.match(/[^.!?\n]+[.!?]+|\S[^.!?\n]*$/g) ?? [block];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (estimateTokens(cur + s) > maxTokens && cur) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function lastWords(text: string, tokens: number): string {
  const words = text.split(/\s+/);
  return words.slice(Math.max(0, words.length - Math.round(tokens * 0.75))).join(" ");
}

/** Portuguese averages ~4 characters per token on the tokenizers these models use. */
export function estimateTokens(text: string): number { return Math.max(1, Math.ceil(text.length / 4)); }

// ---------------------------------------------------------- embeddings ---

/** Calls the Studio's own /v1/embeddings (local llama-server or a remote provider). */
export async function embedTexts(ctx: StudioContext, texts: string[], modelRef?: string | null, signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const ref = modelRef ?? ctx.config.documents.embeddingModel ?? defaultEmbeddingModel(ctx);
  if (!ref) {
    throw new Error("nenhum modelo de embeddings na biblioteca. Baixe um com: aistudio models pull recipe:qwen3-embedding-0.6b");
  }
  const remote = ctx.providers.split(ref);
  const out: Float32Array[] = [];
  const batchSize = 16;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const body = { model: remote ? remote.model : ref, input: batch, encoding_format: "float" };
    const res = remote
      ? await ctx.providers.forward(remote.id, remote.cfg, "/v1/embeddings", body, signal)
      : await fetch(`${(await ctx.engines.start(ref, undefined, signal)).baseUrl}/v1/embeddings`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
      });
    if (!res.ok) throw new Error(`embeddings → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { data?: { embedding: number[]; index?: number }[] };
    const items = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (items.length !== batch.length) throw new Error(`o modelo devolveu ${items.length} vetores para ${batch.length} textos`);
    for (const it of items) out.push(Float32Array.from(it.embedding));
  }
  return out;
}

export function defaultEmbeddingModel(ctx: StudioContext): string | null {
  const local = ctx.models.registry.list("embeddings").filter((m) => m.inspection.role === "main");
  return local[0]?.id ?? null;
}

/** Store chunks + FTS rows + vectors for one source (replacing whatever was there). */
export async function indexChunks(ctx: StudioContext, projectId: string, sourceId: string, chunks: ChunkInput[], o: { embed?: boolean; signal?: AbortSignal } = {}): Promise<number> {
  const db = ctx.projects.db(projectId);
  db.prepare("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE sourceId=?)").run(sourceId);
  db.prepare("DELETE FROM chunks WHERE sourceId=?").run(sourceId);
  if (!chunks.length) return 0;

  let vectors: Float32Array[] = [];
  if (o.embed !== false) {
    try {
      const project = ctx.projects.require(projectId);
      vectors = await embedTexts(ctx, chunks.map((c) => c.text), project.settings.embeddingModel, o.signal);
    } catch (e) {
      log.warn(`sem embeddings (${(e as Error).message}); a busca fica só textual até você baixar um modelo`);
    }
  }
  const insert = db.prepare("INSERT INTO chunks (id, sourceId, ordinal, text, locator, tokens, embedding, dim) VALUES (?,?,?,?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts (id, text) VALUES (?,?)");
  db.exec("BEGIN");
  try {
    chunks.forEach((c, i) => {
      const id = randomUUID();
      const vec = vectors[i];
      insert.run(id, sourceId, c.ordinal, c.text, JSON.stringify(c.locator), c.tokens, vec ? packVector(vec) : null, vec ? vec.length : null);
      insertFts.run(id, c.text);
    });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return chunks.length;
}

// -------------------------------------------------------------- search ---

export interface SearchOptions extends SearchQuery { signal?: AbortSignal }

export async function searchProject(ctx: StudioContext, q: SearchOptions): Promise<SearchHit[]> {
  const project = ctx.projects.require(q.projectId);
  const db = ctx.projects.db(q.projectId);
  const k = q.k ?? 8;
  const pool = Math.max(k * 4, 24);

  const filterSql = q.filters?.sourceIds?.length ? ` AND c.sourceId IN (${q.filters.sourceIds.map(() => "?").join(",")})` : "";
  const filterArgs = q.filters?.sourceIds ?? [];

  // 1) exact words (FTS5)
  let lexical: { id: string; score: number }[] = [];
  try {
    lexical = (db.prepare(
      `SELECT c.id AS id, -bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.id
        WHERE chunks_fts MATCH ?${filterSql}
        ORDER BY bm25(chunks_fts) LIMIT ?`,
    ).all(ftsQuery(q.query), ...filterArgs, pool) as { id: string; score: number }[]);
  } catch (e) { log.warn(`busca textual: ${(e as Error).message}`); }

  // 2) meaning (vectors) — sqlite-vec when present, plain JS otherwise
  let semantic: { id: string; score: number }[] = [];
  if (q.hybrid !== false) {
    try {
      const [queryVec] = await embedTexts(ctx, [q.query], project.settings.embeddingModel, q.signal);
      if (queryVec) {
        const rows = db.prepare(`SELECT c.id AS id, c.embedding AS embedding FROM chunks c WHERE c.embedding IS NOT NULL${filterSql}`).all(...filterArgs) as { id: string; embedding: Uint8Array }[];
        semantic = rows
          .map((r) => ({ id: r.id, score: cosineSimilarity(queryVec, unpackVector(r.embedding)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, pool);
      }
    } catch (e) { log.warn(`busca por significado: ${(e as Error).message}`); }
  }

  const fused = reciprocalRankFusion([lexical, semantic], pool);
  if (!fused.length) return [];

  const ids = fused.map((f) => f.id);
  const rows = db.prepare(
    `SELECT c.id, c.sourceId, c.ordinal, c.text, c.locator, c.tokens, s.name, s.path, s.docType
       FROM chunks c JOIN sources s ON s.id = c.sourceId
      WHERE c.id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as Record<string, unknown>[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  let hits: SearchHit[] = fused.flatMap((f) => {
    const r = byId.get(f.id);
    if (!r) return [];
    if (q.filters?.docType && String(r.docType ?? "") !== q.filters.docType) return [];
    const text = String(r.text);
    return [{
      chunk: { id: String(r.id), sourceId: String(r.sourceId), ordinal: Number(r.ordinal), text, tokens: Number(r.tokens ?? 0), locator: JSON.parse(String(r.locator || "{}")) as Chunk["locator"] },
      score: f.score,
      source: { id: String(r.sourceId), name: String(r.name), path: String(r.path), docType: r.docType == null ? undefined : String(r.docType) },
      snippet: snippet(text, q.query),
    }];
  });

  if (q.rerank && hits.length > 1) hits = await rerank(ctx, project.settings.rerankModel, q.query, hits, q.signal);
  return hits.slice(0, k);
}

/** RRF: rank position matters, absolute scores do not. */
export function reciprocalRankFusion(lists: { id: string; score: number }[][], limit: number, kConst = 60): { id: string; score: number }[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => acc.set(item.id, (acc.get(item.id) ?? 0) + 1 / (kConst + rank + 1)));
  }
  return [...acc.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function rerank(ctx: StudioContext, modelRef: string | null, query: string, hits: SearchHit[], signal?: AbortSignal): Promise<SearchHit[]> {
  const ref = modelRef ?? ctx.models.registry.list("rerank")[0]?.id;
  if (!ref) return hits;
  try {
    const instance = await ctx.engines.start(ref, undefined, signal);
    const res = await fetch(`${instance.baseUrl}/v1/rerank`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: ref, query, documents: hits.map((h) => h.chunk.text), top_n: hits.length }),
    });
    if (!res.ok) return hits;
    const data = await res.json() as { results?: { index: number; relevance_score: number }[] };
    if (!data.results?.length) return hits;
    return data.results
      .map((r) => ({ hit: hits[r.index], score: r.relevance_score }))
      .filter((x): x is { hit: SearchHit; score: number } => Boolean(x.hit))
      .sort((a, b) => b.score - a.score)
      .map((x) => ({ ...x.hit, score: x.score }));
  } catch (e) {
    log.warn(`rerank: ${(e as Error).message}`);
    return hits;
  }
}

/** A window around the best-matching word, so the UI can show why the chunk matched. */
export function snippet(text: string, query: string, size = 320): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= size) return flat;
  const terms = query.toLowerCase().split(/\W+/u).filter((t) => t.length > 2);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) { at = lower.indexOf(t); if (at >= 0) break; }
  if (at < 0) return `${flat.slice(0, size)}…`;
  const start = Math.max(0, at - Math.floor(size / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}…`;
}
