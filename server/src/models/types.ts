import type { ModelKind } from "../core/paths.js";

/** What a file *is*, decided by reading its bytes, never by its name. */
export type FileFormat = "gguf" | "safetensors" | "ggml" | "onnx" | "zip" | "json" | "bin" | "html" | "unknown";

/** Which part of a multi-file model a file plays. */
export type FileRole =
  | "main"           // a self-contained model (LLM gguf, SD1.5 checkpoint, whisper bin…)
  | "mmproj"         // vision/audio projector for llama.cpp
  | "diffusion"      // standalone diffusion transformer/unet
  | "vae"
  | "text_encoder"
  | "lora"
  | "controlnet"
  | "voice"          // TTS voice weights (piper .onnx, kokoro voice .bin)
  | "config"         // .json sidecars (piper voice config, kokoro manifest)
  | "upscaler"
  | "unknown";

export interface Inspection {
  format: FileFormat;
  kind: ModelKind | null;
  role: FileRole;
  arch: string | null;          // e.g. "qwen3", "flux2", "wan", "clip", "whisper"
  name: string | null;          // general.name when the file says so
  quant: string | null;         // "Q4_K_M", "F16", "fp8"…
  params: number | null;        // parameter count when derivable
  contextLength: number | null;
  vision: boolean;              // llama.cpp: file is/needs a projector
  embedding: boolean;           // arch usually used for embeddings/rerank
  notes: string[];
}

export interface ModelRecord {
  id: string;                   // stable: "<kind>/<filename>"
  kind: ModelKind;
  filename: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  inspection: Inspection;
  /** optional sidecar metadata written at download/import time */
  source?: ModelSource;
  /** for multi-file recipes: which recipe and which role in it */
  recipe?: { id: string; role: FileRole };
  /** companion files that must travel together (mmproj, voice config…) */
  companions?: string[];
}

export interface ModelSource {
  ref: string;                  // what the user typed
  repo?: string;                // hf repo id
  revision?: string;
  repoPath?: string;            // path inside the repo
  url: string;
  sha256?: string;
  license?: string;
  gated?: boolean;
  downloadedAt: string;
}

export interface PlannedFile {
  url: string;
  repo?: string;
  repoPath?: string;
  revision?: string;
  filename: string;             // destination file name
  kind: ModelKind;
  subdir?: string;              // optional folder under models/<kind>/
  role: FileRole;
  sizeBytes: number | null;
  sha256: string | null;
  /** true when we only guessed the kind from the name and must confirm by inspecting the bytes */
  tentative: boolean;
}

export interface DownloadPlan {
  ref: string;
  title: string;
  provider: "huggingface" | "civitai" | "url" | "recipe";
  repo?: string;
  revision?: string;
  files: PlannedFile[];
  totalBytes: number | null;
  warnings: string[];
  /** other candidates the user could pick instead (other quants, other files) */
  alternatives?: { label: string; repoPath: string; sizeBytes: number | null }[];
  recipeId?: string;
  license?: string;
  gated?: boolean;
}

export interface HfTreeEntry {
  type: "file" | "directory";
  path: string;
  size?: number;
  oid?: string;
  lfs?: { oid: string; size: number };
}

export interface HfModelInfo {
  id: string;
  sha?: string;
  gated?: boolean | string;
  private?: boolean;
  tags?: string[];
  pipeline_tag?: string;
  downloads?: number;
  likes?: number;
  cardData?: { license?: string; base_model?: string | string[] };
  siblings?: { rfilename: string }[];
}
