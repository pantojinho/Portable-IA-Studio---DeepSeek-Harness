import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import { platform } from "../core/system.js";
import { logger } from "../core/log.js";

const log = logger("ffmpeg");

/**
 * AUD-07. ffmpeg is the Studio's swiss knife: convert anything to the 16 kHz mono WAV whisper wants,
 * encode speech to mp3/ogg, list capture devices, record mic + system audio, and mux video frames.
 * It is an *engine* (engines/ffmpeg/...), never an npm dependency (AGENTS.md §2.3).
 */
export interface AudioDevice { id: string; name: string; kind: "mic" | "system" | "unknown" }

export class Ffmpeg {
  constructor(private ctx: StudioContext) {}

  /** Installed build, a binary next to it (ffprobe), or whatever the system PATH offers. */
  binary(name: "ffmpeg" | "ffprobe" = "ffmpeg"): string | null {
    const inst = this.ctx.engines.installer.installedAny("ffmpeg");
    if (inst) {
      const exe = path.join(path.dirname(inst.exe), platform() === "win" ? `${name}.exe` : name);
      if (fs.existsSync(exe)) return exe;
      if (name === "ffmpeg") return inst.exe;
    }
    const fromPath = onPath(platform() === "win" ? `${name}.exe` : name);
    return fromPath;
  }

  async ensure(): Promise<string> {
    const have = this.binary();
    if (have) return have;
    await this.ctx.engines.ensureInstalled("ffmpeg", "cpu");
    const after = this.binary();
    if (!after) throw new Error("ffmpeg não encontrado. Instale com: aistudio engines install ffmpeg");
    return after;
  }

  /** Run ffmpeg to completion, collecting stderr (ffmpeg talks on stderr even when happy). */
  async run(args: string[], opts: { signal?: AbortSignal; onStderr?: (line: string) => void; bin?: string } = {}): Promise<string> {
    const exe = opts.bin ?? (await this.ensure());
    return new Promise<string>((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => {
        err += d;
        if (err.length > 200_000) err = err.slice(-100_000);
        if (opts.onStderr) for (const line of d.split(/\r?\n/)) if (line.trim()) opts.onStderr(line.trim());
      });
      const onAbort = () => { try { child.kill("SIGKILL"); } catch { /* já morreu */ } };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (e) => reject(new Error(`ffmpeg não executou: ${e.message}`)));
      child.once("exit", (code) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (code === 0 || opts.signal?.aborted) resolve(err);
        else reject(new Error(`ffmpeg falhou (código ${code}): ${lastLines(err, 3)}`));
      });
    });
  }

  /** whisper.cpp only reads 16 kHz mono PCM; everything else (mp3, m4a, ogg, mp4, webm) passes here. */
  async toWav16k(input: string, output: string, signal?: AbortSignal): Promise<string> {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await this.run(["-hide_banner", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output], { signal });
    return output;
  }

  /** Encode a WAV the TTS engines produced into what the caller asked for. */
  async encode(input: string, output: string, format: "wav" | "mp3" | "ogg" | "flac", signal?: AbortSignal): Promise<string> {
    if (format === "wav") { if (input !== output) fs.copyFileSync(input, output); return output; }
    const codec = format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "128k"] : format === "ogg" ? ["-c:a", "libvorbis", "-q:a", "4"] : ["-c:a", "flac"];
    await this.run(["-hide_banner", "-nostdin", "-y", "-i", input, ...codec, output], { signal });
    return output;
  }

  async durationSec(file: string): Promise<number | null> {
    const probe = this.binary("ffprobe");
    try {
      if (probe) {
        const out = await new Promise<string>((resolve, reject) => {
          const c = spawn(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
          let s = ""; c.stdout.on("data", (d) => (s += d)); c.once("error", reject); c.once("exit", () => resolve(s));
        });
        const n = Number(out.trim());
        return Number.isFinite(n) ? n : null;
      }
      const err = await this.run(["-hide_banner", "-i", file, "-f", "null", "-"], {}).catch((e: Error) => e.message);
      return parseDuration(err);
    } catch { return null; }
  }

  /** What the machine can record from. Names come straight from ffmpeg; we only classify them. */
  async devices(): Promise<AudioDevice[]> {
    const p = platform();
    try {
      if (p === "linux") {
        const pactl = onPath("pactl");
        if (pactl) {
          const out = await new Promise<string>((resolve) => {
            const c = spawn(pactl, ["list", "short", "sources"], { windowsHide: true });
            let s = ""; c.stdout.on("data", (d) => (s += d)); c.once("error", () => resolve("")); c.once("exit", () => resolve(s));
          });
          return parsePactl(out);
        }
        return [{ id: "default", name: "Entrada padrão (PulseAudio)", kind: "mic" }];
      }
      if (p === "win") {
        const err = await this.run(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {}).catch((e: Error) => e.message);
        return parseDshow(err);
      }
      const err = await this.run(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {}).catch((e: Error) => e.message);
      return parseAvfoundation(err);
    } catch (e) {
      log.warn(`não consegui listar dispositivos: ${(e as Error).message}`);
      return [];
    }
  }

  /** Start a recording; the returned handle stops it politely (ffmpeg flushes the header on 'q'). */
  async record(opts: { output: string; mic?: string | null; system?: string | null; signal?: AbortSignal }): Promise<Recording> {
    const exe = await this.ensure();
    fs.mkdirSync(path.dirname(opts.output), { recursive: true });
    const args = buildCaptureArgs(platform(), { mic: opts.mic ?? null, system: opts.system ?? null, output: opts.output });
    log.info(`gravando: ffmpeg ${args.join(" ")}`);
    const child = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => { err = (err + d).slice(-8000); });
    return new Recording(child, opts.output, () => err);
  }

  /** Long texts are spoken in pieces (AUD-02); the concat demuxer glues them without re-encoding. */
  async concatWavs(parts: string[], output: string, signal?: AbortSignal): Promise<string> {
    if (parts.length === 1) { if (parts[0] !== output) fs.renameSync(parts[0]!, output); return output; }
    const listFile = `${output}.txt`;
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
    try {
      await this.run(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output], { signal });
    } finally { try { fs.unlinkSync(listFile); } catch { /* já removido */ } }
    return output;
  }

  /** VID-01: frames (out-0001.png…) → mp4 the browser can play. */
  async framesToMp4(pattern: string, fps: number, output: string, signal?: AbortSignal): Promise<string> {
    await this.run(["-hide_banner", "-nostdin", "-y", "-framerate", String(fps), "-i", pattern,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { signal });
    return output;
  }
}

export class Recording {
  readonly startedAt = Date.now();
  private stopped = false;
  constructor(private child: ChildProcess, readonly file: string, private stderr: () => string) {}

  get pid(): number | null { return this.child.pid ?? null; }
  get running(): boolean { return this.child.exitCode === null && !this.stopped; }

  /** 'q' on stdin makes ffmpeg close the container properly; SIGKILL would truncate the WAV header. */
  stop(): Promise<string> {
    if (this.stopped) return Promise.resolve(this.file);
    this.stopped = true;
    // o ffmpeg pode já ter morrido (dispositivo errado, permissão): sem isto o 'exit' nunca vem
    // e a reunião ficava presa em "parando" para sempre
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return fs.existsSync(this.file) && fs.statSync(this.file).size > 1024
        ? Promise.resolve(this.file)
        : Promise.reject(new Error(`a gravação terminou sozinha (código ${this.child.exitCode ?? this.child.signalCode}): ${lastLines(this.stderr(), 3)}`));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch { /* */ } }, 8000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        if (fs.existsSync(this.file) && fs.statSync(this.file).size > 1024) resolve(this.file);
        else reject(new Error(`a gravação não produziu áudio (código ${code}): ${lastLines(this.stderr(), 3)}`));
      });
      try { this.child.stdin?.write("q"); this.child.stdin?.end(); } catch { try { this.child.kill(); } catch { /* */ } }
    });
  }
}

// ------------------------------------------------------------- pure helpers ---

export interface CaptureSpec { mic: string | null; system: string | null; output: string }

/**
 * One ffmpeg command per OS. Mic and system audio become one 16 kHz mono WAV (amix) so whisper
 * gets exactly what it wants and the meeting has a single timeline.
 * Windows: dshow (system audio needs a loopback device such as "virtual-audio-capturer" or VB-Cable).
 * macOS: avfoundation (system audio needs BlackHole/Loopback — Apple has no native loopback).
 * Linux: PulseAudio/PipeWire; the ".monitor" source is the system output.
 */
export function buildCaptureArgs(os: "win" | "mac" | "linux", spec: CaptureSpec): string[] {
  const inputs: string[] = [];
  const add = (device: string, kind: "mic" | "system") => {
    if (os === "win") inputs.push("-f", "dshow", "-i", `audio=${device}`);
    else if (os === "mac") inputs.push("-f", "avfoundation", "-i", `:${device}`);
    else inputs.push("-f", "pulse", "-i", device);
    void kind;
  };
  if (spec.mic) add(spec.mic, "mic");
  if (spec.system) add(spec.system, "system");
  if (inputs.length === 0) throw new Error("escolha ao menos uma fonte de áudio (microfone ou som do sistema)");
  const n = inputs.length / 4;
  const args = ["-hide_banner", "-nostdin", "-y", ...inputs];
  if (n > 1) args.push("-filter_complex", `amix=inputs=${n}:duration=longest:normalize=0`);
  args.push("-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", spec.output);
  return args;
}

export function parseDshow(stderr: string): AudioDevice[] {
  const out: AudioDevice[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (!m) continue;
    const name = m[1]!;
    out.push({ id: name, name, kind: /virtual-audio-capturer|stereo mix|mixagem|loopback|cable output|what u hear/i.test(name) ? "system" : "mic" });
  }
  return out;
}

export function parseAvfoundation(stderr: string): AudioDevice[] {
  const out: AudioDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
    if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (inAudio && m) {
      const name = m[2]!;
      out.push({ id: m[1]!, name, kind: /blackhole|loopback|soundflower|aggregate/i.test(name) ? "system" : "mic" });
    }
  }
  return out;
}

export function parsePactl(out: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.split(/\s+/);
    const name = cols[1];
    if (!name) continue;
    devices.push({ id: name, name, kind: name.endsWith(".monitor") ? "system" : "mic" });
  }
  return devices;
}

export function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function lastLines(s: string, n: number): string {
  return s.split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(" | ");
}

function onPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* dir sumiu */ }
  }
  return null;
}
