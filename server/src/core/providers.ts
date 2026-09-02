import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "./context.js";

/**
 * Remote OpenAI-compatible providers ("via API"). Keys live in data/secrets/provider_<id>;
 * the config only names the provider. Model ids on /v1 are "<provider>:<model>" (or "<provider>/<model>").
 */
export interface ProviderConfig { baseURL: string; models: string[]; label?: string; headers?: Record<string, string>; enabled?: boolean }

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  openai: { baseURL: "https://api.openai.com/v1", models: ["gpt-5", "gpt-5-mini", "gpt-4.1-mini"], label: "OpenAI" },
  anthropic: { baseURL: "https://api.anthropic.com/v1", models: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"], label: "Anthropic (compatível OpenAI)" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", models: ["deepseek-chat", "deepseek-reasoner"], label: "DeepSeek" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", models: [], label: "OpenRouter" },
  groq: { baseURL: "https://api.groq.com/openai/v1", models: [], label: "Groq" },
  ollama: { baseURL: "http://127.0.0.1:11434/v1", models: [], label: "Ollama local" },
};

export class Providers {
  constructor(private ctx: StudioContext) {}

  all(): Record<string, ProviderConfig> { return { ...DEFAULT_PROVIDERS, ...(this.ctx.config.providers ?? {}) }; }

  key(id: string): string | null {
    try { return fs.readFileSync(path.join(this.ctx.paths.secrets, `provider_${id}`), "utf8").trim() || null; } catch { return process.env[`${id.toUpperCase()}_API_KEY`] ?? null; }
  }
  setKey(id: string, value: string | null): void {
    const p = path.join(this.ctx.paths.secrets, `provider_${id}`);
    if (!value) { try { fs.unlinkSync(p); } catch { /* */ } return; }
    fs.mkdirSync(this.ctx.paths.secrets, { recursive: true }); fs.writeFileSync(p, value, { mode: 0o600 });
  }

  /** "openai:gpt-5" → { provider, model } when the provider exists; otherwise null (local model). */
  split(modelId: string): { id: string; cfg: ProviderConfig; model: string } | null {
    const m = modelId.match(/^([a-z0-9_-]+)[:/](.+)$/i);
    if (!m) return null;
    const cfg = this.all()[m[1]!.toLowerCase()];
    return cfg && cfg.enabled !== false ? { id: m[1]!.toLowerCase(), cfg, model: m[2]! } : null;
  }

  /** Models we can advertise on /v1/models: only providers that have a key (or need none, like ollama). */
  advertised(): { id: string; provider: string }[] {
    const out: { id: string; provider: string }[] = [];
    for (const [id, cfg] of Object.entries(this.all())) {
      if (cfg.enabled === false) continue;
      if (!this.key(id) && !cfg.baseURL.includes("127.0.0.1")) continue;
      for (const m of cfg.models) out.push({ id: `${id}:${m}`, provider: id });
    }
    return out;
  }

  /** Forward an OpenAI-style request upstream; returns the raw Response for streaming passthrough. */
  async forward(id: string, cfg: ProviderConfig, subpath: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const key = this.key(id);
    if (!key && !cfg.baseURL.includes("127.0.0.1")) throw new Error(`Provedor '${id}' sem chave. Guarde com: aistudio providers key ${id} <CHAVE>`);
    const headers: Record<string, string> = { "content-type": "application/json", ...(cfg.headers ?? {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    if (id === "anthropic" && key) { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
    return fetch(`${cfg.baseURL.replace(/\/+$/, "")}${subpath}`, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
}
