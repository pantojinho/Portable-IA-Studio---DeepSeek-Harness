import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import type { Backend } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { EngineAdapter, EngineCapabilities, EngineInstall, EngineInstance, LaunchOptions, RunRequest, RunResult } from "./types.js";
import type { EngineInstaller } from "./installer.js";
import type { ModelRecord } from "../models/types.js";
import { logger } from "../core/log.js";

const log = logger("sdcpp");

/**
 * ENG-05 + ENG-05b. stable-diffusion.cpp `sd-cli`: one process per generation, PNG + params JSON in
 * data/outputs. Model files come from the library; multi-file models (Flux, SD3.5, Z-Image, Wan)
 * use the recipe's engineArgs.sdcpp with {slot} placeholders filled from sidecars.
 * Covers txt2img, img2img, inpaint, upscale (ESRGAN) and video (vid_gen, VID-01); LoRAs are picked
 * with `<lora:nome:peso>` inside the prompt, which is sd.cpp's own syntax.
 */
export interface ImageParams {
  prompt: string;
  negative?: string;
  width?: number; height?: number;
  steps?: number; cfg?: number; seed?: number;
  sampler?: string;              // euler_a, euler, dpm++2m, …
  n?: number;                    // batch count
  initImage?: string; strength?: number;   // img2img
  mask?: string;                 // inpaint
  lora?: { path: string; weight?: number }[];
  /** upscale: ESRGAN model id/path and factor */
  upscaleModel?: string;
  upscaleRepeats?: number;
  /** video (VID-01) */
  frames?: number;
  fps?: number;
  /** which operation to run; inferred from initImage/mask when absent */
  task?: "txt2img" | "img2img" | "inpaint" | "upscale" | "txt2vid" | "img2vid";
  extra?: string[];
}

export class SdCppAdapter implements EngineAdapter {
  readonly id = "sdcpp" as const;
  readonly capabilities: EngineCapabilities = { kinds: ["image", "video"], tasks: ["txt2img", "img2img", "inpaint", "upscale", "txt2vid", "img2vid"], serverMode: false, concurrentModels: 1 };

  constructor(private ctx: StudioContext, private installer: EngineInstaller) {}

  installed(backend: Backend): EngineInstall | null { return this.installer.installed("sdcpp", backend); }
  install(backend: Backend, job: JobContext): Promise<EngineInstall> { return this.installer.install("sdcpp", backend, job); }

  async launch(opts: LaunchOptions): Promise<EngineInstance> {
    const inst = this.installed(opts.backend) ?? this.installer.installedAny("sdcpp", opts.backend);
    if (!inst) throw new Error("stable-diffusion.cpp não instalado. Rode: aistudio engines install sdcpp");
    // cli mode: nothing to keep alive; the "instance" only records which files and backend to use
    return { id: `sdcpp:${opts.model.id}`, engine: "sdcpp", backend: inst.backend, model: opts.model, companions: opts.companions ?? [], status: "ready", pid: null, port: null, baseUrl: null, startedAt: Date.now(), lastUsedAt: Date.now(), vramMiB: 0, settings: { exe: inst.exe, recipeArgs: opts.recipeArgs ?? null } };
  }

  /** Build the model part of the command line: single checkpoint (-m) or recipe slots. */
  modelArgs(model: ModelRecord, companions: ModelRecord[], recipeArgs: string[] | null): string[] {
    if (recipeArgs?.length) {
      const bySlot: Record<string, string> = {};
      const all = [model, ...companions];
      const pick = (role: string, extra?: RegExp) => all.find((m) => m.inspection.role === role && (!extra || extra.test(m.filename)))?.path;
      bySlot.model = bySlot.diffusion = pick("diffusion") ?? pick("main") ?? model.path;
      bySlot.vae = pick("vae") ?? "";
      bySlot.clip_l = pick("text_encoder", /clip_l/i) ?? ""; bySlot.clip_g = pick("text_encoder", /clip_g/i) ?? "";
      bySlot.t5xxl = pick("text_encoder", /t5|umt5/i) ?? ""; bySlot.llm = all.find((m) => m.kind === "text" || /qwen|mistral/i.test(m.filename))?.path ?? pick("text_encoder", /qwen|mistral/i) ?? "";
      const out: string[] = [];
      for (let i = 0; i < recipeArgs.length; i++) {
        const a = recipeArgs[i]!;
        const m = a.match(/^\{(\w+)\}$/);
        if (m) { const v = bySlot[m[1]!]; if (!v) { out.pop(); continue; } out.push(v); } else out.push(a);
      }
      return out;
    }
    const args = model.inspection.role === "main" ? ["-m", model.path] : ["--diffusion-model", model.path];
    const vae = companions.find((c) => c.inspection.role === "vae"); if (vae) args.push("--vae", vae.path);
    return args;
  }

  async run(instance: EngineInstance, req: RunRequest): Promise<RunResult> {
    const p = req.input as unknown as ImageParams;
    // upscale não descreve nada: só amplia a imagem que veio
    if (!p.prompt && req.task !== "upscale") throw new Error("prompt é obrigatório");
    const exe = String(instance.settings.exe);
    const outDir = path.join(this.ctx.paths.outputs, "images");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const seed = p.seed ?? Math.floor(Math.random() * 2 ** 31);
    const base = path.join(outDir, `${stamp}-${seed}`);
    const recipeArgs = (instance.settings.recipeArgs as string[] | null) ?? null;
    const args = ["-M", req.task === "img2img" || req.task === "inpaint" ? "img_gen" : req.task === "upscale" ? "upscale" : req.task === "txt2vid" || req.task === "img2vid" ? "vid_gen" : "img_gen",
      ...this.modelArgs(instance.model!, instance.companions, recipeArgs),
      ...(p.prompt ? ["-p", p.prompt] : []), "-o", `${base}.png`, "--seed", String(seed), "-v"];
    if (p.negative) args.push("-n", p.negative);
    if (p.width) args.push("-W", String(p.width)); if (p.height) args.push("-H", String(p.height));
    if (p.steps) args.push("--steps", String(p.steps)); if (p.cfg != null) args.push("--cfg-scale", String(p.cfg));
    if (p.sampler) args.push("--sampling-method", p.sampler);
    if (p.n && p.n > 1) args.push("-b", String(p.n));
    if (p.initImage) { args.push("-i", p.initImage); if (p.strength != null) args.push("--strength", String(p.strength)); }
    if (p.mask) args.push("--mask", p.mask);
    // LoRA: sd.cpp lê "<lora:nome:peso>" do próprio prompt; basta dizer onde estão os arquivos
    const loraDir = p.lora?.length ? path.dirname(p.lora[0]!.path) : this.loraDir();
    if (loraDir) args.push("--lora-model-dir", loraDir);
    if (req.task === "upscale") {
      const upscaler = this.findUpscaler(p.upscaleModel);
      if (!upscaler) throw new Error("nenhum modelo de upscale (ESRGAN) na biblioteca. Baixe um .pth/.gguf de ESRGAN e guarde em models/image/.");
      args.push("--upscale-model", upscaler);
      if (p.upscaleRepeats && p.upscaleRepeats > 1) args.push("--upscale-repeats", String(p.upscaleRepeats));
      if (p.initImage) args.push("-i", p.initImage);
    }
    if (req.task === "txt2vid" || req.task === "img2vid") {
      args.push("--video-frames", String(p.frames ?? 33));
      if (p.fps) args.push("--fps", String(p.fps));
    }
    if (instance.backend !== "cpu" && !args.includes("--offload-to-cpu") && (instance.model?.sizeBytes ?? 0) > 4 * 1024 ** 3) args.push("--offload-to-cpu");
    if (p.extra) args.push(...p.extra);
    // recipe defaults must not override explicit user params: remove duplicates keeping the last occurrence
    const dedup = dedupeFlags(args);

    fs.mkdirSync(this.ctx.paths.logs, { recursive: true });
    const logFile = fs.openSync(path.join(this.ctx.paths.logs, "sdcpp.log"), "a");
    fs.writeSync(logFile, `\n---- ${new Date().toISOString()} ${path.basename(exe)} ${dedup.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n`);
    const t0 = Date.now();
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(exe, dedup, { cwd: path.dirname(exe), stdio: ["ignore", logFile, logFile], windowsHide: true });
      req.signal?.addEventListener("abort", () => child.kill());
      child.once("error", reject); child.once("exit", (c) => resolve(c ?? -1));
    });
    fs.closeSync(logFile);
    const files = fs.readdirSync(outDir).filter((f) => f.startsWith(path.basename(base)) && f.endsWith(".png")).map((f) => path.join(outDir, f)).sort();
    if (code !== 0 || files.length === 0) throw new Error(`sd-cli terminou com código ${code} sem imagem. Veja data/logs/sdcpp.log (memória? modelo? flags?).`);
    const meta = { prompt: p.prompt, negative: p.negative ?? "", width: p.width, height: p.height, steps: p.steps, cfg: p.cfg, seed, sampler: p.sampler, model: instance.model?.id, companions: instance.companions.map((c) => c.id), backend: instance.backend, durationMs: Date.now() - t0, createdAt: new Date().toISOString() };
    fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2));
    log.info(`imagem gerada em ${Math.round(meta.durationMs / 1000)} s: ${files.map((f) => path.basename(f)).join(", ")}`);
    return { output: { ...meta, files }, files, timings: { totalMs: meta.durationMs } };
  }

  async health(): Promise<boolean> { return true; }
  async stop(): Promise<void> { /* cli mode */ }

  /**
   * ENG-03b. Diffusion needs the weights plus room for the latents: about 1.1× the files, plus a
   * margin that grows with the resolution. Reporting 0 (the old behaviour) made the planner think
   * image models were free and let a 6 GB card try to hold an LLM and Flux at the same time.
   */
  estimateVramMiB(opts: LaunchOptions): number | null {
    if (opts.backend === "cpu") return 0;
    const bytes = opts.model.sizeBytes + (opts.companions ?? []).reduce((a, c) => a + c.sizeBytes, 0);
    const weights = (bytes / 1048576) * 1.1;
    const s = (opts.settings ?? {}) as { width?: number; height?: number; frames?: number };
    const pixels = (s.width ?? 1024) * (s.height ?? 1024) * Math.max(1, s.frames ?? 1);
    const latents = (pixels / (1024 * 1024)) * 600;   // ~600 MiB por megapixel de latente + VAE
    return Math.round(weights + latents + 300);
  }

  /** LoRAs live in models/lora/ (or models/image/lora/); sd.cpp needs the folder, not the file. */
  private loraDir(): string | null {
    for (const dir of [path.join(this.ctx.paths.models, "lora"), path.join(this.ctx.paths.models, "image", "lora")]) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /\.(safetensors|ckpt|pt|gguf)$/i.test(f))) return dir;
    }
    return null;
  }

  private findUpscaler(ref?: string): string | null {
    if (ref && fs.existsSync(ref)) return ref;
    const candidates = this.ctx.models.registry.list().filter((m) => m.inspection.role === "upscaler" || /esrgan|upscal/i.test(m.filename));
    if (ref) return candidates.find((m) => m.id === ref || m.filename === ref)?.path ?? null;
    return candidates[0]?.path ?? null;
  }
}

function dedupeFlags(args: string[]): string[] {
  const last = new Map<string, number>();
  for (let i = 0; i < args.length; i++) if (args[i]!.startsWith("-") && !/^-?\d/.test(args[i]!)) last.set(args[i]!, i);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-") && !/^-?\d/.test(a) && last.get(a) !== i) { const next = args[i + 1]; if (next !== undefined && !next.startsWith("-")) i++; continue; }
    out.push(a);
  }
  return out;
}
