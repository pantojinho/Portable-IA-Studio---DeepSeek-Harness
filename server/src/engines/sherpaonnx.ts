import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import type { Backend } from "../core/system.js";
import { platform } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { EngineAdapter, EngineCapabilities, EngineInstall, EngineInstance, LaunchOptions, RunRequest, RunResult } from "./types.js";
import type { EngineInstaller } from "./installer.js";
import { logger } from "../core/log.js";

const log = logger("sherpa-onnx");

/**
 * AUD-03 + AUD-04. One engine covers Piper (VITS) and Kokoro: sherpa-onnx ships prebuilt CPU binaries
 * for the three OSes and runs ONNX models without Python and without a native npm module.
 * Voice packs are folders under models/tts/ (downloaded and unpacked by MOD-08).
 */
export type VoicePackKind = "vits" | "kokoro" | "matcha";

export interface VoicePack {
  kind: VoicePackKind;
  dir: string;
  model: string;
  tokens: string;
  dataDir?: string;      // espeak-ng-data (phonemes)
  voicesBin?: string;    // kokoro: voices.bin with every speaker embedding
  lexicon?: string;
  dictDir?: string;
  /** speaker names when the pack lists them (kokoro), index = sid */
  speakers?: string[];
}

export class SherpaOnnxAdapter implements EngineAdapter {
  readonly id = "sherpa-onnx" as const;
  readonly capabilities: EngineCapabilities = { kinds: ["tts"], tasks: ["tts"], serverMode: false, concurrentModels: 1 };
  constructor(private ctx: StudioContext, private installer: EngineInstaller) {}

  installed(backend: Backend): EngineInstall | null { return this.installer.installed("sherpa-onnx", backend); }
  install(backend: Backend, job: JobContext): Promise<EngineInstall> { return this.installer.install("sherpa-onnx", backend, job); }

  async launch(opts: LaunchOptions): Promise<EngineInstance> {
    const inst = this.installed("cpu") ?? this.installer.installedAny("sherpa-onnx", opts.backend);
    if (!inst) throw new Error("sherpa-onnx não instalado. Rode: aistudio engines install sherpa-onnx");
    return {
      id: `sherpa-onnx:${opts.model.id}`, engine: "sherpa-onnx", backend: inst.backend, model: opts.model, companions: opts.companions ?? [],
      status: "ready", pid: null, port: null, baseUrl: null, startedAt: Date.now(), lastUsedAt: Date.now(), vramMiB: 0,
      settings: { exe: inst.exe, dir: inst.dir },
    };
  }

  /** `input`: { pack, text, output, speakerId?, speed?, threads? } */
  async run(instance: EngineInstance, req: RunRequest): Promise<RunResult> {
    if (req.task !== "tts") throw new Error(`sherpa-onnx não faz '${req.task}'`);
    const input = req.input as unknown as { pack: VoicePack; text: string; output: string; speakerId?: number; speed?: number; threads?: number };
    instance.lastUsedAt = Date.now();
    return this.synth(String(instance.settings.dir), input, req.signal);
  }

  /**
   * Speak one utterance. Takes the install folder instead of an EngineInstance because a voice is a
   * folder of ONNX files, not a library model — the TTS service (AUD-02) calls this directly.
   */
  async synth(installDir: string, o: { pack: VoicePack; text: string; output: string; speakerId?: number; speed?: number; threads?: number }, signal?: AbortSignal): Promise<RunResult> {
    const { pack, text, output, speakerId, speed, threads } = o;
    if (!text?.trim()) throw new Error("texto vazio");
    fs.mkdirSync(path.dirname(output), { recursive: true });

    const exe = ttsBinary(installDir);
    if (!exe) throw new Error("o pacote do sherpa-onnx não trouxe 'sherpa-onnx-offline-tts'. Reinstale: aistudio engines install sherpa-onnx");
    const args = buildSherpaTtsArgs(pack, { text, output, speakerId, speed, threads: threads ?? Math.max(2, Math.min(4, os.cpus().length)) });
    const t0 = Date.now();
    let stderr = "";
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(exe, args, {
        cwd: pack.dir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, LD_LIBRARY_PATH: `${installDir}${path.delimiter}${path.join(installDir, "lib")}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ""}` },
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => { stderr = (stderr + d).slice(-8000); });
      signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.once("error", reject);
      child.once("exit", (c) => resolve(c ?? -1));
    });
    if (code !== 0 || !fs.existsSync(output)) {
      log.warn(stderr.slice(-500));
      throw new Error(`sherpa-onnx-offline-tts falhou (código ${code}): ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ")}`);
    }
    return { output: { file: output }, files: [output], timings: { totalMs: Date.now() - t0 } };
  }

  async health(): Promise<boolean> { return true; }
  async stop(): Promise<void> { /* modo CLI */ }
  estimateVramMiB(): number | null { return 0; }
}

// -------------------------------------------------------------- pure parts ---

export function ttsBinary(dir: string): string | null {
  const name = platform() === "win" ? "sherpa-onnx-offline-tts.exe" : "sherpa-onnx-offline-tts";
  for (const p of [path.join(dir, name), path.join(dir, "bin", name)]) if (fs.existsSync(p)) return p;
  return null;
}

export interface SherpaTtsOptions { text: string; output: string; speakerId?: number; speed?: number; threads?: number }

/**
 * sherpa-onnx has one flag set per model family; length-scale is the inverse of speed
 * (0.5 = twice as fast). The text goes last, unquoted — spawn passes it as one argv entry.
 */
export function buildSherpaTtsArgs(pack: VoicePack, o: SherpaTtsOptions): string[] {
  const args: string[] = [];
  const lengthScale = o.speed && o.speed > 0 ? Number((1 / o.speed).toFixed(3)) : 1;
  if (pack.kind === "kokoro") {
    args.push(`--kokoro-model=${pack.model}`, `--kokoro-tokens=${pack.tokens}`);
    if (pack.voicesBin) args.push(`--kokoro-voices=${pack.voicesBin}`);
    if (pack.dataDir) args.push(`--kokoro-data-dir=${pack.dataDir}`);
    if (pack.lexicon) args.push(`--kokoro-lexicon=${pack.lexicon}`);
    if (pack.dictDir) args.push(`--kokoro-dict-dir=${pack.dictDir}`);
    if (lengthScale !== 1) args.push(`--kokoro-length-scale=${lengthScale}`);
  } else if (pack.kind === "matcha") {
    args.push(`--matcha-acoustic-model=${pack.model}`, `--matcha-tokens=${pack.tokens}`);
    if (pack.dataDir) args.push(`--matcha-data-dir=${pack.dataDir}`);
    if (lengthScale !== 1) args.push(`--matcha-length-scale=${lengthScale}`);
  } else {
    args.push(`--vits-model=${pack.model}`, `--vits-tokens=${pack.tokens}`);
    if (pack.dataDir) args.push(`--vits-data-dir=${pack.dataDir}`);
    if (pack.lexicon) args.push(`--vits-lexicon=${pack.lexicon}`);
    if (pack.dictDir) args.push(`--vits-dict-dir=${pack.dictDir}`);
    if (lengthScale !== 1) args.push(`--vits-length-scale=${lengthScale}`);
  }
  args.push(`--num-threads=${o.threads ?? 2}`, `--sid=${o.speakerId ?? 0}`, `--output-filename=${o.output}`, o.text);
  return args;
}

/**
 * A voice pack is a folder: what it contains says which family it belongs to. Nothing is inferred
 * from the folder name (AGENTS.md §2.4 — never trust the name).
 */
export function detectVoicePack(dir: string): VoicePack | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  const has = (re: RegExp) => entries.find((e) => re.test(e));
  const onnx = entries.filter((e) => /\.onnx$/i.test(e));
  if (!onnx.length) return null;
  const tokens = has(/^tokens\.txt$/i);
  if (!tokens) return null;
  const dataDir = has(/^espeak-ng-data$/i);
  const lexicon = entries.filter((e) => /^lexicon.*\.txt$/i.test(e)).map((e) => path.join(dir, e)).join(",") || undefined;
  const dictDir = has(/^dict$/i);
  const voicesBin = has(/^voices\.bin$/i);
  const pick = (re: RegExp) => onnx.find((e) => re.test(e));
  const base: Omit<VoicePack, "kind" | "model"> = {
    dir, tokens: path.join(dir, tokens),
    ...(dataDir ? { dataDir: path.join(dir, dataDir) } : {}),
    ...(lexicon ? { lexicon } : {}),
    ...(dictDir ? { dictDir: path.join(dir, dictDir) } : {}),
  };
  if (voicesBin) {
    const model = pick(/kokoro|model/i) ?? onnx[0]!;
    return { ...base, kind: "kokoro", model: path.join(dir, model), voicesBin: path.join(dir, voicesBin), speakers: readSpeakers(dir) };
  }
  const matcha = pick(/^model-steps|matcha/i);
  if (matcha) return { ...base, kind: "matcha", model: path.join(dir, matcha) };
  return { ...base, kind: "vits", model: path.join(dir, pick(/vits|model/i) ?? onnx[0]!), speakers: readSpeakers(dir) };
}

/** Kokoro packs list their speakers in a side file; without it the caller picks the id by number. */
function readSpeakers(dir: string): string[] | undefined {
  for (const name of ["voices.txt", "speakers.txt", "voice-names.txt", "speakers.json", "voices.json"]) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf8");
      if (name.endsWith(".json")) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
        if (parsed && typeof parsed === "object") return Object.keys(parsed as Record<string, unknown>);
        continue;
      }
      const names = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (names.length) return names;
    } catch { /* arquivo estranho: ignora */ }
  }
  return undefined;
}
