import fs from "node:fs";
import path from "node:path";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import type { PlannedFile } from "./types.js";
import type { DownloadOptions, DownloadProgress } from "./downloader.js";
import { DownloadError, fmt } from "./downloader.js";
import { headLooksValid } from "./inspect.js";

const log = logger("download");

/**
 * MOD-07. Several byte ranges at the same time, behind the same `downloadFile` signature.
 * It only kicks in when it can actually help — a big file, a server that advertises `Range`, and
 * more than one chunk configured — because on most home links a single stream already saturates the
 * CDN and one stream keeps resume trivial. Chunks are written straight into the `.part` file at
 * their offset, and a small `.part.json` records which ones finished, so a broken run resumes
 * without re-downloading what already landed.
 */
export const MIN_PARALLEL_BYTES = 64 * 1024 * 1024;

export interface ParallelDecision { parallel: boolean; chunks: number; reason: string }

export function decideParallel(o: { totalBytes: number | null; acceptRanges: boolean; configuredChunks: number; alreadyOnDisk: number }): ParallelDecision {
  if (o.configuredChunks <= 1) return { parallel: false, chunks: 1, reason: "configuração pede uma conexão só" };
  if (!o.acceptRanges) return { parallel: false, chunks: 1, reason: "o servidor não aceita Range" };
  if (!o.totalBytes) return { parallel: false, chunks: 1, reason: "tamanho desconhecido" };
  if (o.totalBytes < MIN_PARALLEL_BYTES) return { parallel: false, chunks: 1, reason: `arquivo pequeno (${fmt(o.totalBytes)})` };
  // one chunk per ~32 MiB, never more than configured
  const chunks = Math.max(2, Math.min(o.configuredChunks, Math.ceil(o.totalBytes / (32 * 1024 * 1024))));
  return { parallel: true, chunks, reason: `${chunks} conexões para ${fmt(o.totalBytes)}` };
}

export interface ChunkRange { index: number; start: number; end: number }

export function splitRanges(total: number, chunks: number): ChunkRange[] {
  const size = Math.ceil(total / chunks);
  const out: ChunkRange[] = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * size;
    if (start >= total) break;
    out.push({ index: i, start, end: Math.min(total, start + size) - 1 });
  }
  return out;
}

interface PartState { url: string; total: number; chunkSize: number; done: number[] }

function stateFile(tmp: string): string { return `${tmp}.json`; }

export function readState(tmp: string, url: string, total: number, chunkSize: number): PartState {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(tmp), "utf8")) as PartState;
    if (s.url === url && s.total === total && s.chunkSize === chunkSize && Array.isArray(s.done)) return s;
  } catch { /* sem estado: começa do zero */ }
  return { url, total, chunkSize, done: [] };
}

function writeState(tmp: string, state: PartState): void {
  try { fs.writeFileSync(stateFile(tmp), JSON.stringify(state)); } catch { /* estado é otimização, não pode derrubar o download */ }
}

/**
 * A `.part` written by a previous parallel run is full-size but may be full of holes: the state file
 * is the only truth about what really landed. Returns null when there is nothing pending.
 */
export function pendingChunks(tmp: string, url: string): { total: number; chunkSize: number; chunks: number } | null {
  if (!fs.existsSync(stateFile(tmp)) || !fs.existsSync(tmp)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(tmp), "utf8")) as PartState;
    if (s.url !== url || !s.total || !s.chunkSize) return null;
    const chunks = Math.ceil(s.total / s.chunkSize);
    return (s.done ?? []).length >= chunks ? null : { total: s.total, chunkSize: s.chunkSize, chunks };
  } catch { return null; }
}

export function clearState(tmp: string): void { try { fs.unlinkSync(stateFile(tmp)); } catch { /* já não existia */ } }

/**
 * Downloads `file` into `tmp` using `chunks` parallel ranges. Returns the number of bytes written.
 * Validation (sniffing, hashing, rename) stays in downloadFile — this only fills the file.
 */
export async function downloadInChunks(
  file: PlannedFile, tmp: string, total: number, chunks: number, opts: DownloadOptions & { headers?: Record<string, string> },
): Promise<number> {
  const ranges = splitRanges(total, chunks);
  const chunkSize = ranges[0] ? ranges[0].end - ranges[0].start + 1 : total;
  const state = readState(tmp, file.url, total, chunkSize);
  const done = new Set(state.done);

  // pre-allocate so every writer can seek to its own offset
  const fd = fs.openSync(tmp, fs.existsSync(tmp) ? "r+" : "w+");
  try {
    if (fs.fstatSync(fd).size !== total) fs.ftruncateSync(fd, total);

    let received = [...done].reduce((a, i) => a + rangeSize(ranges, i), 0);
    let lastReport = Date.now();
    let lastBytes = received;
    let speed = 0;
    const report = (phase: DownloadProgress["phase"] = "downloading") => {
      const prog: DownloadProgress = { filename: file.filename, received, total, speedBps: speed, etaSec: speed > 0 ? Math.round((total - received) / speed) : null, phase };
      opts.onProgress?.(prog);
      bus.publish("download.progress", prog);
    };
    report("connecting");

    let sniffed = false;
    const queue = ranges.filter((r) => !done.has(r.index));
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (opts.signal?.aborted) throw new DownloadError("cancelado", "cancelled");
        const range = queue[next++];
        if (!range) return;
        const headers = { ...(opts.headers ?? {}), range: `bytes=${range.start}-${range.end}` };
        const res = await fetch(file.url, { headers, signal: opts.signal, redirect: "follow" });
        if (res.status !== 206 || !res.body) {
          throw new DownloadError(`${file.filename}: o servidor parou de aceitar Range no meio (HTTP ${res.status}).`, "http");
        }
        let offset = range.start;
        for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
          if (!sniffed && range.index === 0 && offset === 0 && buf.length >= 512) {
            const v = headLooksValid(buf.subarray(0, 4096), path.extname(file.filename));
            if (!v.ok) throw new DownloadError(`${file.filename}: ${v.reason}. Download abortado antes de gravar lixo no disco.`, v.reason?.includes("HTML") ? "html" : "type");
            sniffed = true;
          }
          fs.writeSync(fd, buf, 0, buf.length, offset);
          offset += buf.length;
          received += buf.length;
          const now = Date.now();
          if (now - lastReport >= 500) {
            speed = ((received - lastBytes) * 1000) / (now - lastReport);
            lastReport = now; lastBytes = received;
            report();
          }
        }
        if (offset !== range.end + 1) {
          throw new DownloadError(`${file.filename}: pedaço ${range.index} veio incompleto (${fmt(offset - range.start)} de ${fmt(range.end - range.start + 1)}). Rode de novo para retomar.`, "incomplete");
        }
        done.add(range.index);
        state.done = [...done];
        writeState(tmp, state);
      }
    };

    await Promise.all(Array.from({ length: Math.min(chunks, queue.length) }, () => worker()));
    fs.fsyncSync(fd);
    log.info(`${file.filename}: ${ranges.length} pedaço(s) em paralelo, ${fmt(total)}`);
    clearState(tmp);
    return total;
  } finally {
    fs.closeSync(fd);
  }
}

function rangeSize(ranges: ChunkRange[], index: number): number {
  const r = ranges.find((x) => x.index === index);
  return r ? r.end - r.start + 1 : 0;
}
