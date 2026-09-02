import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import { chat, chatStream } from "../core/llm.js";
import { searchProject } from "./search.js";
import { memoryPrompt } from "./memory.js";
import type { Answer, SearchHit } from "./types.js";

export interface AskOptions {
  projectId: string;
  question: string;
  model?: string;
  k?: number;
  rerank?: boolean;
  sourceIds?: string[];
  /** keep the conversation in projects/<id>/chats/<chatId>.json */
  chatId?: string;
  signal?: AbortSignal;
}

export interface AskContext { hits: SearchHit[]; system: string; user: string; chatId: string }

/**
 * DOC-05. Answers must be checkable: the prompt numbers the excerpts, the model cites [n], and the
 * citations are mapped back to file and page. A model that finds nothing is told to say so — an
 * invented answer is worse than "não encontrei".
 */
export async function prepareAsk(ctx: StudioContext, o: AskOptions): Promise<AskContext> {
  const project = ctx.projects.require(o.projectId);
  const question = o.question.trim();
  if (!question) throw new Error("faça uma pergunta");
  const hits = await searchProject(ctx, {
    projectId: o.projectId, query: question, k: o.k ?? 8, hybrid: true, rerank: o.rerank ?? true,
    filters: o.sourceIds?.length ? { sourceIds: o.sourceIds } : undefined, signal: o.signal,
  });
  const memory = memoryPrompt(ctx, o.projectId);
  const system = [
    `Você responde perguntas sobre os documentos do projeto "${project.name}", em português do Brasil.`,
    "Use somente os trechos numerados fornecidos. Cite as fontes no formato [1], [2] logo após a informação.",
    "Se os trechos não responderem, diga exatamente o que falta — nunca invente números, datas ou nomes.",
    memory ? `\n${memory}` : "",
  ].join(" ").trim();
  const user = [
    ...hits.map((h, i) => `[${i + 1}] ${h.source.name}${h.chunk.locator.page ? `, página ${h.chunk.locator.page}` : ""}\n${h.chunk.text}`),
    "",
    `Pergunta: ${question}`,
  ].join("\n\n");
  return { hits, system, user, chatId: o.chatId ?? randomUUID() };
}

export async function askProject(ctx: StudioContext, o: AskOptions): Promise<Answer> {
  const prepared = await prepareAsk(ctx, o);
  if (!prepared.hits.length) {
    return { text: "Não encontrei nada sobre isso nos documentos deste projeto.", citations: [], model: o.model ?? "—", usedChunks: 0 };
  }
  const text = await chat(ctx, {
    model: o.model, temperature: 0.1, maxTokens: 1200, signal: o.signal,
    messages: [{ role: "system", content: prepared.system }, { role: "user", content: prepared.user }],
  });
  const answer: Answer = {
    text: text.trim(),
    citations: citationsFor(text, prepared.hits),
    model: o.model ?? "local",
    usedChunks: prepared.hits.length,
  };
  saveChatTurn(ctx, o.projectId, prepared.chatId, o.question, answer);
  return answer;
}

/** Streaming version for the UI; the citations arrive at the end, once the text is complete. */
export async function* askProjectStream(ctx: StudioContext, o: AskOptions): AsyncGenerator<{ delta?: string; done?: Answer }> {
  const prepared = await prepareAsk(ctx, o);
  if (!prepared.hits.length) {
    const empty: Answer = { text: "Não encontrei nada sobre isso nos documentos deste projeto.", citations: [], model: o.model ?? "—", usedChunks: 0 };
    yield { delta: empty.text };
    yield { done: empty };
    return;
  }
  let text = "";
  for await (const delta of chatStream(ctx, {
    model: o.model, temperature: 0.1, maxTokens: 1200, signal: o.signal,
    messages: [{ role: "system", content: prepared.system }, { role: "user", content: prepared.user }],
  })) {
    text += delta;
    yield { delta };
  }
  const answer: Answer = { text: text.trim(), citations: citationsFor(text, prepared.hits), model: o.model ?? "local", usedChunks: prepared.hits.length };
  saveChatTurn(ctx, o.projectId, prepared.chatId, o.question, answer);
  yield { done: answer };
}

/** Only citations the model actually used, in the order it used them. */
export function citationsFor(text: string, hits: SearchHit[]): Answer["citations"] {
  const used = [...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  const unique = [...new Set(used)].filter((n) => n >= 1 && n <= hits.length);
  const list = unique.length ? unique : hits.slice(0, 3).map((_, i) => i + 1);
  return list.map((n) => {
    const h = hits[n - 1]!;
    return {
      sourceId: h.source.id,
      name: h.source.name,
      page: h.chunk.locator.page,
      quote: h.snippet,
    };
  });
}

function saveChatTurn(ctx: StudioContext, projectId: string, chatId: string, question: string, answer: Answer): void {
  try {
    const dir = ctx.projects.chatsDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${chatId}.json`);
    const history: { id: string; createdAt: string; turns: unknown[] } = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; createdAt: string; turns: unknown[] }
      : { id: chatId, createdAt: new Date().toISOString(), turns: [] };
    history.turns.push({ at: new Date().toISOString(), question, answer });
    fs.writeFileSync(file, JSON.stringify(history, null, 2));
  } catch { /* histórico é conveniência, não pode derrubar a resposta */ }
}

export function listChats(ctx: StudioContext, projectId: string): { id: string; createdAt: string; turns: number; first: string }[] {
  const dir = ctx.projects.chatsDir(projectId);
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  return names.flatMap((n) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { id: string; createdAt: string; turns: { question: string }[] };
      return [{ id: data.id, createdAt: data.createdAt, turns: data.turns.length, first: data.turns[0]?.question ?? "" }];
    } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
