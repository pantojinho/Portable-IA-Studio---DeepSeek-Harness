import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import { platform } from "../core/system.js";
import type { EngineInstaller } from "./installer.js";
import type { ModelRecord } from "../models/types.js";
import { logger } from "../core/log.js";

const log = logger("outetts");

/**
 * AUD-05. OuteTTS runs inside llama.cpp: `llama-tts` takes the OuteTTS GGUF plus the WavTokenizer
 * decoder and writes a WAV. Because it is a GGUF it uses the GPU backend already installed for chat,
 * so a light voice clone costs no extra engine (AGENTS.md §2.2 — engines on demand only).
 */
export class OuteTtsAdapter {
  readonly id = "outetts" as const;
  constructor(private ctx: StudioContext, private installer: EngineInstaller) {}

  /** llama-tts lives next to llama-server in the llama.cpp install. */
  binary(): string | null {
    const inst = this.installer.installedAny("llamacpp");
    if (!inst) return null;
    const exe = path.join(inst.dir, platform() === "win" ? "llama-tts.exe" : "llama-tts");
    return fs.existsSync(exe) ? exe : null;
  }

  async synth(o: { model: ModelRecord; vocoder: ModelRecord; text: string; output: string; speakerProfile?: string; threads?: number; signal?: AbortSignal }): Promise<string> {
    const exe = this.binary();
    if (!exe) {
      throw new Error("llama-tts não está na instalação do llama.cpp. Reinstale com: aistudio engines install llamacpp (o catálogo já pede llama-tts).");
    }
    fs.mkdirSync(path.dirname(o.output), { recursive: true });
    const args = buildOuteTtsArgs({ exeDirOutput: o.output, model: o.model.path, vocoder: o.vocoder.path, text: o.text, speakerProfile: o.speakerProfile, threads: o.threads });
    let stderr = "";
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(exe, args, { cwd: path.dirname(o.output), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-8000); });
      o.signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.once("error", reject);
      child.once("exit", (c) => resolve(c ?? -1));
    });
    // llama-tts writes output.wav in the working directory on some builds; accept both.
    const fallback = path.join(path.dirname(o.output), "output.wav");
    if (!fs.existsSync(o.output) && fs.existsSync(fallback)) fs.renameSync(fallback, o.output);
    if (code !== 0 || !fs.existsSync(o.output)) {
      log.warn(stderr.slice(-400));
      throw new Error(`llama-tts falhou (código ${code}): ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ")}`);
    }
    return o.output;
  }
}

export function buildOuteTtsArgs(o: { exeDirOutput: string; model: string; vocoder: string; text: string; speakerProfile?: string; threads?: number }): string[] {
  const args = ["-m", o.model, "-mv", o.vocoder, "-p", o.text, "-o", o.exeDirOutput, "-t", String(o.threads ?? 4), "--no-warmup"];
  if (o.speakerProfile) args.push("-sf", o.speakerProfile); // perfil de voz (clonagem leve)
  return args;
}
