import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { osArch, platform } from "./system.js";
import { logger } from "./log.js";

const log = logger("db");

/**
 * DOC-00. One SQLite helper for the whole Studio (jobs history, project indexes).
 * `node:sqlite` ships with Node 24 — no native npm module, no build step (AGENTS.md §2.3).
 * FTS5 is compiled into that build; vectors use the optional `sqlite-vec` extension when it is
 * present in engines/sqlite-ext/<os-arch>/ and fall back to a JS cosine scan otherwise, so a
 * fresh portable copy indexes and searches without downloading anything.
 */
export interface Migration { id: number; sql: string }

export function openDatabase(file: string, migrations: Migration[] = []): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, migrations);
  return db;
}

export function migrate(db: DatabaseSync, migrations: Migration[]): number {
  const cur = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
  let applied = cur;
  for (const m of migrations.slice().sort((a, b) => a.id - b.id)) {
    if (m.id <= applied) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.id}`);
      db.exec("COMMIT");
      applied = m.id;
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migração ${m.id} falhou: ${(e as Error).message}`);
    }
  }
  return applied;
}

/** Filename of the sqlite-vec extension for this platform (no suffix is also accepted by SQLite). */
export function vecExtensionPath(enginesDir: string): string | null {
  const ext = platform() === "win" ? "dll" : platform() === "mac" ? "dylib" : "so";
  const p = path.join(enginesDir, "sqlite-ext", osArch(), `vec0.${ext}`);
  return fs.existsSync(p) ? p : null;
}

/** Returns true when vector search can run inside SQLite (vec0 virtual tables available). */
export function loadVectorExtension(db: DatabaseSync, enginesDir: string): boolean {
  const p = vecExtensionPath(enginesDir);
  if (!p) return false;
  try {
    db.loadExtension(p);
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _vec_probe USING vec0(v float[2])");
    db.exec("DROP TABLE _vec_probe");
    return true;
  } catch (e) {
    log.warn(`sqlite-vec não carregou (${(e as Error).message}); usando busca vetorial em JS`);
    return false;
  }
}

export function packVector(v: Float32Array | number[]): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
}

export function unpackVector(b: Uint8Array | ArrayBuffer): Float32Array {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { const x = a[i]!, y = b[i]!; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** FTS5 MATCH is a query language: quote every term so user text never becomes syntax. */
export function ftsQuery(text: string): string {
  const terms = text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
