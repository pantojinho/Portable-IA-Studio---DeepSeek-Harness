import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import { extractDocument } from "./extract/index.js";
import { chunkMarkdown, indexChunks } from "./search.js";
import type { SourceFile } from "./types.js";
import { transcribeFile } from "../audio/stt.js";
import { toSrt } from "../engines/whispercpp.js";

const log = logger("ingest");

export interface IngestResult { processed: number; failed: number; chunks: number; skipped: number; sources: { id: string; name: string; status: string; error?: string }[] }

/**
 * DOC-02. One source at a time: detect → extract (or OCR / transcribe) → Markdown in derived/ →
 * chunks → embeddings → index. Every step reports progress, so a 200-page batch is watchable and
 * cancellable, and one bad file never stops the rest.
 */
export async function ingestSources(ctx: StudioContext, projectId: string, o: { sourceIds?: string[]; force?: boolean; job?: JobContext } = {}): Promise<IngestResult> {
  const project = ctx.projects.require(projectId);
  const all = ctx.projects.sources(projectId);
  const targets = o.sourceIds?.length ? all.filter((s) => o.sourceIds!.includes(s.id)) : all.filter((s) => o.force || s.status !== "done");
  const result: IngestResult = { processed: 0, failed: 0, chunks: 0, skipped: all.length - targets.length, sources: [] };

  for (let i = 0; i < targets.length; i++) {
    const source = targets[i]!;
    if (o.job?.signal.aborted) throw new Error("cancelled");
    const progress = (frac: number, msg: string) => o.job?.setProgress((i + frac) / targets.length, `${i + 1}/${targets.length} ${source.name}: ${msg}`);
    try {
      progress(0.05, "lendo");
      const chunks = await ingestOne(ctx, projectId, source, { job: o.job, progress });
      result.chunks += chunks;
      result.processed++;
      result.sources.push({ id: source.id, name: source.name, status: "done" });
    } catch (e) {
      const message = (e as Error).message;
      if (message === "cancelled") throw e;
      log.warn(`${source.name}: ${message}`);
      ctx.projects.updateSource(projectId, source.id, { status: "failed", error: message });
      result.failed++;
      result.sources.push({ id: source.id, name: source.name, status: "failed", error: message });
    }
    bus.publish("project.ingest", { projectId, sourceId: source.id, done: i + 1, total: targets.length });
  }
  ctx.projects.setMeta(projectId, "lastIngestAt", new Date().toISOString());
  log.info(`${project.name}: ${result.processed} documento(s), ${result.chunks} trecho(s), ${result.failed} falha(s)`);
  return result;
}

async function ingestOne(
  ctx: StudioContext, projectId: string, source: SourceFile,
  o: { job?: JobContext; progress: (frac: number, msg: string) => void },
): Promise<number> {
  const project = ctx.projects.require(projectId);
  const derivedDir = ctx.projects.derivedDir(projectId);
  fs.mkdirSync(derivedDir, { recursive: true });
  ctx.projects.updateSource(projectId, source.id, { status: "extracting" });

  const extracted = extractDocument(source.path);
  let markdown = extracted.markdown;
  let pages = extracted.pages;
  let transcriptFile: string | undefined;
  let ocrFile: string | undefined;

  if (extracted.needsTranscription) {
    // AUD-01: audio and video become a transcript, which is then treated as text
    ctx.projects.updateSource(projectId, source.id, { status: "extracting" });
    o.progress(0.2, "transcrevendo o áudio");
    const transcript = await transcribeFile(ctx, source.path, { language: project.settings.language.slice(0, 2), diarize: true, job: o.job, signal: o.job?.signal });
    transcriptFile = path.join(derivedDir, `${source.id}.srt`);
    fs.writeFileSync(transcriptFile, toSrt(transcript));
    markdown = transcript.segments.map((s) => `${s.speaker ? `**${s.speaker}**: ` : ""}${s.text}`).join("\n\n");
  } else if (extracted.needsOcr) {
    // DOC-03: no text layer → the vision model reads the pages
    ctx.projects.updateSource(projectId, source.id, { status: "ocr" });
    o.progress(0.2, "lendo com OCR (o modelo de visão)");
    const { ocrFileToMarkdown } = await import("./ocr.js");
    const ocr = await ocrFileToMarkdown(ctx, source.path, {
      model: project.settings.ocrModel, language: project.settings.language,
      onPage: (page, total) => o.progress(0.2 + 0.5 * (page / Math.max(1, total)), `OCR página ${page}/${total}`),
      signal: o.job?.signal,
    });
    markdown = ocr.markdown;
    pages = ocr.pages.length;
    ocrFile = path.join(derivedDir, `${source.id}.ocr.json`);
    fs.writeFileSync(ocrFile, JSON.stringify(ocr, null, 2));
  }

  if (!markdown.trim()) {
    ctx.projects.updateSource(projectId, source.id, { status: "skipped", error: "não consegui extrair texto deste arquivo" });
    return 0;
  }

  const mdFile = path.join(derivedDir, `${source.id}.md`);
  fs.writeFileSync(mdFile, markdown);

  ctx.projects.updateSource(projectId, source.id, { status: "chunking", pages, derived: { markdown: mdFile, ocrJson: ocrFile, transcript: transcriptFile } });
  const chunks = chunkMarkdown(markdown, { chunkTokens: project.settings.chunkTokens, overlap: project.settings.chunkOverlap });

  ctx.projects.updateSource(projectId, source.id, { status: "embedding" });
  o.progress(0.8, `indexando ${chunks.length} trecho(s)`);
  const n = await indexChunks(ctx, projectId, source.id, chunks, { signal: o.job?.signal });

  // DOC-06: what the Studio learned about this document goes to the project memory
  try {
    const { rememberSource } = await import("./memory.js");
    await rememberSource(ctx, projectId, source.id, markdown, { signal: o.job?.signal });
  } catch (e) { log.debug(`memória: ${(e as Error).message}`); }

  ctx.projects.updateSource(projectId, source.id, { status: "done", error: null as unknown as undefined });
  return n;
}
