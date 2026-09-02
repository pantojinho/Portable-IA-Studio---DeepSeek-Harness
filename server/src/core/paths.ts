import path from "node:path";
import fs from "node:fs";

/**
 * Every path the Studio touches is derived from ONE root: the folder that
 * contains the launchers. Copying that folder copies the whole installation.
 * `--data-dir` (or AISTUDIO_DATA) moves only the mutable state.
 */
export interface Paths {
  root: string;
  dist: string;
  web: string;
  runtime: string;
  engines: string;
  models: string;
  recipes: string;
  projects: string;
  voices: string;
  data: string;
  config: string;
  logs: string;
  outputs: string;
  recordings: string;
  secrets: string;
  cache: string;
  agent: string;
}

export function detectRoot(): string {
  if (process.env.AISTUDIO_ROOT) return path.resolve(process.env.AISTUDIO_ROOT);
  // dist/server.cjs  →  root
  const here = path.dirname(process.argv[1] ?? process.cwd());
  if (path.basename(here) === "dist") return path.resolve(here, "..");
  // running from source via tsx: server/src/cli.ts → root
  if (here.replace(/\\/g, "/").endsWith("server/src")) return path.resolve(here, "../..");
  return path.resolve(here);
}

export function resolvePaths(opts: { root?: string; dataDir?: string } = {}): Paths {
  const root = path.resolve(opts.root ?? detectRoot());
  const data = path.resolve(opts.dataDir ?? process.env.AISTUDIO_DATA ?? path.join(root, "data"));
  const p: Paths = {
    root,
    dist: path.join(root, "dist"),
    web: path.join(root, "web", "dist"),
    runtime: path.join(root, "runtime"),
    engines: path.join(root, "engines"),
    models: path.join(root, "models"),
    recipes: path.join(root, "models", "recipes"),
    projects: path.join(root, "projects"),
    voices: path.join(root, "voices"),
    data,
    config: path.join(data, "config.yaml"),
    logs: path.join(data, "logs"),
    outputs: path.join(data, "outputs"),
    recordings: path.join(data, "recordings"),
    secrets: path.join(data, "secrets"),
    cache: path.join(data, "cache"),
    agent: path.join(root, "agent"),
  };
  return p;
}

export const MODEL_KINDS = [
  "text", "image", "video", "speech", "tts", "music", "ocr", "embeddings", "rerank", "vision",
] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export function ensureLayout(p: Paths): void {
  const dirs = [
    p.runtime, p.engines, p.models, p.recipes, p.projects, p.voices, p.data, p.logs, p.outputs,
    p.recordings, p.secrets, p.cache, p.agent,
    ...MODEL_KINDS.map((k) => path.join(p.models, k)),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  try { fs.chmodSync(p.secrets, 0o700); } catch { /* windows */ }
}
