import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { StudioContext } from "../core/context.js";
import type { JobInfo } from "../core/jobs.js";
import { openDatabase, loadVectorExtension } from "../core/db.js";
import { logger } from "../core/log.js";
import type { Project, SourceFile, SourceStatus } from "./types.js";
import { detectFile } from "./extract/index.js";

const log = logger("projects");

/** DOC-01. index.sqlite schema. New versions append migrations; nothing is ever dropped. */
const MIGRATIONS = [
  {
    id: 1,
    sql: `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, sizeBytes INTEGER,
        sha256 TEXT, addedAt TEXT, status TEXT, error TEXT, pages INTEGER,
        markdown TEXT, ocrJson TEXT, transcript TEXT, docType TEXT, fields TEXT, validation TEXT);
      CREATE INDEX sources_sha ON sources(sha256);
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, ordinal INTEGER, text TEXT NOT NULL,
        locator TEXT, tokens INTEGER, embedding BLOB, dim INTEGER);
      CREATE INDEX chunks_source ON chunks(sourceId);
      CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE memory (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT, sourceId TEXT, createdAt TEXT, pinned INTEGER DEFAULT 0);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`,
  },
];

export class ProjectService {
  private dbs = new Map<string, DatabaseSync>();
  private watchers = new Map<string, fs.FSWatcher[]>();

  constructor(private ctx: StudioContext) {}

  // --------------------------------------------------------------- paths ---
  dir(id: string): string {
    const dir = path.join(this.ctx.paths.projects, id);
    if (!dir.startsWith(this.ctx.paths.projects)) throw new Error("identificador de projeto inválido");
    return dir;
  }
  sourcesDir(id: string): string { return path.join(this.dir(id), "sources"); }
  derivedDir(id: string): string { return path.join(this.dir(id), "derived"); }
  chatsDir(id: string): string { return path.join(this.dir(id), "chats"); }
  memoryFile(id: string): string { return path.join(this.dir(id), "memory.md"); }

  // ------------------------------------------------------------ projects ---
  list(): Project[] {
    const out: Project[] = [];
    for (const name of safeReaddir(this.ctx.paths.projects)) {
      const file = path.join(this.ctx.paths.projects, name, "project.json");
      if (!fs.existsSync(file)) continue;
      try { out.push(this.withStats(JSON.parse(fs.readFileSync(file, "utf8")) as Project)); } catch { /* pasta pela metade */ }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project | null {
    const file = path.join(this.dir(id), "project.json");
    if (!fs.existsSync(file)) return null;
    try { return this.withStats(JSON.parse(fs.readFileSync(file, "utf8")) as Project); } catch { return null; }
  }

  require(id: string): Project {
    const p = this.get(id);
    if (!p) throw new Error(`projeto '${id}' não existe`);
    return p;
  }

  create(input: { name: string; id?: string; watch?: string[]; settings?: Partial<Project["settings"]> }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("informe o nome do projeto");
    let id = slugify(input.id ?? name);
    if (fs.existsSync(this.dir(id))) id = `${id}-${randomUUID().slice(0, 4)}`;
    const now = new Date().toISOString();
    const project: Project = {
      id, name, createdAt: now, updatedAt: now, watch: input.watch ?? [],
      settings: {
        embeddingModel: input.settings?.embeddingModel ?? this.ctx.config.documents.embeddingModel,
        rerankModel: input.settings?.rerankModel ?? this.ctx.config.documents.rerankModel,
        ocrModel: input.settings?.ocrModel ?? this.ctx.config.documents.ocrModel,
        chunkTokens: input.settings?.chunkTokens ?? this.ctx.config.documents.chunkTokens,
        chunkOverlap: input.settings?.chunkOverlap ?? this.ctx.config.documents.chunkOverlap,
        language: input.settings?.language ?? "pt-BR",
      },
      stats: { sources: 0, chunks: 0, lastIngestAt: null },
    };
    for (const d of [this.dir(id), this.sourcesDir(id), this.derivedDir(id), this.chatsDir(id)]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(this.memoryFile(id), `# Memória do projeto ${name}\n\nO que o Studio aprender sobre este projeto fica aqui. Você pode editar à mão.\n`);
    this.save(project);
    this.db(id); // cria o índice já na criação
    log.info(`projeto criado: ${id}`);
    return project;
  }

  update(id: string, patch: Partial<Pick<Project, "name" | "watch">> & { settings?: Partial<Project["settings"]> }): Project {
    const p = this.require(id);
    if (patch.name?.trim()) p.name = patch.name.trim();
    if (patch.watch) p.watch = patch.watch;
    if (patch.settings) p.settings = { ...p.settings, ...patch.settings };
    p.updatedAt = new Date().toISOString();
    this.save(p);
    return p;
  }

  /** Never `rm -rf` on user data: the folder moves to data/trash (AGENTS.md §2.5). */
  delete(id: string): { trash: string } {
    this.require(id);
    this.closeDb(id);
    this.unwatch(id);
    const trash = path.join(this.ctx.paths.data, "trash", `${id}-${Date.now()}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(this.dir(id), trash);
    log.info(`projeto ${id} movido para ${trash}`);
    return { trash };
  }

  private save(p: Project): void {
    fs.mkdirSync(this.dir(p.id), { recursive: true });
    fs.writeFileSync(path.join(this.dir(p.id), "project.json"), JSON.stringify(p, null, 2));
  }

  private withStats(p: Project): Project {
    try {
      const db = this.db(p.id);
      p.stats = {
        sources: Number((db.prepare("SELECT count(*) c FROM sources").get() as { c: number }).c),
        chunks: Number((db.prepare("SELECT count(*) c FROM chunks").get() as { c: number }).c),
        lastIngestAt: (db.prepare("SELECT value FROM meta WHERE key='lastIngestAt'").get() as { value?: string } | undefined)?.value ?? null,
      };
    } catch { /* índice ainda não criado */ }
    return p;
  }

  // ------------------------------------------------------------ database ---
  db(id: string): DatabaseSync {
    const live = this.dbs.get(id);
    if (live) return live;
    const db = openDatabase(path.join(this.dir(id), "index.sqlite"), MIGRATIONS);
    loadVectorExtension(db, this.ctx.paths.engines);  // opcional: sem ela a busca vetorial roda em JS
    this.dbs.set(id, db);
    return db;
  }

  closeDb(id: string): void {
    const db = this.dbs.get(id);
    if (!db) return;
    try { db.close(); } catch { /* já fechado */ }
    this.dbs.delete(id);
  }

  closeAll(): void { for (const id of [...this.dbs.keys()]) this.closeDb(id); }

  setMeta(id: string, key: string, value: string): void {
    this.db(id).prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  // ------------------------------------------------------------- sources ---
  sources(id: string, status?: SourceStatus): SourceFile[] {
    const rows = (status
      ? this.db(id).prepare("SELECT * FROM sources WHERE status=? ORDER BY addedAt DESC").all(status)
      : this.db(id).prepare("SELECT * FROM sources ORDER BY addedAt DESC").all()) as Record<string, unknown>[];
    return rows.map((r) => rowToSource(id, r));
  }

  source(id: string, sourceId: string): SourceFile | null {
    const row = this.db(id).prepare("SELECT * FROM sources WHERE id=?").get(sourceId) as Record<string, unknown> | undefined;
    return row ? rowToSource(id, row) : null;
  }

  /** Copy files into the project (never move the user's originals) and register them. */
  async addSourceFiles(id: string, files: string[], o: { ingest?: boolean; move?: boolean } = {}): Promise<{ sources: SourceFile[]; job?: JobInfo }> {
    this.require(id);
    fs.mkdirSync(this.sourcesDir(id), { recursive: true });
    const added: SourceFile[] = [];
    for (const src of files) {
      if (!fs.existsSync(src)) { log.warn(`arquivo não encontrado: ${src}`); continue; }
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        const inner = fs.readdirSync(src).map((n) => path.join(src, n)).filter((p) => fs.statSync(p).isFile());
        const r = await this.addSourceFiles(id, inner, { ...o, ingest: false });
        added.push(...r.sources);
        continue;
      }
      const dest = uniquePath(path.join(this.sourcesDir(id), path.basename(src)));
      if (o.move) fs.renameSync(src, dest); else fs.copyFileSync(src, dest);
      added.push(this.register(id, dest));
    }
    const job = o.ingest === false ? undefined : this.ingest(id, { sourceIds: added.map((s) => s.id) });
    return { sources: added, job };
  }

  /** Save an upload straight into the project. */
  addUpload(id: string, name: string, data: Buffer): SourceFile {
    this.require(id);
    fs.mkdirSync(this.sourcesDir(id), { recursive: true });
    const dest = uniquePath(path.join(this.sourcesDir(id), path.basename(name).replace(/[/\\]/g, "_")));
    fs.writeFileSync(dest, data);
    return this.register(id, dest);
  }

  register(id: string, file: string): SourceFile {
    const stat = fs.statSync(file);
    const sha = sha256File(file);
    const db = this.db(id);
    const existing = db.prepare("SELECT * FROM sources WHERE sha256=?").get(sha) as Record<string, unknown> | undefined;
    if (existing) {
      // same bytes already here: keep one copy (the duplicate upload is removed)
      if (path.resolve(String(existing.path)) !== path.resolve(file)) { try { fs.unlinkSync(file); } catch { /* */ } }
      return rowToSource(id, existing);
    }
    const detected = detectFile(file);
    const source: SourceFile = {
      id: randomUUID(), projectId: id, path: file, name: path.basename(file), mime: detected.mime,
      sizeBytes: stat.size, sha256: sha, addedAt: new Date().toISOString(), status: "queued", derived: {},
    };
    db.prepare(`INSERT INTO sources (id, path, name, mime, sizeBytes, sha256, addedAt, status) VALUES (?,?,?,?,?,?,?,?)`)
      .run(source.id, source.path, source.name, source.mime, source.sizeBytes, source.sha256, source.addedAt, source.status);
    return source;
  }

  updateSource(id: string, sourceId: string, patch: Partial<SourceFile> & { markdown?: string; ocrJson?: string; transcript?: string }): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null | undefined) => { if (v !== undefined) { sets.push(`${col}=?`); values.push(v); } };
    put("status", patch.status);
    put("error", patch.error ?? null);
    put("pages", patch.pages ?? null);
    put("docType", patch.docType ?? null);
    put("markdown", patch.derived?.markdown ?? patch.markdown);
    put("ocrJson", patch.derived?.ocrJson ?? patch.ocrJson);
    put("transcript", patch.derived?.transcript ?? patch.transcript);
    if (patch.fields !== undefined) { sets.push("fields=?"); values.push(JSON.stringify(patch.fields)); }
    if (patch.validation !== undefined) { sets.push("validation=?"); values.push(JSON.stringify(patch.validation)); }
    if (!sets.length) return;
    values.push(sourceId);
    this.db(id).prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id=?`).run(...values);
  }

  /** Removes the source, its chunks and its derived files — inside the project only. */
  removeSource(id: string, sourceId: string): boolean {
    const s = this.source(id, sourceId);
    if (!s) return false;
    const db = this.db(id);
    // o FTS primeiro: a subconsulta lê `chunks`, então apagar os chunks antes deixaria o texto
    // do documento para sempre no índice
    db.prepare("DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE sourceId=?)").run(sourceId);
    db.prepare("DELETE FROM chunks WHERE sourceId=?").run(sourceId);
    db.prepare("DELETE FROM sources WHERE id=?").run(sourceId);
    for (const f of [s.path, s.derived.markdown, s.derived.ocrJson, s.derived.transcript]) {
      if (f && fs.existsSync(f) && f.startsWith(this.dir(id))) fs.rmSync(f, { force: true });
    }
    return true;
  }

  // ------------------------------------------------------------- ingest ---
  ingest(id: string, o: { sourceIds?: string[]; force?: boolean } = {}): JobInfo {
    const project = this.require(id);
    return this.ctx.jobs.create("ingest", `Ler documentos de ${project.name}`, async (job) => {
      const { ingestSources } = await import("./ingest.js");
      return ingestSources(this.ctx, id, { ...o, job });
    }, { projectId: id, sourceIds: o.sourceIds });
  }

  // -------------------------------------------------------- folder watch ---
  /** DOC-08 (folder connector): new files in a watched folder are ingested automatically. */
  watch(id: string): void {
    const p = this.require(id);
    this.unwatch(id);
    const handlers: fs.FSWatcher[] = [];
    for (const folder of p.watch) {
      if (!fs.existsSync(folder)) { log.warn(`pasta monitorada não existe: ${folder}`); continue; }
      let timer: NodeJS.Timeout | null = null;
      const pending = new Set<string>();
      const watcher = fs.watch(folder, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const file = path.join(folder, filename.toString());
        pending.add(file);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...pending].filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
          pending.clear();
          if (files.length) void this.addSourceFiles(id, files, { ingest: true }).catch((e: Error) => log.warn(`ingestão automática: ${e.message}`));
        }, 2000);
      });
      handlers.push(watcher);
      log.info(`monitorando ${folder} para o projeto ${id}`);
    }
    this.watchers.set(id, handlers);
  }

  unwatch(id: string): void {
    for (const w of this.watchers.get(id) ?? []) { try { w.close(); } catch { /* já fechado */ } }
    this.watchers.delete(id);
  }

  watchAll(): void { for (const p of this.list()) if (p.watch.length) this.watch(p.id); }
}

// ------------------------------------------------------------- helpers ---

export function rowToSource(projectId: string, r: Record<string, unknown>): SourceFile {
  return {
    id: String(r.id), projectId, path: String(r.path), name: String(r.name), mime: String(r.mime ?? ""),
    sizeBytes: Number(r.sizeBytes ?? 0), sha256: String(r.sha256 ?? ""), addedAt: String(r.addedAt ?? ""),
    status: (r.status as SourceStatus) ?? "queued",
    error: r.error == null ? undefined : String(r.error),
    pages: r.pages == null ? undefined : Number(r.pages),
    derived: {
      markdown: r.markdown == null ? undefined : String(r.markdown),
      ocrJson: r.ocrJson == null ? undefined : String(r.ocrJson),
      transcript: r.transcript == null ? undefined : String(r.transcript),
    },
    docType: r.docType == null ? undefined : String(r.docType),
    fields: r.fields == null ? undefined : safeParse(String(r.fields)) as Record<string, unknown>,
    validation: r.validation == null ? undefined : safeParse(String(r.validation)) as SourceFile["validation"],
  };
}

export function slugify(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "projeto";
}

export function uniquePath(dest: string): string {
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }
