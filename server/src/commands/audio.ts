import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { transcribeFile } from "../audio/stt.js";
import { toSrt, toVtt } from "../engines/whispercpp.js";
import { bus } from "../core/events.js";

/** AUD-01/02/08 pela linha de comando: falar, transcrever e gravar reunião sem abrir a interface. */

export async function speakCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const text = rest.join(" ").trim();
  if (!text) throw new Error('uso: aistudio speak "o texto" [--voice <id>] [--out saida.wav] [--speed 1.0]');
  const voices = ctx.voices.list();
  if (typeof flags.voice !== "string" && !voices.length) {
    throw new Error("nenhuma voz instalada. Baixe uma com: aistudio models pull recipe:piper-pt-br-faber");
  }
  const format = typeof flags.out === "string" ? (path.extname(flags.out).slice(1) || "wav") : "wav";
  const r = await ctx.tts.speak({
    text, voice: typeof flags.voice === "string" ? flags.voice : undefined,
    format: format as "wav", speed: typeof flags.speed === "string" ? Number(flags.speed) : undefined,
  });
  const out = typeof flags.out === "string" ? path.resolve(flags.out) : r.file;
  if (out !== r.file) fs.copyFileSync(r.file, out);
  console.log(`  ✔ ${r.voice.name} falou em ${r.ms} ms → ${out}`);
}

export async function transcribeCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const file = rest[0] ? path.resolve(rest[0]) : "";
  if (!file || !fs.existsSync(file)) throw new Error("uso: aistudio transcribe <arquivo> [--diarize] [--language pt] [--format srt|vtt|txt|json] [--out arquivo]");
  const t = await transcribeFile(ctx, file, {
    language: typeof flags.language === "string" ? flags.language : undefined,
    diarize: flags.diarize === true,
    translateToEnglish: flags.translate === true,
    timestamps: flags.words === true ? "word" : "segment",
  });
  const format = typeof flags.format === "string" ? flags.format : "txt";
  const body = format === "srt" ? toSrt(t) : format === "vtt" ? toVtt(t) : format === "json" ? JSON.stringify(t, null, 2)
    : t.segments.map((s) => `${s.speaker ? `${s.speaker}: ` : ""}${s.text}`).join("\n");
  if (typeof flags.out === "string") {
    fs.writeFileSync(path.resolve(flags.out), body);
    console.log(`  ✔ ${Math.round(t.duration)} s transcritos (${t.language}) → ${path.resolve(flags.out)}`);
  } else {
    console.log(body);
  }
}

export async function meetingCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = rest[0] ?? "list";
  if (action === "devices") {
    const { devices, suggestion } = await ctx.meetings.devices();
    if (!devices.length) return void console.log("  Nenhum dispositivo de áudio encontrado (o ffmpeg está instalado?).");
    for (const d of devices) console.log(`  ${d.kind.padEnd(7)} ${d.id}${d.id === suggestion.mic || d.id === suggestion.system ? "  ← sugerido" : ""}`);
    return;
  }
  if (action === "list") {
    const list = ctx.meetings.list();
    if (!list.length) return void console.log("  Nenhuma reunião gravada ainda.");
    for (const m of list) console.log(`  ${m.id}  ${m.status.padEnd(12)} ${m.title}`);
    return;
  }
  if (action === "start") {
    const sources: ("mic" | "system")[] = [];
    if (flags.system !== true || flags.mic === true) sources.push("mic");
    if (flags.system === true || flags.both === true) sources.push("system");
    const m = await ctx.meetings.start({
      title: typeof flags.title === "string" ? flags.title : rest.slice(1).join(" ") || undefined,
      sources: sources.length ? sources : ["mic"],
      projectId: typeof flags.project === "string" ? flags.project : undefined,
      language: typeof flags.language === "string" ? flags.language : "pt",
    });
    console.log(`  ● gravando "${m.title}" (${m.sources.join(" + ")}) → ${m.audioPath}`);
    console.log(`     Pare com: aistudio meeting stop ${m.id}`);
    if (flags.follow === true) {
      const off = bus.subscribe("meeting.transcript", (ev) => {
        const data = ev.data as { id: string; segments: { speaker?: string; text: string }[] };
        if (data.id !== m.id) return;
        for (const s of data.segments) console.log(`  ${s.speaker ? `${s.speaker}: ` : ""}${s.text}`);
      });
      process.once("SIGINT", () => { off(); void ctx.meetings.stop(m.id).then(() => process.exit(0)); });
      await new Promise(() => { /* segue até Ctrl+C */ });
    }
    return;
  }
  if (action === "stop") {
    const id = rest[1] ?? ctx.meetings.recordingIds()[0];
    if (!id) throw new Error("nenhuma reunião gravando");
    const m = await ctx.meetings.stop(id, { model: typeof flags.model === "string" ? flags.model : undefined });
    console.log(`  ✔ ${m.title}: ${m.transcript?.segments.length ?? 0} trecho(s)`);
    if (m.summary?.summary) {
      console.log(`\n  Resumo:\n  ${m.summary.summary.replace(/\n/g, "\n  ")}`);
      for (const a of m.summary.actions) console.log(`   • ${a.text}${a.owner ? ` (${a.owner})` : ""}`);
    }
    return;
  }
  if (action === "export") {
    const id = rest[1];
    const m = id ? ctx.meetings.get(id) : null;
    if (!m) throw new Error("uso: aistudio meeting export <id> [--format md|srt|vtt|txt|json] [--out arquivo]");
    const format = (typeof flags.format === "string" ? flags.format : "md") as "md";
    const body = ctx.meetings.exportText(m, format);
    if (typeof flags.out === "string") { fs.writeFileSync(path.resolve(flags.out), body); console.log(`  ✔ ${path.resolve(flags.out)}`); }
    else console.log(body);
    return;
  }
  throw new Error("uso: aistudio meeting <devices|start|stop|list|export>");
}
