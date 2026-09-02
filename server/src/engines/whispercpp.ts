import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import type { Backend } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { EngineAdapter, EngineCapabilities, EngineInstall, EngineInstance, LaunchOptions, RunRequest, RunResult } from "./types.js";
import type { EngineInstaller } from "./installer.js";
import type { Transcript, TranscriptSegment } from "../audio/types.js";

/**
 * AUD-01 (minimal, cli mode). whisper-cli reads 16 kHz mono WAV; other formats need ffmpeg (AUD-07).
 * Output: JSON (-oj) parsed into the Transcript contract. Diarization/streaming come with AUD-01 full.
 */
export class WhisperCppAdapter implements EngineAdapter {
  readonly id = "whispercpp" as const;
  readonly capabilities: EngineCapabilities = { kinds: ["speech"], tasks: ["stt"], serverMode: false, concurrentModels: 1 };
  constructor(private ctx: StudioContext, private installer: EngineInstaller) {}

  installed(backend: Backend): EngineInstall | null { return this.installer.installed("whispercpp", backend); }
  install(backend: Backend, job: JobContext): Promise<EngineInstall> { return this.installer.install("whispercpp", backend, job); }

  async launch(opts: LaunchOptions): Promise<EngineInstance> {
    const inst = this.installed(opts.backend) ?? this.installer.installedAny("whispercpp", opts.backend);
    if (!inst) throw new Error("whisper.cpp não instalado. Rode: aistudio engines install whispercpp");
    return { id: `whispercpp:${opts.model.id}`, engine: "whispercpp", backend: inst.backend, model: opts.model, companions: [], status: "ready", pid: null, port: null, baseUrl: null, startedAt: Date.now(), lastUsedAt: Date.now(), vramMiB: 0, settings: { exe: inst.exe } };
  }

  async run(instance: EngineInstance, req: RunRequest): Promise<RunResult> {
    const { file, language, translateToEnglish, timestamps } = req.input as { file: string; language?: string; translateToEnglish?: boolean; timestamps?: string };
    if (!file || !fs.existsSync(file)) throw new Error("arquivo de áudio não encontrado");
    const outBase = path.join(this.ctx.paths.cache, "stt", path.basename(file, path.extname(file)) + "-" + Date.now());
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    const args = ["-m", instance.model!.path, "-f", file, "-oj", "-of", outBase, "-l", language && language !== "auto" ? language : "auto", "-t", "8", "-np"];
    if (translateToEnglish) args.push("-tr");
    if (timestamps === "word") args.push("-ml", "1");
    const logFile = fs.openSync(path.join(this.ctx.paths.logs, "whispercpp.log"), "a");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(String(instance.settings.exe), args, { cwd: path.dirname(String(instance.settings.exe)), stdio: ["ignore", logFile, logFile], windowsHide: true });
      req.signal?.addEventListener("abort", () => child.kill());
      child.once("error", reject); child.once("exit", (c) => resolve(c ?? -1));
    });
    fs.closeSync(logFile);
    const jsonPath = outBase + ".json";
    if (code !== 0 || !fs.existsSync(jsonPath)) throw new Error(`whisper-cli terminou com código ${code}. O arquivo precisa ser WAV 16 kHz mono até o ffmpeg chegar (AUD-07). Veja data/logs/whispercpp.log`);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { result?: { language?: string }; transcription?: { timestamps: { from: string; to: string }; offsets: { from: number; to: number }; text: string }[] };
    fs.unlinkSync(jsonPath);
    const segments: TranscriptSegment[] = (raw.transcription ?? []).map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() })).filter((s) => s.text);
    const t: Transcript = { language: raw.result?.language ?? language ?? "auto", duration: segments.at(-1)?.end ?? 0, segments, text: segments.map((s) => s.text).join(" ") };
    return { output: t as unknown as Record<string, unknown> };
  }
  async health(): Promise<boolean> { return true; }
  async stop(): Promise<void> { /* cli */ }
  estimateVramMiB(): number | null { return 0; }
}
