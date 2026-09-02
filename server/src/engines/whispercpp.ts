import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import type { Backend } from "../core/system.js";
import type { JobContext } from "../core/jobs.js";
import type { EngineAdapter, EngineCapabilities, EngineInstall, EngineInstance, LaunchOptions, RunRequest, RunResult } from "./types.js";
import type { EngineInstaller } from "./installer.js";
import type { Transcript, TranscriptSegment } from "../audio/types.js";
import { Ffmpeg } from "../audio/ffmpeg.js";
import { logger } from "../core/log.js";

const log = logger("whispercpp");

/**
 * AUD-01. whisper-cli in CLI mode (one process per job): any input format (ffmpeg converts to the
 * 16 kHz mono WAV whisper requires), segment or word timestamps, translation, and speaker turns with
 * a tinydiarize model (`-tdrz`). Reuse: ULS serve.cjs L6149 (download) and SpeechTranscriber.jsx (flags).
 */
export interface SttInput {
  file: string;
  language?: string;
  translateToEnglish?: boolean;
  timestamps?: "none" | "segment" | "word";
  diarize?: boolean;
  prompt?: string;
  threads?: number;
  /** offset applied to every timestamp — meetings transcribe 20 s windows and stitch them */
  offsetSec?: number;
}

export class WhisperCppAdapter implements EngineAdapter {
  readonly id = "whispercpp" as const;
  readonly capabilities: EngineCapabilities = { kinds: ["speech"], tasks: ["stt"], serverMode: false, concurrentModels: 1 };
  constructor(private ctx: StudioContext, private installer: EngineInstaller) {}

  installed(backend: Backend): EngineInstall | null { return this.installer.installed("whispercpp", backend); }
  install(backend: Backend, job: JobContext): Promise<EngineInstall> { return this.installer.install("whispercpp", backend, job); }

  async launch(opts: LaunchOptions): Promise<EngineInstance> {
    const inst = this.installed(opts.backend) ?? this.installer.installedAny("whispercpp", opts.backend);
    if (!inst) throw new Error("whisper.cpp não instalado. Rode: aistudio engines install whispercpp");
    return {
      id: `whispercpp:${opts.model.id}`, engine: "whispercpp", backend: inst.backend, model: opts.model, companions: [],
      status: "ready", pid: null, port: null, baseUrl: null, startedAt: Date.now(), lastUsedAt: Date.now(),
      vramMiB: this.estimateVramMiB(opts), settings: { exe: inst.exe },
    };
  }

  async run(instance: EngineInstance, req: RunRequest): Promise<RunResult> {
    if (req.task !== "stt") throw new Error(`whisper.cpp não faz '${req.task}'`);
    const input = req.input as unknown as SttInput;
    if (!input.file || !fs.existsSync(input.file)) throw new Error("arquivo de áudio não encontrado");
    instance.lastUsedAt = Date.now();

    // whisper only reads 16 kHz mono PCM; everything else goes through ffmpeg first (AUD-07).
    const ffmpeg = new Ffmpeg(this.ctx);
    let wav = input.file;
    let temporary = false;
    if (!isWav16kMono(input.file)) {
      wav = path.join(this.ctx.paths.cache, "stt", `${Date.now()}-${path.basename(input.file, path.extname(input.file))}.wav`);
      try {
        await ffmpeg.toWav16k(input.file, wav, req.signal);
        temporary = true;
      } catch (e) {
        throw new Error(`não consegui converter o áudio para WAV 16 kHz: ${(e as Error).message}. Instale o ffmpeg com "aistudio engines install ffmpeg".`);
      }
    }

    const model = instance.model!;
    const wantsWords = input.timestamps === "word";
    const canDiarize = /tdrz|diarize/i.test(model.filename);
    if (input.diarize && !canDiarize) log.warn(`o modelo ${model.filename} não é tinydiarize; a transcrição sai sem falantes. Baixe recipe:whisper-small-tdrz.`);
    const outBase = path.join(this.ctx.paths.cache, "stt", `${path.basename(wav, ".wav")}-${Date.now()}`);
    fs.mkdirSync(path.dirname(outBase), { recursive: true });

    const args = buildWhisperArgs({
      model: model.path, wav, outBase,
      language: input.language, translate: input.translateToEnglish, words: wantsWords,
      diarize: Boolean(input.diarize) && canDiarize, prompt: input.prompt,
      threads: input.threads ?? Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2))),
    });

    const exe = String(instance.settings.exe);
    let stderr = "";
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => {
        stderr = (stderr + d).slice(-16000);
        const pct = /progress\s*=\s*(\d+)%/.exec(d);
        if (pct && req.job) req.job.setProgress(Number(pct[1]) / 100, `transcrevendo ${Number(pct[1])}%`);
      });
      req.signal?.addEventListener("abort", () => child.kill(), { once: true });
      child.once("error", reject);
      child.once("exit", (c) => resolve(c ?? -1));
    });

    try { fs.appendFileSync(path.join(this.ctx.paths.logs, "whispercpp.log"), `\n---- ${new Date().toISOString()}\n${stderr}`); } catch { /* log é best-effort */ }

    const jsonPath = `${outBase}.json`;
    try {
      if (code !== 0 || !fs.existsSync(jsonPath)) {
        throw new Error(`whisper-cli terminou com código ${code}. Veja data/logs/whispercpp.log. ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ")}`);
      }
      const transcript = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"), {
        language: input.language, diarize: Boolean(input.diarize) && canDiarize, offsetSec: input.offsetSec ?? 0,
      });
      return { output: transcript as unknown as Record<string, unknown> };
    } finally {
      for (const f of [jsonPath, temporary ? wav : null]) if (f) { try { fs.unlinkSync(f); } catch { /* já sumiu */ } }
    }
  }

  async health(): Promise<boolean> { return true; }
  async stop(): Promise<void> { /* modo CLI: nada vive entre chamadas */ }
  estimateVramMiB(opts: LaunchOptions): number | null {
    return opts.backend === "cpu" ? 0 : Math.round((opts.model.sizeBytes / 1048576) * 1.2 + 200);
  }
}

// -------------------------------------------------------------- pure parts ---

export interface WhisperArgsSpec {
  model: string; wav: string; outBase: string;
  language?: string; translate?: boolean; words?: boolean; diarize?: boolean; prompt?: string; threads?: number;
}

export function buildWhisperArgs(s: WhisperArgsSpec): string[] {
  const args = ["-m", s.model, "-f", s.wav, "-of", s.outBase, "-l", s.language && s.language !== "auto" ? s.language : "auto",
    "-t", String(s.threads ?? 4), "-pp", "-np"];
  args.push(s.words ? "-ojf" : "-oj");   // -ojf traz os tokens (timestamps por palavra)
  if (s.translate) args.push("-tr");
  if (s.diarize) args.push("-tdrz");
  if (s.prompt) args.push("--prompt", s.prompt);
  return args;
}

interface WhisperToken { text: string; offsets?: { from: number; to: number }; p?: number }
interface WhisperSegment { offsets: { from: number; to: number }; text: string; speaker_turn_next?: boolean; tokens?: WhisperToken[] }
interface WhisperJson { result?: { language?: string }; transcription?: WhisperSegment[] }

/**
 * whisper-cli JSON → the Transcript contract. With `-tdrz` each segment can end a speaker turn
 * (flag or the literal "[SPEAKER_TURN]" marker), which is what turns a recording into a dialogue.
 */
export function parseWhisperJson(raw: string, opts: { language?: string; diarize?: boolean; offsetSec?: number } = {}): Transcript {
  const data = JSON.parse(raw) as WhisperJson;
  const off = opts.offsetSec ?? 0;
  let speaker = 1;
  const segments: TranscriptSegment[] = [];
  for (const s of data.transcription ?? []) {
    const turnEnds = Boolean(s.speaker_turn_next) || /\[SPEAKER_TURN\]\s*$/.test(s.text);
    const text = s.text.replace(/\[SPEAKER_TURN\]/g, "").trim();
    if (text) {
      const seg: TranscriptSegment = { start: s.offsets.from / 1000 + off, end: s.offsets.to / 1000 + off, text };
      if (opts.diarize) seg.speaker = `Falante ${speaker}`;
      const conf = averageConfidence(s.tokens);
      if (conf !== null) seg.confidence = conf;
      if (s.tokens?.length) {
        const words = s.tokens
          .filter((t) => t.offsets && t.text.trim() && !/^\[.*\]$/.test(t.text.trim()))
          .map((t) => ({ word: t.text.trim(), start: t.offsets!.from / 1000 + off, end: t.offsets!.to / 1000 + off }));
        if (words.length) seg.words = words;
      }
      segments.push(seg);
    }
    if (turnEnds) speaker++;
  }
  return {
    language: data.result?.language ?? opts.language ?? "auto",
    duration: segments.at(-1)?.end ?? 0,
    segments,
    text: segments.map((s) => s.text).join(" ").trim(),
  };
}

function averageConfidence(tokens?: WhisperToken[]): number | null {
  const ps = (tokens ?? []).map((t) => t.p).filter((p): p is number => typeof p === "number");
  if (!ps.length) return null;
  return Math.round((ps.reduce((a, b) => a + b, 0) / ps.length) * 1000) / 1000;
}

/** Cheap header check: RIFF/WAVE, PCM, 1 channel, 16000 Hz — exactly what whisper.cpp accepts. */
export function isWav16kMono(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(44);
    if (fs.readSync(fd, b, 0, 44, 0) < 44) return false;
    if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return false;
    return b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000;
  } catch { return false; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* */ } }
}

/** Meetings and the API export the same three text formats. */
export function toSrt(t: Transcript): string {
  return t.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.speaker ? `${s.speaker}: ` : ""}${s.text}\n`).join("\n");
}
export function toVtt(t: Transcript): string {
  return `WEBVTT\n\n${t.segments.map((s) => `${srtTime(s.start).replace(",", ".")} --> ${srtTime(s.end).replace(",", ".")}\n${s.speaker ? `${s.speaker}: ` : ""}${s.text}\n`).join("\n")}`;
}
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}
