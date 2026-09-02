import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import { chatJson } from "../core/llm.js";
import { Ffmpeg, type Recording } from "./ffmpeg.js";
import { transcribeFile } from "./stt.js";
import { toSrt, toVtt } from "../engines/whispercpp.js";
import type { Meeting, Transcript, TranscriptSegment } from "./types.js";

const log = logger("meetings");

interface Live { meeting: Meeting; recording: Recording; timer: NodeJS.Timeout; consumedSec: number; busy: boolean }

/**
 * AUD-08. A meeting is: record mic and/or system audio → transcribe in windows while it happens →
 * summarise with the local model when it ends → optionally file everything in a project (DOC-02).
 * Windows are cut from the growing WAV with ffmpeg, so nothing is kept in memory and a crash still
 * leaves the full recording on disk.
 */
export class MeetingService {
  private live = new Map<string, Live>();

  constructor(private ctx: StudioContext) {}

  private file(id: string): string { return path.join(this.ctx.paths.recordings, `${id}.json`); }

  list(): Meeting[] {
    const out: Meeting[] = [];
    for (const name of safeReaddir(this.ctx.paths.recordings)) {
      if (!name.endsWith(".json")) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.ctx.paths.recordings, name), "utf8")) as Meeting); }
      catch { /* arquivo pela metade */ }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): Meeting | null {
    const live = this.live.get(id);
    if (live) return live.meeting;
    try { return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Meeting; } catch { return null; }
  }

  private save(m: Meeting): Meeting {
    fs.mkdirSync(this.ctx.paths.recordings, { recursive: true });
    fs.writeFileSync(this.file(m.id), JSON.stringify(m, null, 2));
    bus.publish("meeting.status", { id: m.id, status: m.status, title: m.title });
    return m;
  }

  /** Devices the user can pick from, with the Studio's suggestion already chosen. */
  async devices(): Promise<{ devices: Awaited<ReturnType<Ffmpeg["devices"]>>; suggestion: { mic: string | null; system: string | null } }> {
    const devices = await new Ffmpeg(this.ctx).devices();
    return {
      devices,
      suggestion: {
        mic: devices.find((d) => d.kind === "mic")?.id ?? null,
        system: devices.find((d) => d.kind === "system")?.id ?? null,
      },
    };
  }

  async start(o: { title?: string; sources?: ("mic" | "system")[]; mic?: string | null; system?: string | null; projectId?: string; language?: string; diarize?: boolean }): Promise<Meeting> {
    if (this.live.size > 0) throw new Error("já existe uma reunião gravando. Pare a atual antes de começar outra.");
    const sources = o.sources?.length ? o.sources : (["mic"] as ("mic" | "system")[]);
    const { suggestion } = await this.devices();
    const mic = sources.includes("mic") ? (o.mic ?? suggestion.mic) : null;
    const system = sources.includes("system") ? (o.system ?? suggestion.system) : null;
    if (!mic && !system) {
      throw new Error("nenhuma fonte de áudio disponível. No Windows use um dispositivo de loopback (virtual-audio-capturer); no macOS, BlackHole; no Linux, a fonte '.monitor'.");
    }
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
    const audioPath = path.join(this.ctx.paths.recordings, `${id}.wav`);
    const recording = await new Ffmpeg(this.ctx).record({ output: audioPath, mic, system });
    const meeting: Meeting = {
      id, title: o.title?.trim() || `Reunião de ${new Date().toLocaleString("pt-BR")}`,
      startedAt: new Date().toISOString(), status: "recording", audioPath,
      sources: [...(mic ? ["mic" as const] : []), ...(system ? ["system" as const] : [])],
      projectId: o.projectId,
      transcript: { language: o.language ?? "pt", duration: 0, segments: [], text: "" },
    };
    this.save(meeting);
    const windowSec = Math.max(10, this.ctx.config.audio.meetingWindowSec);
    const timer = setInterval(() => { void this.consumeWindow(id, { language: o.language, diarize: o.diarize ?? true }); }, windowSec * 1000);
    timer.unref();
    this.live.set(id, { meeting, recording, timer, consumedSec: 0, busy: false });
    log.info(`reunião ${id} gravando (${meeting.sources.join("+")}) → ${audioPath}`);
    return meeting;
  }

  /** Transcribe the part of the recording we have not read yet and publish the new lines. */
  private async consumeWindow(id: string, opts: { language?: string; diarize?: boolean }, final = false): Promise<void> {
    const live = this.live.get(id);
    if (!live || (live.busy && !final)) return;
    live.busy = true;
    const ffmpeg = new Ffmpeg(this.ctx);
    try {
      const total = (await ffmpeg.durationSec(live.meeting.audioPath!)) ?? 0;
      const available = Math.floor(total - live.consumedSec);
      const minChunk = final ? 1 : Math.max(10, this.ctx.config.audio.meetingWindowSec - 5);
      if (available < minChunk) return;
      const slice = path.join(this.ctx.paths.cache, "meetings", `${id}-${live.consumedSec}.wav`);
      fs.mkdirSync(path.dirname(slice), { recursive: true });
      await ffmpeg.run(["-hide_banner", "-nostdin", "-y", "-ss", String(live.consumedSec), "-t", String(available), "-i", live.meeting.audioPath!, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", slice]);
      const part = await transcribeFile(this.ctx, slice, { language: opts.language, diarize: opts.diarize, offsetSec: live.consumedSec });
      try { fs.unlinkSync(slice); } catch { /* já removido */ }
      if (part.segments.length) {
        const t = live.meeting.transcript!;
        t.segments.push(...part.segments);
        t.text = `${t.text} ${part.text}`.trim();
        t.duration = part.segments.at(-1)!.end;
        t.language = part.language;
        bus.publish("meeting.transcript", { id, segments: part.segments, duration: t.duration });
      }
      live.consumedSec += available;
      this.save(live.meeting);
    } catch (e) {
      log.warn(`janela da reunião ${id}: ${(e as Error).message}`);
    } finally { live.busy = false; }
  }

  /** Stop, transcribe the tail, summarise, and (when asked) file it in a project. */
  async stop(id: string, o: { summarize?: boolean; model?: string; language?: string } = {}): Promise<Meeting> {
    const live = this.live.get(id);
    if (!live) throw new Error(`a reunião '${id}' não está gravando`);
    clearInterval(live.timer);
    const meeting = live.meeting;
    meeting.status = "transcribing";
    meeting.endedAt = new Date().toISOString();
    this.save(meeting);
    try { await live.recording.stop(); } catch (e) { log.warn(`ffmpeg ao parar: ${(e as Error).message}`); }
    await this.consumeWindow(id, { language: o.language, diarize: true }, true);
    this.live.delete(id);

    if (o.summarize !== false && meeting.transcript && meeting.transcript.segments.length) {
      meeting.status = "summarizing";
      this.save(meeting);
      try {
        meeting.summary = await summarizeTranscript(this.ctx, meeting.transcript, { model: o.model, title: meeting.title });
      } catch (e) {
        log.warn(`resumo falhou: ${(e as Error).message}`);
        meeting.summary = { summary: `Não consegui resumir automaticamente: ${(e as Error).message}`, decisions: [], actions: [], questions: [] };
      }
    }
    meeting.status = "done";
    this.save(meeting);
    // DOC-02: the transcript becomes a source in the chosen project
    if (meeting.projectId) {
      try {
        const md = this.exportText(meeting, "md");
        const file = path.join(this.ctx.paths.recordings, `${meeting.id}.md`);
        fs.writeFileSync(file, md);
        await this.ctx.projects.addSourceFiles(meeting.projectId, [file], { ingest: true });
        log.info(`reunião ${meeting.id} enviada ao projeto ${meeting.projectId}`);
      } catch (e) { log.warn(`não consegui enviar ao projeto: ${(e as Error).message}`); }
    }
    return meeting;
  }

  /** Recording status without touching the disk. */
  isRecording(id: string): boolean { return this.live.has(id); }
  recordingIds(): string[] { return [...this.live.keys()]; }

  delete(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    if (this.live.has(id)) throw new Error("pare a reunião antes de apagar");
    for (const f of [this.file(id), m.audioPath, path.join(this.ctx.paths.recordings, `${id}.md`)]) {
      if (f && fs.existsSync(f)) fs.rmSync(f, { force: true });
    }
    return true;
  }

  exportText(m: Meeting, format: "md" | "srt" | "vtt" | "txt" | "json"): string {
    const t = m.transcript ?? { language: "pt", duration: 0, segments: [], text: "" };
    if (format === "srt") return toSrt(t);
    if (format === "vtt") return toVtt(t);
    if (format === "json") return JSON.stringify(m, null, 2);
    if (format === "txt") return t.segments.map((s) => `${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
    return meetingMarkdown(m);
  }
}

// -------------------------------------------------------------- pure parts ---

export interface MeetingSummary { summary: string; decisions: string[]; actions: { text: string; owner?: string; due?: string }[]; questions: string[] }

/** The prompt is in Brazilian Portuguese because the meetings are (AGENTS.md §2.8). */
export async function summarizeTranscript(ctx: StudioContext, transcript: Transcript, o: { model?: string; title?: string } = {}): Promise<MeetingSummary> {
  const text = transcriptForPrompt(transcript, 24000);
  const data = await chatJson<Partial<MeetingSummary>>(ctx, {
    model: o.model,
    temperature: 0.1,
    maxTokens: 1200,
    messages: [
      { role: "system", content: "Você resume reuniões em português do Brasil. Seja fiel ao que foi dito: não invente nomes, números ou compromissos." },
      { role: "user", content: `Reunião: ${o.title ?? "sem título"}\n\nTranscrição:\n${text}\n\nResponda em JSON com exatamente estas chaves:\n{"summary": "resumo em até 10 linhas", "decisions": ["decisões tomadas"], "actions": [{"text": "o que fazer", "owner": "quem", "due": "quando ou vazio"}], "questions": ["perguntas em aberto"]}` },
    ],
  });
  return {
    summary: String(data.summary ?? "").trim(),
    decisions: asStrings(data.decisions),
    actions: Array.isArray(data.actions)
      ? data.actions.filter((a): a is { text: string } => Boolean(a && typeof a === "object" && "text" in a)).map((a) => ({ text: String(a.text), owner: str((a as { owner?: unknown }).owner), due: str((a as { due?: unknown }).due) }))
      : [],
    questions: asStrings(data.questions),
  };
}

/** Long meetings do not fit the context: keep the beginning and the end, which is where decisions live. */
export function transcriptForPrompt(t: Transcript, maxChars: number): string {
  const lines = t.segments.map((s) => `[${fmtClock(s.start)}] ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const half = Math.floor(maxChars / 2);
  return `${full.slice(0, half)}\n\n[… trecho do meio omitido por tamanho …]\n\n${full.slice(-half)}`;
}

export function meetingMarkdown(m: Meeting): string {
  const t = m.transcript;
  const parts: string[] = [`# ${m.title}`, "", `- Início: ${new Date(m.startedAt).toLocaleString("pt-BR")}`];
  if (m.endedAt) parts.push(`- Fim: ${new Date(m.endedAt).toLocaleString("pt-BR")}`);
  parts.push(`- Fontes: ${m.sources.join(" + ") || "—"}`, "");
  if (m.summary) {
    parts.push("## Resumo", "", m.summary.summary || "—", "");
    if (m.summary.decisions.length) parts.push("## Decisões", "", ...m.summary.decisions.map((d) => `- ${d}`), "");
    if (m.summary.actions.length) parts.push("## Ações", "", ...m.summary.actions.map((a) => `- ${a.text}${a.owner ? ` — ${a.owner}` : ""}${a.due ? ` (${a.due})` : ""}`), "");
    if (m.summary.questions.length) parts.push("## Perguntas em aberto", "", ...m.summary.questions.map((q) => `- ${q}`), "");
  }
  parts.push("## Transcrição", "");
  for (const s of t?.segments ?? []) parts.push(`**${fmtClock(s.start)}** ${s.speaker ? `*${s.speaker}*: ` : ""}${s.text}`);
  return parts.join("\n");
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function asStrings(v: unknown): string[] { return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()) : []; }
function str(v: unknown): string | undefined { const s = typeof v === "string" ? v.trim() : ""; return s || undefined; }
function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }

/** Only used by tests and the API when a caller asks for segments in a window. */
export function segmentsBetween(segments: TranscriptSegment[], from: number, to: number): TranscriptSegment[] {
  return segments.filter((s) => s.end > from && s.start < to);
}
