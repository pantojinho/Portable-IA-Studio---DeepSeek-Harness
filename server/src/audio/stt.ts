import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import type { Transcript } from "./types.js";
import type { SttInput } from "../engines/whispercpp.js";

export interface TranscribeOptions {
  model?: string;
  language?: string;
  translateToEnglish?: boolean;
  timestamps?: "none" | "segment" | "word";
  diarize?: boolean;
  prompt?: string;
  offsetSec?: number;
  signal?: AbortSignal;
  job?: JobContext;
}

/**
 * AUD-01. The one place that turns audio into text: the API, the meetings recorder (AUD-08) and the
 * document ingester (DOC-02) all call this so they behave identically.
 */
export async function transcribeFile(ctx: StudioContext, file: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const ref = opts.model ?? ctx.config.audio.sttModel ?? defaultSpeechModel(ctx);
  if (!ref) {
    throw new Error("nenhum modelo de transcrição na biblioteca. Baixe um com: aistudio models pull recipe:whisper-large-v3-turbo");
  }
  const found = ctx.engines.findModel(ref, ["speech"]);
  if (!found) throw new Error(`modelo de fala '${ref}' não encontrado na biblioteca.`);
  const install = await ctx.engines.ensureInstalled("whispercpp");
  const instance = await ctx.engines.supervisor.ensure("whispercpp", { model: found.model, backend: install.backend, signal: opts.signal });
  const adapter = ctx.engines.registry.get("whispercpp")!;
  const input: SttInput = {
    file,
    language: opts.language,
    translateToEnglish: opts.translateToEnglish,
    timestamps: opts.timestamps ?? "segment",
    diarize: opts.diarize,
    prompt: opts.prompt,
    offsetSec: opts.offsetSec,
  };
  const r = await adapter.run(instance, { task: "stt", input: input as unknown as Record<string, unknown>, signal: opts.signal, job: opts.job });
  return r.output as unknown as Transcript;
}

/** Prefer a diarization-capable model when the library has one; otherwise the first speech model. */
export function defaultSpeechModel(ctx: StudioContext): string | null {
  const speech = ctx.models.registry.list("speech").filter((m) => m.inspection.role === "main" || /whisper|ggml/i.test(m.filename));
  const turbo = speech.find((m) => /turbo/i.test(m.filename));
  return (turbo ?? speech[0])?.id ?? null;
}
