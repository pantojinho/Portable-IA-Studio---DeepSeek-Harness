import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import type { Voice } from "./types.js";
import { detectVoicePack, type VoicePack } from "../engines/sherpaonnx.js";
import { logger } from "../core/log.js";

const log = logger("voices");

/**
 * AUD-02. The registry is the seam between the UI/API and whatever engine actually speaks:
 * `/v1/audio/speech` only ever sees `voice=<id>`. Two sources feed it:
 *  - packs the user downloaded (models/tts/<pack>/), detected by their contents;
 *  - voices the user created (voices/<id>/voice.json), including cloned ones with a sample.
 */
export class VoiceRegistry {
  private cache: Voice[] | null = null;
  private packs = new Map<string, VoicePack>();

  constructor(private ctx: StudioContext) {}

  list(refresh = false): Voice[] {
    if (refresh || !this.cache) this.scan();
    return this.cache!;
  }

  get(id: string): Voice | undefined {
    return this.list().find((v) => v.id === id) ?? this.list(true).find((v) => v.id === id);
  }

  /** The sherpa-onnx folder behind a pack voice (null for engines that do not use packs). */
  pack(voice: Voice): VoicePack | null { return this.packs.get(voice.id) ?? null; }

  /** Default voice for a language: the user's choice, then a matching pack, then anything. */
  defaultFor(language = "pt-BR"): Voice | null {
    const all = this.list();
    const pref = this.ctx.config.audio?.defaultVoice;
    if (pref) { const v = all.find((x) => x.id === pref); if (v) return v; }
    const lang = language.toLowerCase();
    return all.find((v) => v.language.toLowerCase() === lang)
      ?? all.find((v) => v.language.toLowerCase().startsWith(lang.slice(0, 2)))
      ?? all[0] ?? null;
  }

  scan(): Voice[] {
    const voices: Voice[] = [];
    this.packs.clear();
    // 1) downloaded packs (models/tts/**) — one voice per speaker when the pack lists them
    const ttsRoot = path.join(this.ctx.paths.models, "tts");
    for (const dir of packDirs(ttsRoot)) {
      const pack = detectVoicePack(dir);
      if (!pack) continue;
      const packId = slug(path.basename(dir));
      const language = languageFromName(path.basename(dir));
      const engine = pack.kind === "kokoro" ? "kokoro" : "piper";
      const speakers = pack.speakers ?? [];
      if (speakers.length > 1) {
        speakers.forEach((name, sid) => {
          const id = `${packId}:${slug(name)}`;
          voices.push({
            id, name: `${prettyName(path.basename(dir))} · ${name}`, engine, language: languageFromName(name) ?? language,
            gender: genderFromName(name), models: [dir], params: { speakerId: sid, packKind: pack.kind, dir },
            builtin: true, createdAt: statTime(dir),
          });
          this.packs.set(id, pack);
        });
      } else {
        voices.push({
          id: packId, name: prettyName(path.basename(dir)), engine, language,
          gender: genderFromName(path.basename(dir)), models: [dir],
          params: { speakerId: 0, packKind: pack.kind, dir, speakers: speakers.length ? speakers : undefined },
          builtin: true, createdAt: statTime(dir),
        });
        this.packs.set(packId, pack);
      }
    }
    // 2) user voices (voices/<id>/voice.json)
    for (const entry of safeReaddir(this.ctx.paths.voices)) {
      const file = path.join(this.ctx.paths.voices, entry, "voice.json");
      if (!fs.existsSync(file)) continue;
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as Voice;
        v.id = v.id || entry;
        v.builtin = false;
        const i = voices.findIndex((x) => x.id === v.id);
        if (i >= 0) voices[i] = v; else voices.push(v);
        if (v.params?.dir && typeof v.params.dir === "string") {
          const p = detectVoicePack(v.params.dir);
          if (p) this.packs.set(v.id, p);
        }
      } catch (e) { log.warn(`voz inválida em ${file}: ${(e as Error).message}`); }
    }
    this.cache = voices.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return this.cache;
  }

  /** Create/replace a user voice. Cloned voices keep their sample inside voices/<id>/. */
  save(input: Partial<Voice> & { id?: string; name: string; engine: string }): Voice {
    const id = slug(input.id ?? input.name);
    const dir = path.join(this.ctx.paths.voices, id);
    fs.mkdirSync(dir, { recursive: true });
    const voice: Voice = {
      id, name: input.name, engine: input.engine, language: input.language ?? "pt-BR",
      gender: input.gender, models: input.models ?? [], sample: input.sample,
      params: input.params ?? {}, builtin: false, createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "voice.json"), JSON.stringify(voice, null, 2));
    this.cache = null;
    return voice;
  }

  /** Only user voices can be removed, and only inside voices/ (AGENTS.md §2.5). */
  delete(id: string): boolean {
    const v = this.get(id);
    if (!v) return false;
    if (v.builtin) throw new Error(`'${id}' vem de um pacote baixado. Remova o modelo em Modelos, não aqui.`);
    const dir = path.join(this.ctx.paths.voices, id);
    if (!dir.startsWith(this.ctx.paths.voices)) throw new Error("caminho inválido");
    fs.rmSync(dir, { recursive: true, force: true });
    this.cache = null;
    return true;
  }
}

// ------------------------------------------------------------- pure helpers ---

/** Packs sit at models/tts/<pack>/ or models/tts/<group>/<pack>/. */
export function packDirs(root: string): string[] {
  const out: string[] = [];
  for (const a of safeReaddir(root)) {
    const dirA = path.join(root, a);
    if (!isDir(dirA)) continue;
    out.push(dirA);
    for (const b of safeReaddir(dirA)) {
      const dirB = path.join(dirA, b);
      if (isDir(dirB)) out.push(dirB);
    }
  }
  return out;
}

export function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "voz";
}

/** "vits-piper-pt_BR-faber-medium" → "pt-BR"; "kokoro-multi-lang-v1_0" → "und". */
export function languageFromName(name: string): string {
  const m = name.match(/(?:^|[-_.])([a-z]{2})[-_]([A-Z]{2})(?=$|[-_.])/);
  if (m) return `${m[1]!.toLowerCase()}-${m[2]!.toUpperCase()}`;
  const only = name.match(/(?:^|[-_.])(pt|en|es|fr|de|it|zh|ja|ru)(?=$|[-_.])/i);
  return only ? only[1]!.toLowerCase() : "und";
}

export function prettyName(dirName: string): string {
  return dirName.replace(/^(vits|matcha|kokoro)-/i, "").replace(/^piper-/i, "").replace(/[-_]/g, " ").trim();
}

export function genderFromName(name: string): "f" | "m" | undefined {
  if (/^(pf_|bf_|af_|ef_|if_|jf_|zf_)/i.test(name) || /female|feminina/i.test(name)) return "f";
  if (/^(pm_|bm_|am_|em_|im_|jm_|zm_)/i.test(name) || /\bmale|masculina/i.test(name)) return "m";
  return undefined;
}

function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function statTime(p: string): string { try { return new Date(fs.statSync(p).mtimeMs).toISOString(); } catch { return new Date().toISOString(); } }
