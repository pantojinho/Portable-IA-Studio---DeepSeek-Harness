import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import type { Voice } from "./types.js";
import { Ffmpeg } from "./ffmpeg.js";
import { SherpaOnnxAdapter } from "../engines/sherpaonnx.js";
import { OuteTtsAdapter } from "../engines/outetts.js";
import { logger } from "../core/log.js";

const log = logger("tts");

export interface SpeakRequest {
  text: string;
  voice?: string;
  format?: "wav" | "mp3" | "ogg" | "flac";
  speed?: number;
  language?: string;
  signal?: AbortSignal;
}

export interface SpeakResult { file: string; format: string; voice: Voice; ms: number }

/**
 * AUD-02. Everything that speaks goes through here: the caller names a voice, the service finds the
 * engine behind it (sherpa-onnx for Piper/Kokoro, llama.cpp for OuteTTS, a Python venv for the
 * cloning models) and returns a file under data/outputs/speech/.
 */
export class TtsService {
  private sherpa: SherpaOnnxAdapter;
  private oute: OuteTtsAdapter;

  constructor(private ctx: StudioContext) {
    this.sherpa = new SherpaOnnxAdapter(ctx, ctx.engines.installer);
    this.oute = new OuteTtsAdapter(ctx, ctx.engines.installer);
  }

  async speak(req: SpeakRequest): Promise<SpeakResult> {
    const text = (req.text ?? "").trim();
    if (!text) throw new Error("texto vazio");
    if (text.length > 20000) throw new Error("texto muito longo (máximo 20.000 caracteres por chamada)");

    const voice = req.voice ? this.ctx.voices.get(req.voice) : this.ctx.voices.defaultFor(req.language ?? this.ctx.config.ui.language);
    if (!voice) {
      throw new Error(req.voice
        ? `voz '${req.voice}' não encontrada. Veja GET /api/v1/voices.`
        : "nenhuma voz instalada. Baixe uma com: aistudio models pull recipe:piper-pt-br-faber");
    }

    const t0 = Date.now();
    const outDir = path.join(this.ctx.paths.outputs, "speech");
    fs.mkdirSync(outDir, { recursive: true });
    const stem = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    const wav = `${stem}.wav`;

    const chunks = splitForTts(text, 600);
    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const target = chunks.length === 1 ? wav : `${stem}-p${i}.wav`;
      await this.synthOne(voice, chunks[i]!, target, req);
      parts.push(target);
    }
    if (parts.length > 1) {
      await new Ffmpeg(this.ctx).concatWavs(parts, wav, req.signal);
      for (const p of parts) { try { fs.unlinkSync(p); } catch { /* já removido */ } }
    }

    const format = req.format ?? "wav";
    let file = wav;
    if (format !== "wav") {
      file = `${stem}.${format}`;
      await new Ffmpeg(this.ctx).encode(wav, file, format, req.signal);
      try { fs.unlinkSync(wav); } catch { /* mantém o wav se o SO travar */ }
    }
    const ms = Date.now() - t0;
    log.info(`${voice.id}: ${text.length} caracteres em ${ms} ms → ${path.basename(file)}`);
    // metadata next to the audio, same shape the gallery uses for images (ENG-10)
    fs.writeFileSync(`${file}.json`, JSON.stringify({ kind: "speech", voice: voice.id, engine: voice.engine, text, format, ms, createdAt: new Date().toISOString() }, null, 2));
    return { file, format, voice, ms };
  }

  private async synthOne(voice: Voice, text: string, output: string, req: SpeakRequest): Promise<void> {
    switch (voice.engine) {
      case "piper": case "kokoro": {
        const pack = this.ctx.voices.pack(voice);
        if (!pack) throw new Error(`a voz '${voice.id}' não aponta para um pacote válido em models/tts/`);
        const install = await this.ctx.engines.ensureInstalled("sherpa-onnx", "cpu");
        await this.sherpa.synth(install.dir, {
          pack, text, output,
          speakerId: Number(voice.params?.speakerId ?? 0),
          speed: req.speed ?? Number(voice.params?.speed ?? 1),
        }, req.signal);
        return;
      }
      case "outetts": {
        const model = this.findModel(voice.models[0], "o modelo OuteTTS");
        const vocoder = this.findModel(voice.models[1] ?? "wavtokenizer", "o decodificador WavTokenizer");
        await this.oute.synth({ model, vocoder, text, output, speakerProfile: voice.sample, signal: req.signal });
        return;
      }
      default: {
        // AUD-06: Chatterbox, XTTS-v2 and F5-TTS run in a Python venv managed by the Studio
        const result = await this.ctx.python.tts(voice.engine, {
          text, output, refWav: voice.sample ? path.join(this.ctx.paths.voices, voice.id, path.basename(voice.sample)) : undefined,
          language: voice.language, speed: req.speed, params: voice.params ?? {},
        }, req.signal);
        if (result !== output && fs.existsSync(result)) fs.renameSync(result, output);
      }
    }
  }

  private findModel(ref: string | undefined, what: string) {
    if (!ref) throw new Error(`${what} não foi informado na voz`);
    const found = this.ctx.engines.findModel(ref, ["tts", "text"]);
    if (!found) throw new Error(`${what} ('${ref}') não está na biblioteca. Baixe com: aistudio models pull ${ref}`);
    return found.model;
  }
}

/**
 * TTS engines degrade on very long inputs (and a crash loses everything). Split on sentence
 * boundaries, never mid-word, and keep chunks close to `maxChars`.
 */
export function splitForTts(text: string, maxChars = 600): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return [clean];
  const sentences = clean.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [clean];
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      for (const piece of hardWrap(s, maxChars)) out.push(piece);
      continue;
    }
    if ((cur ? cur.length + 1 : 0) + s.length > maxChars) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

function hardWrap(s: string, maxChars: number): string[] {
  const words = s.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur ? cur.length + 1 : 0) + w.length > maxChars && cur) { out.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}
