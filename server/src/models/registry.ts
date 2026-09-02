import fs from "node:fs";
import path from "node:path";
import { MODEL_KINDS, type ModelKind, type Paths } from "../core/paths.js";
import { inspectFile } from "./inspect.js";
import type { Inspection, ModelRecord, ModelSource } from "./types.js";
import { logger } from "../core/log.js";

const log = logger("registry");
const SIDECAR = ".aistudio.json";
const WEIGHT_EXT = /\.(gguf|safetensors|ckpt|pt|pth|bin|onnx)$/i;

interface IndexEntry { size: number; mtimeMs: number; inspection: Inspection }

/**
 * The library on disk is the source of truth: models/<kind>/**. Every weight
 * file is inspected once (cached by size+mtime) so the UI never trusts names.
 * Sidecars (<file>.aistudio.json) remember where a file came from.
 */
export class ModelRegistry {
  private index: Record<string, IndexEntry> = {};
  private indexPath: string;
  private records: ModelRecord[] = [];

  constructor(private paths: Paths) {
    this.indexPath = path.join(paths.cache, "models-index.json");
    try { this.index = JSON.parse(fs.readFileSync(this.indexPath, "utf8")); } catch { this.index = {}; }
  }

  private saveIndex(): void {
    try { fs.mkdirSync(path.dirname(this.indexPath), { recursive: true }); fs.writeFileSync(this.indexPath, JSON.stringify(this.index)); } catch (e) { log.warn("não consegui salvar o índice", e); }
  }

  scan(): ModelRecord[] {
    const out: ModelRecord[] = [];
    for (const kind of MODEL_KINDS) {
      const dir = path.join(this.paths.models, kind);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir)) {
        if (!WEIGHT_EXT.test(file) && !/\.onnx\.json$/i.test(file)) continue;
        if (file.endsWith(".part")) continue;
        const rec = this.record(kind, file);
        if (rec) out.push(rec);
      }
    }
    this.records = out.sort((a, b) => a.kind.localeCompare(b.kind) || a.filename.localeCompare(b.filename));
    this.saveIndex();
    return this.records;
  }

  private record(kind: ModelKind, file: string): ModelRecord | null {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return null; }
    const key = file;
    let entry = this.index[key];
    if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
      try { entry = { size: st.size, mtimeMs: st.mtimeMs, inspection: inspectFile(file) }; }
      catch (e) { log.warn(`inspeção falhou em ${file}: ${(e as Error).message}`); return null; }
      this.index[key] = entry;
    }
    const rel = path.relative(path.join(this.paths.models, kind), file).split(path.sep).join("/");
    const side = readSidecar(file);
    return {
      id: `${kind}/${rel}`, kind, filename: path.basename(file), path: file, sizeBytes: st.size, mtimeMs: st.mtimeMs,
      inspection: entry.inspection, source: side?.source, recipe: side?.recipe, companions: side?.companions,
    };
  }

  list(kind?: ModelKind): ModelRecord[] { if (this.records.length === 0) this.scan(); return kind ? this.records.filter((r) => r.kind === kind) : this.records; }
  get(id: string): ModelRecord | undefined { return this.list().find((r) => r.id === id); }

  /** Only the Studio's own folder is ever touched; the user's file is never deleted by the Studio elsewhere. */
  delete(id: string): boolean {
    const rec = this.get(id);
    if (!rec) return false;
    const inside = path.resolve(rec.path).startsWith(path.resolve(this.paths.models) + path.sep);
    if (!inside) throw new Error("recusado: arquivo fora da biblioteca do Studio");
    fs.unlinkSync(rec.path);
    try { fs.unlinkSync(rec.path + SIDECAR); } catch { /* none */ }
    delete this.index[rec.path];
    this.scan();
    return true;
  }

  /** Where a file of this kind lives. */
  destPath(kind: ModelKind, filename: string, subdir?: string): string {
    return path.join(this.paths.models, kind, ...(subdir ? subdir.split("/") : []), path.basename(filename));
  }

  /**
   * Bring an external file into the library. Hardlink when on the same volume
   * (instant, no extra disk), otherwise copy. The original is left untouched
   * unless `move` is true.
   */
  importFile(src: string, opts: { kind?: ModelKind; subdir?: string; move?: boolean; source?: ModelSource } = {}): ModelRecord {
    if (!fs.existsSync(src)) throw new Error(`arquivo não existe: ${src}`);
    const insp = inspectFile(src);
    if (insp.format === "html") throw new Error(`${path.basename(src)} é uma página HTML, não um modelo.`);
    const kind = opts.kind ?? insp.kind;
    if (!kind) throw new Error(`não consegui classificar ${path.basename(src)} (${insp.notes.join("; ") || insp.format}). Informe o tipo manualmente.`);
    const dest = this.destPath(kind, src, opts.subdir);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(dest) !== path.resolve(src)) {
      if (fs.existsSync(dest)) throw new Error(`já existe: ${dest}`);
      if (opts.move) fs.renameSync(src, dest);
      else { try { fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); } }
      const srcSide = readSidecar(src);
      if (srcSide) fs.copyFileSync(src + SIDECAR, dest + SIDECAR);
    }
    if (opts.source) writeSidecar(dest, { source: opts.source });
    this.scan();
    return this.get(`${kind}/${path.relative(path.join(this.paths.models, kind), dest).split(path.sep).join("/")}`)!;
  }

  writeSidecar(file: string, data: Sidecar): void { writeSidecar(file, data); }
}

export interface Sidecar { source?: ModelSource; recipe?: { id: string; role: import("./types.js").FileRole }; companions?: string[] }

export function readSidecar(file: string): Sidecar | null {
  try { return JSON.parse(fs.readFileSync(file + SIDECAR, "utf8")) as Sidecar; } catch { return null; }
}
export function writeSidecar(file: string, data: Sidecar): void {
  const cur = readSidecar(file) ?? {};
  fs.writeFileSync(file + SIDECAR, JSON.stringify({ ...cur, ...data }, null, 2));
}

export function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

// ---------------------------------------------------------- migration ---

export interface MigrationCandidate {
  path: string;
  sizeBytes: number;
  inspection: Inspection;
  suggestedKind: ModelKind | null;
  problem: string | null;      // "html" | "partial" | "unknown" | null
  originFolder: string;
}

const ULS_FOLDERS: { rel: string; hint: ModelKind }[] = [
  { rel: "app/models", hint: "image" }, { rel: "app/llm-models", hint: "text" }, { rel: "app/speech-models", hint: "speech" },
  { rel: "app/tts-models", hint: "tts" }, { rel: "app/openvino-models", hint: "image" },
];

/** Find model files in an Uncensored-Local-Studio (or any) folder and say what each one really is. */
export function scanForMigration(sourceDir: string): MigrationCandidate[] {
  const out: MigrationCandidate[] = [];
  const folders = ULS_FOLDERS.map((f) => ({ dir: path.join(sourceDir, f.rel), hint: f.hint })).filter((f) => fs.existsSync(f.dir));
  const targets = folders.length ? folders : [{ dir: sourceDir, hint: null as ModelKind | null }];
  for (const { dir, hint } of targets) {
    for (const file of walk(dir)) {
      const name = path.basename(file);
      if (name.endsWith(SIDECAR) || name.startsWith(".")) continue;
      const st = fs.statSync(file);
      if (/\.(crdownload|part|tmp|download)$/i.test(name)) { out.push({ path: file, sizeBytes: st.size, inspection: emptyInspection(), suggestedKind: null, problem: "partial", originFolder: dir }); continue; }
      // extension-less files matter only at the top level of a model folder (that is where the
      // "saved the HTML page as FLUX.2-klein-4B" fakes live); deeper ones are runtime data (espeak dicts…)
      const topLevel = path.dirname(file) === dir;
      if (!WEIGHT_EXT.test(name) && !/\.(json|zip)$/i.test(name) && (path.extname(name) !== "" || !topLevel)) continue;
      if (/\.json$/i.test(name) && !topLevel) continue;
      let insp: Inspection;
      try { insp = inspectFile(file); } catch { continue; }
      const problem = insp.format === "html" ? "html" : insp.kind ? null : /\.json$/i.test(name) ? "config" : "unknown";
      out.push({ path: file, sizeBytes: st.size, inspection: insp, suggestedKind: insp.kind ?? (problem ? null : hint), problem, originFolder: dir });
    }
  }
  return out;
}

function emptyInspection(): Inspection { return { format: "unknown", kind: null, role: "unknown", arch: null, name: null, quant: null, params: null, contextLength: null, vision: false, embedding: false, notes: [] }; }

/** Default place to look for an existing ULS install: next to this Studio. */
export function defaultMigrationSources(paths: Paths): string[] {
  const parent = path.dirname(paths.root);
  const cands = [path.join(parent, "Uncensored-Local-Studio-main"), path.join(parent, "Uncensored-Local-Studio"), path.join(parent, "Uncensored-AI-Studio")];
  return cands.filter((c) => fs.existsSync(c));
}
