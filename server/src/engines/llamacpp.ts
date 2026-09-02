import os from "node:os";
import type { ChildProcess } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import { findFreePort } from "../core/ports.js";
import type { Backend } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { EngineAdapter, EngineCapabilities, EngineInstall, EngineInstance, LaunchOptions, RunRequest, RunResult } from "./types.js";
import type { EngineInstaller } from "./installer.js";
import type { Supervisor } from "./supervisor.js";

/**
 * ENG-04. llama.cpp `llama-server`: chat, completions, embeddings, rerank, vision/OCR (mmproj), OuteTTS later.
 * Args mirror what ULS proved on the owner's machine (serve.cjs L4378 + app/config/llm-model-settings.json):
 * threads, ctx, ngl, KV cache q8_0, flash-attn, batch 512.
 */
export interface LlamaSettings {
  contextSize?: number;      // default 8192
  gpuLayers?: number;        // default 99 (all) on GPU backends, 0 on cpu
  threads?: number;          // default physical cores - 2
  cacheTypeK?: string;       // "q8_0" | "f16"
  cacheTypeV?: string;
  flashAttn?: boolean;       // default true on gpu
  batchSize?: number;        // 512
  ubatchSize?: number;       // 512
  jinja?: boolean;           // default true (tool calling / chat templates)
  parallel?: number;         // slots, default 1
  extraArgs?: string[];
}

export class LlamaCppAdapter implements EngineAdapter {
  readonly id = "llamacpp" as const;
  readonly capabilities: EngineCapabilities = { kinds: ["text", "ocr", "embeddings", "rerank", "vision"], tasks: ["chat", "completion", "embeddings", "rerank", "vision", "ocr"], serverMode: true, concurrentModels: 1 };
  private children = new Map<string, ChildProcess>();

  constructor(private ctx: StudioContext, private installer: EngineInstaller, private sup: () => Supervisor) {}

  installed(backend: Backend): EngineInstall | null { return this.installer.installed("llamacpp", backend); }
  install(backend: Backend, job: JobContext): Promise<EngineInstall> { return this.installer.install("llamacpp", backend, job); }

  buildArgs(opts: LaunchOptions, port: number): string[] {
    const s = (opts.settings ?? {}) as LlamaSettings;
    const gpu = opts.backend !== "cpu";
    const kind = opts.model.kind;
    const args = ["-m", opts.model.path, "--host", "127.0.0.1", "--port", String(port), "--no-webui", "--alias", opts.model.id,
      "-c", String(s.contextSize ?? (kind === "embeddings" || kind === "rerank" ? 8192 : 8192)),
      "-ngl", String(s.gpuLayers ?? (gpu ? 99 : 0)),
      "-t", String(s.threads ?? Math.max(2, Math.min(16, Math.floor(os.cpus().length / 2)))),
      "-b", String(s.batchSize ?? 512), "-ub", String(s.ubatchSize ?? (kind === "embeddings" ? 8192 : 512)),
      "-np", String(s.parallel ?? 1)];
    if (s.flashAttn ?? gpu) args.push("-fa", "on");
    if (gpu && (s.cacheTypeK ?? "q8_0") !== "f16") args.push("-ctk", s.cacheTypeK ?? "q8_0", "-ctv", s.cacheTypeV ?? s.cacheTypeK ?? "q8_0");
    if (kind === "embeddings") args.push("--embedding", "--pooling", String((opts.settings as { pooling?: string } | undefined)?.pooling ?? (/bge|e5|gte/i.test(opts.model.filename) ? "cls" : "last")));
    else if (kind === "rerank") args.push("--reranking");
    else if (s.jinja ?? true) args.push("--jinja");
    const mmproj = (opts.companions ?? []).find((c) => c.inspection.role === "mmproj");
    if (mmproj) args.push("--mmproj", mmproj.path);
    if (opts.recipeArgs?.length) {
      // recipe args (e.g. GLM-OCR: -c 12000 --flash-attn off) override defaults: append, llama.cpp takes the last value
      args.push(...opts.recipeArgs.filter((a) => a !== "-m" && !a.startsWith("--mmproj")));
    }
    if (s.extraArgs?.length) args.push(...s.extraArgs);
    return args;
  }

  async launch(opts: LaunchOptions): Promise<EngineInstance> {
    const inst = this.installed(opts.backend) ?? this.installer.installedAny("llamacpp", opts.backend);
    if (!inst) throw new Error(`llama.cpp não instalado para ${opts.backend}. Rode: aistudio engines install llamacpp`);
    const port = await findFreePort(10086, 28121, 28160);
    const args = this.buildArgs({ ...opts, backend: inst.backend }, port);
    const instance: EngineInstance = {
      id: `llamacpp:${opts.model.id}`, engine: "llamacpp", backend: inst.backend, model: opts.model, companions: opts.companions ?? [],
      status: "starting", pid: null, port, baseUrl: `http://127.0.0.1:${port}`, startedAt: Date.now(), lastUsedAt: Date.now(),
      vramMiB: this.estimateVramMiB({ ...opts, backend: inst.backend }), settings: { ...(opts.settings ?? {}), args },
    };
    const sup = this.sup();
    sup.publish(instance);
    const child = sup.spawnLogged(`llamacpp-${port}`, inst.exe, args);
    instance.pid = child.pid ?? null;
    this.children.set(instance.id, child);
    try {
      await sup.waitHealthy(child, `${instance.baseUrl}/health`, 180_000, opts.signal);
    } catch (e) {
      instance.status = "error"; instance.error = (e as Error).message; sup.publish(instance);
      this.children.delete(instance.id);
      throw e;
    }
    instance.status = "ready";
    return instance;
  }

  async run(instance: EngineInstance, req: RunRequest): Promise<RunResult> {
    instance.lastUsedAt = Date.now();
    const post = async (p: string, body: unknown) => {
      const r = await fetch(`${instance.baseUrl}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: req.signal });
      if (!r.ok) throw new Error(`llama-server ${p} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      return r.json() as Promise<Record<string, unknown>>;
    };
    switch (req.task) {
      case "chat": case "vision": case "ocr": return { output: await post("/v1/chat/completions", { ...req.input, model: instance.model?.id, stream: false }) };
      case "completion": return { output: await post("/v1/completions", { ...req.input, model: instance.model?.id, stream: false }) };
      case "embeddings": return { output: await post("/v1/embeddings", { ...req.input, model: instance.model?.id }) };
      case "rerank": return { output: await post("/v1/rerank", req.input) };
      default: throw new Error(`llama.cpp não faz '${req.task}'`);
    }
  }

  async health(instance: EngineInstance): Promise<boolean> {
    try { const r = await fetch(`${instance.baseUrl}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
  }

  async stop(instance: EngineInstance): Promise<void> {
    await this.sup().kill(this.children.get(instance.id));
    this.children.delete(instance.id);
  }

  estimateVramMiB(opts: LaunchOptions): number | null {
    if (opts.backend === "cpu") return 0;
    const s = (opts.settings ?? {}) as LlamaSettings;
    const weights = (opts.model.sizeBytes + (opts.companions ?? []).reduce((a, c) => a + c.sizeBytes, 0)) / 1048576;
    const ctx = s.contextSize ?? 8192;
    const layers = 32; const kvPerTok = (s.cacheTypeK ?? "q8_0") === "f16" ? 2 : 1;
    const kv = (ctx * layers * 2 * 1024 * kvPerTok) / 1048576; // rough: 1 KiB/token/layer for f16 on ~4B models
    return Math.round(weights * 1.05 + kv + 400);
  }
}
