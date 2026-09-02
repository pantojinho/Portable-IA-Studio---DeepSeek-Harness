import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { bus } from "./events.js";
import type { JobInfo } from "./jobs.js";
import type { Paths } from "./paths.js";
import { logger } from "./log.js";

const log = logger("jobs");

/**
 * CORE-01. Job history in data/jobs.sqlite so a restart does not erase what the user asked for.
 * Jobs that were running when the process died are marked failed on the next boot — the Studio
 * never pretends a download finished.
 */
export class JobStore {
  private db: DatabaseSync;

  constructor(paths: Paths) {
    this.db = openDatabase(path.join(paths.data, "jobs.sqlite"), [
      {
        id: 1,
        sql: `CREATE TABLE jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0, message TEXT, createdAt INTEGER NOT NULL,
                startedAt INTEGER, endedAt INTEGER, error TEXT, result TEXT, meta TEXT);
              CREATE INDEX jobs_created ON jobs(createdAt DESC);`,
      },
    ]);
  }

  /** Mirror every job event into the table. Returns an unsubscribe function. */
  attach(): () => void {
    return bus.subscribe("job", (ev) => {
      try { this.record(ev.data as JobInfo); } catch (e) { log.debug(`jobstore: ${(e as Error).message}`); }
    });
  }

  record(j: JobInfo): void {
    this.db.prepare(
      `INSERT INTO jobs (id, kind, title, status, progress, message, createdAt, startedAt, endedAt, error, result, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, progress=excluded.progress, message=excluded.message,
         startedAt=excluded.startedAt, endedAt=excluded.endedAt, error=excluded.error, result=excluded.result`,
    ).run(j.id, j.kind, j.title, j.status, j.progress, j.message ?? "", j.createdAt, j.startedAt ?? null, j.endedAt ?? null,
      j.error ?? null, j.result === undefined ? null : safeJson(j.result), j.meta ? safeJson(j.meta) : null);
  }

  /** Anything left "running"/"queued" from a previous process is dead. */
  recoverOrphans(): number {
    const r = this.db.prepare(
      `UPDATE jobs SET status='failed', error='interrompido por reinício do Studio', endedAt=?
       WHERE status IN ('running','queued')`).run(Date.now());
    const n = Number(r.changes ?? 0);
    if (n) log.warn(`${n} trabalho(s) ficaram pela metade no desligamento anterior e foram marcados como falhos.`);
    return n;
  }

  history(limit = 100, kind?: string): JobInfo[] {
    const rows = (kind
      ? this.db.prepare("SELECT * FROM jobs WHERE kind=? ORDER BY createdAt DESC LIMIT ?").all(kind, limit)
      : this.db.prepare("SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?").all(limit)) as Record<string, unknown>[];
    return rows.map(toInfo);
  }

  get(id: string): JobInfo | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? toInfo(row) : null;
  }

  /** Keep the table small: drop finished jobs older than `days`. */
  prune(days = 30): number {
    const r = this.db.prepare("DELETE FROM jobs WHERE endedAt IS NOT NULL AND endedAt < ?").run(Date.now() - days * 86_400_000);
    return Number(r.changes ?? 0);
  }

  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}

function toInfo(row: Record<string, unknown>): JobInfo {
  return {
    id: String(row.id), kind: String(row.kind), title: String(row.title), status: row.status as JobInfo["status"],
    progress: Number(row.progress ?? 0), message: String(row.message ?? ""), createdAt: Number(row.createdAt),
    startedAt: row.startedAt == null ? undefined : Number(row.startedAt),
    endedAt: row.endedAt == null ? undefined : Number(row.endedAt),
    error: row.error == null ? undefined : String(row.error),
    result: row.result == null ? undefined : parse(String(row.result)),
    meta: row.meta == null ? undefined : (parse(String(row.meta)) as Record<string, unknown>),
  };
}

function parse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
function safeJson(v: unknown): string { try { return JSON.stringify(v) ?? "null"; } catch { return '"[não serializável]"'; } }
