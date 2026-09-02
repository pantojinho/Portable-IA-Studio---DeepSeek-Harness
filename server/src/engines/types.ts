/**
 * CONTRACT — engines. Every runtime that executes a model (llama.cpp, stable-diffusion.cpp,
 * whisper.cpp, piper/kokoro via onnxruntime, ffmpeg, python venvs, colibri) implements this.
 * Changing this file is a cross-team decision: record it in docs/DECISIONS.md.
 *
 * Task refs: ENG-01 (catalog/installer), ENG-02 (supervisor), ENG-03 (VRAM planner),
 * ENG-04 llamacpp, ENG-05 sdcpp, AUD-01 whispercpp, AUD-03 piper, AUD-04 kokoro, AUD-10 python-venv.
 */
import type { ModelKind } from "../core/paths.js";
import type { Backend, Platform, Arch } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { ModelRecord } from "../models/types.js";

export type EngineId = "llamacpp" | "sdcpp" | "whispercpp" | "piper" | "kokoro" | "ffmpeg" | "python-venv" | "colibri" | (string & {});

export interface EngineCapabilities {
  kinds: ModelKind[];                       // which model kinds it can load
  tasks: EngineTask[];                      // which operations it can perform
  serverMode: boolean;                      // keeps a long-lived process with an HTTP API (llama-server, sd-server)
  concurrentModels: number;                 // how many models one process holds (llama-server: 1; sd-server: 1)
}

export type EngineTask =
  | "chat" | "completion" | "embeddings" | "rerank" | "vision" | "ocr"
  | "txt2img" | "img2img" | "inpaint" | "upscale" | "txt2vid" | "img2vid"
  | "stt" | "tts" | "music" | "capture" | "transcode";

/** One downloadable build of an engine for a platform/backend, from engines/catalog.yaml. */
export interface EngineBuild {
  engine: EngineId;
  version: string;
  platform: Platform;
  arch: Arch;
  backend: Backend;
  url: string;
  sha256?: string;
  sizeBytes?: number;
  /** files to keep from the archive (glob); everything else is dropped to stay light */
  keep?: string[];
  /** relative path of the main executable inside engines/<engine>/<platform>-<arch>/<backend>/ */
  exe: string;
  /** extra runtime archives (e.g. cudart DLLs) */
  requires?: { url: string; sha256?: string; keep?: string[] }[];
}

export interface EngineInstall {
  engine: EngineId;
  backend: Backend;
  version: string;
  dir: string;
  exe: string;
  installedAt: string;
}

export type EngineStatus = "stopped" | "starting" | "ready" | "busy" | "error" | "stopping";

export interface EngineInstance {
  id: string;                               // "<engine>:<model id>"
  engine: EngineId;
  backend: Backend;
  model: ModelRecord | null;
  companions: ModelRecord[];                // mmproj, vae, text encoders, voices…
  status: EngineStatus;
  pid: number | null;
  port: number | null;                      // when serverMode
  baseUrl: string | null;                   // "http://127.0.0.1:<port>"
  startedAt: number | null;
  lastUsedAt: number | null;
  vramMiB: number | null;                   // planner estimate
  error?: string;
  /** engine-specific launch settings that were used (threads, ctx, ngl…) */
  settings: Record<string, unknown>;
}

export interface LaunchOptions {
  model: ModelRecord;
  companions?: ModelRecord[];
  backend: Backend;
  /** engine-specific knobs; llamacpp: { contextSize, gpuLayers, threads, cacheTypeK/V, flashAttn, jinja } */
  settings?: Record<string, unknown>;
  /** recipe engineArgs after placeholder substitution, if the model came from a recipe */
  recipeArgs?: string[];
  signal?: AbortSignal;
}

export interface RunRequest {
  task: EngineTask;
  /** task-specific payload (prompt, image, audio, params…) — see docs/API.md for shapes */
  input: Record<string, unknown>;
  job?: JobContext;
  signal?: AbortSignal;
}

export interface RunResult {
  /** task-specific output; files are written under data/outputs and referenced by path */
  output: Record<string, unknown>;
  files?: string[];
  timings?: Record<string, number>;
}

export interface EngineAdapter {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  /** Is a build for this platform/backend installed? */
  installed(backend: Backend): EngineInstall | null;
  /** Download + unpack the right build (job). Reuse ULS setup logic; verify hash; keep only needed files. */
  install(backend: Backend, job: JobContext): Promise<EngineInstall>;
  /** Start (serverMode) or prepare (cli mode) an instance for a model. Must resolve only when healthy. */
  launch(opts: LaunchOptions): Promise<EngineInstance>;
  /** Execute one task against a running instance. */
  run(instance: EngineInstance, req: RunRequest): Promise<RunResult>;
  /** Cheap liveness probe. */
  health(instance: EngineInstance): Promise<boolean>;
  stop(instance: EngineInstance): Promise<void>;
  /** Estimate accelerator memory for planner (ENG-03); may inspect model headers. */
  estimateVramMiB(opts: LaunchOptions): number | null;
}
