import fs from "node:fs";
import YAML from "yaml";
import type { Paths } from "./paths.js";

export interface StudioConfig {
  server: {
    host: string;
    port: number;
    openBrowser: boolean;
    apiKey: string | null;
    corsOrigins: string[];
    /** API-01: requests per minute per client when the server is exposed (0 = sem limite) */
    rateLimitPerMinute: number;
  };
  ui: { language: "pt-BR" | "en"; theme: "system" | "dark" | "light" };
  engines: {
    /** minutes an engine may sit idle before it is unloaded (0 = never) */
    idleUnloadMinutes: number;
    /** "auto" picks the best backend for the detected GPU */
    preferredBackend: "auto" | "cuda" | "vulkan" | "metal" | "rocm" | "cpu";
    vramBudgetMiB: number | "auto";
  };
  downloads: {
    parallelFiles: number;
    parallelChunks: number;
    maxSpeedMiBps: number | null;
    hfMirror: string | null;
  };
  agent: { enabled: boolean; port: number; workspace?: string | null };
  audio: {
    /** voice id used when the caller does not name one */
    defaultVoice: string | null;
    /** whisper model id used by transcriptions and meetings */
    sttModel: string | null;
    /** meeting transcription window in seconds (AUD-08) */
    meetingWindowSec: number;
  };
  documents: {
    embeddingModel: string | null;
    rerankModel: string | null;
    ocrModel: string | null;
    chunkTokens: number;
    chunkOverlap: number;
  };
  /** remote OpenAI-compatible providers; keys live in data/secrets/provider_<id> */
  providers?: Record<string, { baseURL: string; models: string[]; label?: string; headers?: Record<string, string>; enabled?: boolean }>;
}

export const DEFAULT_CONFIG: StudioConfig = {
  server: { host: "127.0.0.1", port: 1420, openBrowser: true, apiKey: null, corsOrigins: [], rateLimitPerMinute: 0 },
  ui: { language: "pt-BR", theme: "system" },
  engines: { idleUnloadMinutes: 10, preferredBackend: "auto", vramBudgetMiB: "auto" },
  downloads: { parallelFiles: 2, parallelChunks: 4, maxSpeedMiBps: null, hfMirror: null },
  agent: { enabled: true, port: 3080 },
  audio: { defaultVoice: null, sttModel: null, meetingWindowSec: 25 },
  documents: { embeddingModel: null, rerankModel: null, ocrModel: null, chunkTokens: 400, chunkOverlap: 60 },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)
      ? deepMerge(cur, v)
      : v;
  }
  return out as T;
}

export function loadConfig(p: Paths): StudioConfig {
  if (!fs.existsSync(p.config)) {
    saveConfig(p, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = fs.readFileSync(p.config, "utf8");
  const parsed = raw.trim() ? YAML.parse(raw) : {};
  return deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
}

export function saveConfig(p: Paths, cfg: StudioConfig): void {
  const doc = new YAML.Document(cfg);
  doc.commentBefore = " AI Studio — configuração. Editável à mão; o servidor relê ao reiniciar.";
  fs.mkdirSync(p.data, { recursive: true });
  fs.writeFileSync(p.config, String(doc), "utf8");
}

/** CLI flags override the file for this run only. */
export function applyCliOverrides(cfg: StudioConfig, flags: Record<string, string | boolean | undefined>): StudioConfig {
  const c = structuredClone(cfg);
  if (typeof flags.host === "string") c.server.host = flags.host;
  if (typeof flags.port === "string") c.server.port = Number(flags.port);
  if (flags["no-open"]) c.server.openBrowser = false;
  if (flags.headless) c.server.openBrowser = false;
  if (typeof flags["api-key"] === "string") c.server.apiKey = flags["api-key"];
  return c;
}

// ------------------------------------------------------------------ CORE-02 ---

type Rule =
  | { type: "boolean" }
  | { type: "string"; enum?: string[]; nullable?: boolean }
  | { type: "number"; min?: number; max?: number; int?: boolean; nullable?: boolean; special?: string[] }
  | { type: "string[]" };

/**
 * Only these keys can be changed over the API (`PUT /api/v1/config`). Secrets never travel here:
 * the API key and provider keys live in data/secrets/ and have their own endpoints (AGENTS.md §4).
 */
export const EDITABLE: Record<string, Rule> = {
  "server.port": { type: "number", min: 1, max: 65535, int: true },
  "server.openBrowser": { type: "boolean" },
  "server.corsOrigins": { type: "string[]" },
  "server.rateLimitPerMinute": { type: "number", min: 0, max: 100000, int: true },
  "ui.language": { type: "string", enum: ["pt-BR", "en"] },
  "ui.theme": { type: "string", enum: ["system", "dark", "light"] },
  "engines.idleUnloadMinutes": { type: "number", min: 0, max: 1440, int: true },
  "engines.preferredBackend": { type: "string", enum: ["auto", "cuda", "vulkan", "metal", "rocm", "cpu"] },
  "engines.vramBudgetMiB": { type: "number", min: 0, max: 1000000, int: true, special: ["auto"] },
  "downloads.parallelFiles": { type: "number", min: 1, max: 8, int: true },
  "downloads.parallelChunks": { type: "number", min: 1, max: 16, int: true },
  "downloads.maxSpeedMiBps": { type: "number", min: 0.1, max: 10000, nullable: true },
  "downloads.hfMirror": { type: "string", nullable: true },
  "agent.enabled": { type: "boolean" },
  "agent.port": { type: "number", min: 1, max: 65535, int: true },
  "agent.workspace": { type: "string", nullable: true },
  "audio.defaultVoice": { type: "string", nullable: true },
  "audio.sttModel": { type: "string", nullable: true },
  "audio.meetingWindowSec": { type: "number", min: 5, max: 300, int: true },
  "documents.embeddingModel": { type: "string", nullable: true },
  "documents.rerankModel": { type: "string", nullable: true },
  "documents.ocrModel": { type: "string", nullable: true },
  "documents.chunkTokens": { type: "number", min: 64, max: 4000, int: true },
  "documents.chunkOverlap": { type: "number", min: 0, max: 1000, int: true },
};

function flatten(patch: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!patch || typeof patch !== "object") return out;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function check(key: string, rule: Rule, v: unknown): string | null {
  if (rule.type === "boolean") return typeof v === "boolean" ? null : `${key}: use true ou false`;
  if (rule.type === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : `${key}: use uma lista de textos`;
  if (rule.type === "string") {
    if (v === null) return rule.nullable ? null : `${key}: não pode ficar vazio`;
    if (typeof v !== "string") return `${key}: use texto`;
    if (rule.enum && !rule.enum.includes(v)) return `${key}: use um de ${rule.enum.join(", ")}`;
    return null;
  }
  if (v === null) return rule.nullable ? null : `${key}: não pode ficar vazio`;
  if (typeof v === "string" && rule.special?.includes(v)) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${key}: use um número${rule.special ? ` ou ${rule.special.join("/")}` : ""}`;
  if (rule.int && !Number.isInteger(v)) return `${key}: use um número inteiro`;
  if (rule.min !== undefined && v < rule.min) return `${key}: mínimo ${rule.min}`;
  if (rule.max !== undefined && v > rule.max) return `${key}: máximo ${rule.max}`;
  return null;
}

export interface ConfigPatchResult { config: StudioConfig; changed: string[]; errors: string[]; needsRestart: string[] }

/** Validate + apply a partial config. Rejects unknown/protected keys instead of silently dropping them. */
export function applyConfigPatch(cfg: StudioConfig, patch: unknown): ConfigPatchResult {
  const flat = flatten(patch);
  const errors: string[] = []; const changed: string[] = []; const needsRestart: string[] = [];
  const next = structuredClone(cfg);
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith("providers.")) continue; // provedores têm rota própria
    const rule = EDITABLE[key];
    if (!rule) {
      errors.push(key === "server.apiKey" || key.startsWith("secrets")
        ? `${key}: chaves não são editadas por aqui (use POST /api/v1/config/api-key)`
        : `${key}: campo desconhecido ou não editável`);
      continue;
    }
    const err = check(key, rule, value);
    if (err) { errors.push(err); continue; }
    const parts = key.split(".");
    let node = next as unknown as Record<string, unknown>;
    for (const p of parts.slice(0, -1)) node = node[p] as Record<string, unknown>;
    const last = parts.at(-1)!;
    const current = node[last] ?? null;
    if (JSON.stringify(current) === JSON.stringify(value ?? null)) continue;   // undefined e null são o mesmo "sem valor"
    node[last] = value;
    changed.push(key);
    if (key === "server.port" || key === "agent.port" || key === "engines.preferredBackend") needsRestart.push(key);
  }
  return { config: next, changed, errors, needsRestart };
}
