import type { StudioContext } from "./context.js";
import { logger } from "./log.js";

const log = logger("llm");

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string | Array<Record<string, unknown>> }

export interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** ask the model for JSON and parse it (llama.cpp honours response_format) */
  json?: boolean;
  signal?: AbortSignal;
}

/**
 * The Studio's own way to talk to a model — used by meeting summaries (AUD-08), document memory
 * (DOC-06), citations (DOC-05) and field extraction (DOC-07). It accepts the same `model` strings the
 * public API does: a library id, a recipe id, or `provedor:modelo`.
 */
export async function chat(ctx: StudioContext, o: ChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    messages: o.messages,
    temperature: o.temperature ?? 0.2,
    max_tokens: o.maxTokens ?? 1024,
    stream: false,
  };
  if (o.json) body.response_format = { type: "json_object" };
  const data = await complete(ctx, o.model, body, o.signal);
  const choice = (data.choices as { message?: { content?: string } }[] | undefined)?.[0];
  return choice?.message?.content ?? "";
}

/** Same call, streamed: yields text deltas as they arrive (DOC-05 answers with citations). */
export async function* chatStream(ctx: StudioContext, o: ChatOptions): AsyncGenerator<string> {
  const target = await resolveTarget(ctx, o.model);
  const body: Record<string, unknown> = {
    model: target.model, messages: o.messages, temperature: o.temperature ?? 0.2,
    max_tokens: o.maxTokens ?? 1024, stream: true,
  };
  const res = target.remote
    ? await ctx.providers.forward(target.remote.id, target.remote.cfg, "/v1/chat/completions", body, o.signal)
    : await fetch(`${target.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: o.signal });
  if (!res.ok || !res.body) throw new Error(`o modelo respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* keep-alive ou fragmento */ }
    }
  }
}

/** Chat that must answer JSON; retries once asking again when the model rambles. */
export async function chatJson<T = Record<string, unknown>>(ctx: StudioContext, o: ChatOptions): Promise<T> {
  const raw = await chat(ctx, { ...o, json: true });
  const parsed = extractJson(raw);
  if (parsed !== null) return parsed as T;
  log.warn("o modelo não devolveu JSON; tentando de novo com instrução explícita");
  const retry = await chat(ctx, {
    ...o, json: true, temperature: 0,
    messages: [...o.messages, { role: "assistant", content: raw.slice(0, 500) }, { role: "user", content: "Responda SOMENTE com o JSON pedido, sem texto em volta." }],
  });
  const second = extractJson(retry);
  if (second === null) throw new Error("o modelo não devolveu JSON válido");
  return second as T;
}

/** Models write ```json fences and prose around the object; take the first balanced JSON value. */
export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const direct = tryParse(cleaned);
  if (direct !== null) return direct;
  for (const open of ["{", "["]) {
    const start = cleaned.indexOf(open);
    if (start < 0) continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        const parsed = tryParse(cleaned.slice(start, i + 1));
        if (parsed !== null) return parsed;
        break;
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown | null { try { return JSON.parse(s) as unknown; } catch { return null; } }

async function complete(ctx: StudioContext, model: string | undefined, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const target = await resolveTarget(ctx, model);
  const payload = { ...body, model: target.model };
  const res = target.remote
    ? await ctx.providers.forward(target.remote.id, target.remote.cfg, "/v1/chat/completions", payload, signal)
    : await fetch(`${target.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
  if (!res.ok) throw new Error(`o modelo respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as Record<string, unknown>;
}

interface Target { model: string; baseUrl?: string; remote?: { id: string; cfg: import("./providers.js").ProviderConfig } }

async function resolveTarget(ctx: StudioContext, ref?: string): Promise<Target> {
  const wanted = ref ?? defaultTextModel(ctx);
  if (!wanted) {
    throw new Error("nenhum modelo de texto disponível. Baixe um (aistudio models pull recipe:qwen3-4b) ou configure um provedor (aistudio providers key openai <CHAVE>).");
  }
  const remote = ctx.providers.split(wanted);
  if (remote) return { model: remote.model, remote: { id: remote.id, cfg: remote.cfg } };
  const found = ctx.engines.findModel(wanted, ["text", "ocr", "vision"]);
  if (!found) throw new Error(`modelo '${wanted}' não está na biblioteca.`);
  const instance = await ctx.engines.start(found.model.id);
  return { model: found.model.id, baseUrl: instance.baseUrl ?? undefined };
}

/** The text model the Studio uses when nobody says which: the configured one, else the smallest local. */
export function defaultTextModel(ctx: StudioContext): string | null {
  const local = ctx.models.registry.list("text").filter((m) => m.inspection.role === "main");
  if (local.length) return local.sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!.id;
  const remote = ctx.providers.advertised()[0];
  return remote?.id ?? null;
}
