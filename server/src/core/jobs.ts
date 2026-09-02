import { randomUUID } from "node:crypto";
import { bus } from "./events.js";
import { logger } from "./log.js";

const log = logger("jobs");

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  progress: number;       // 0..1, or -1 when unknown
  message: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  result?: unknown;
  meta?: Record<string, unknown>;
}

export interface JobContext {
  id: string;
  signal: AbortSignal;
  setProgress(progress: number, message?: string): void;
  setMessage(message: string): void;
  log: ReturnType<typeof logger>;
}

interface Internal {
  info: JobInfo;
  controller: AbortController;
  run: (ctx: JobContext) => Promise<unknown>;
}

/**
 * Minimal job queue with per-kind concurrency. Long work (downloads, OCR,
 * generation, ingestion) runs here so the API stays non-blocking and the UI
 * can follow progress over SSE.
 */
export class JobManager {
  private jobs = new Map<string, Internal>();
  private running = new Map<string, number>();
  private limits: Record<string, number>;

  constructor(limits: Record<string, number> = {}) {
    this.limits = { default: 2, ...limits };
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => j.info).sort((a, b) => b.createdAt - a.createdAt);
  }
  get(id: string): JobInfo | undefined { return this.jobs.get(id)?.info; }

  create(kind: string, title: string, run: (ctx: JobContext) => Promise<unknown>, meta?: Record<string, unknown>): JobInfo {
    const id = randomUUID();
    const info: JobInfo = { id, kind, title, status: "queued", progress: 0, message: "Na fila", createdAt: Date.now(), meta };
    this.jobs.set(id, { info, controller: new AbortController(), run });
    this.emit(info);
    queueMicrotask(() => this.pump(kind));
    return info;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.info.status === "queued") {
      j.info.status = "cancelled"; j.info.endedAt = Date.now(); j.info.message = "Cancelado";
      this.emit(j.info);
      return true;
    }
    if (j.info.status === "running") { j.controller.abort(); return true; }
    return false;
  }

  /** Remove finished jobs older than `ms`. */
  prune(ms = 6 * 3600_000): void {
    const cutoff = Date.now() - ms;
    for (const [id, j] of this.jobs) {
      if (j.info.endedAt && j.info.endedAt < cutoff) this.jobs.delete(id);
    }
  }

  private limitFor(kind: string): number { return this.limits[kind] ?? this.limits.default ?? 2; }

  private pump(kind: string): void {
    const active = this.running.get(kind) ?? 0;
    if (active >= this.limitFor(kind)) return;
    const next = [...this.jobs.values()].find((j) => j.info.kind === kind && j.info.status === "queued");
    if (!next) return;
    this.running.set(kind, active + 1);
    void this.execute(next).finally(() => {
      this.running.set(kind, (this.running.get(kind) ?? 1) - 1);
      this.pump(kind);
    });
    this.pump(kind);
  }

  private async execute(j: Internal): Promise<void> {
    const { info, controller } = j;
    info.status = "running"; info.startedAt = Date.now(); info.message = "Executando";
    this.emit(info);
    const ctx: JobContext = {
      id: info.id,
      signal: controller.signal,
      log: logger(`job:${info.kind}`),
      setProgress: (p, m) => { info.progress = p; if (m !== undefined) info.message = m; this.emit(info); },
      setMessage: (m) => { info.message = m; this.emit(info); },
    };
    try {
      info.result = await j.run(ctx);
      if (controller.signal.aborted) throw new Error("cancelled");
      info.status = "done"; info.progress = 1; info.message = "Concluído";
    } catch (err) {
      const e = err as Error;
      if (controller.signal.aborted || e.message === "cancelled") {
        info.status = "cancelled"; info.message = "Cancelado";
      } else {
        info.status = "failed"; info.error = e.message ?? String(err); info.message = info.error;
        log.error(`${info.kind} "${info.title}" falhou: ${info.error}`);
      }
    } finally {
      info.endedAt = Date.now();
      this.emit(info);
    }
  }

  private emit(info: JobInfo): void { bus.publish("job", { ...info }); }
}
