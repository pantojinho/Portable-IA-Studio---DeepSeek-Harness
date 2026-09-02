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
  /** remote OpenAI-compatible providers; keys live in data/secrets/provider_<id> */
  providers?: Record<string, { baseURL: string; models: string[]; label?: string; headers?: Record<string, string>; enabled?: boolean }>;
}

export const DEFAULT_CONFIG: StudioConfig = {
  server: { host: "127.0.0.1", port: 1420, openBrowser: true, apiKey: null, corsOrigins: [] },
  ui: { language: "pt-BR", theme: "system" },
  engines: { idleUnloadMinutes: 10, preferredBackend: "auto", vramBudgetMiB: "auto" },
  downloads: { parallelFiles: 2, parallelChunks: 4, maxSpeedMiBps: null, hfMirror: null },
  agent: { enabled: true, port: 3080 },
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
