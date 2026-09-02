import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { headLooksValid, inspectFile } from "./inspect.js";
import type { PlannedFile, Inspection } from "./types.js";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import { decideParallel, downloadInChunks, pendingChunks } from "./parallel.js";

const log = logger("download");

export interface DownloadOptions {
  headers?: Record<string, string>;
  /** MOD-07: how many ranges may travel at once (1 = classic single stream) */
  parallelChunks?: number;
  signal?: AbortSignal;
  /** bytes/sec cap; null = unlimited */
  maxSpeed?: number | null;
  onProgress?: (p: DownloadProgress) => void;
}

export interface DownloadProgress {
  filename: string;
  received: number;
  total: number | null;
  speedBps: number;
  etaSec: number | null;
  phase: "connecting" | "downloading" | "verifying" | "done";
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string | null;
  verified: boolean;      // sha matched (or no sha to compare)
  inspection: Inspection;
  resumed: boolean;
}

export class DownloadError extends Error {
  constructor(message: string, public code: "html" | "type" | "http" | "hash" | "incomplete" | "cancelled" | "io" | "network") { super(message); }
}

/**
 * Download one file to `destPath` with:
 *  - `.part` temp file and atomic rename
 *  - resume via HTTP Range when the server supports it
 *  - early rejection of HTML / wrong-format responses (first 4 KB are sniffed)
 *  - streaming sha256 compared with the expected hash
 * MOD-07: when the file is big, the server accepts Range and the user asked for more than one
 * chunk (`downloads.parallelChunks`), the transfer is split across parallel ranges by
 * models/parallel.ts — same signature, same validation, same resume.
 */
export async function downloadFile(file: PlannedFile, destPath: string, opts: DownloadOptions = {}): Promise<DownloadResult> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + ".part";
  const ext = path.extname(file.filename) || path.extname(new URL(file.url).pathname);
  let offset = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const expected = file.sizeBytes ?? null;
  if (expected && offset > expected) { fs.unlinkSync(tmp); offset = 0; }
  // MOD-07: um .part de uma execução em paralelo tem o tamanho final mas pode estar furado;
  // quem manda é o arquivo de estado.
  const pending = pendingChunks(tmp, file.url);
  if (!pending && expected && offset === expected && offset > 4096) {
    // previous run finished writing but not verifying
    return finalize(file, tmp, destPath, expected, null, true, opts);
  }
  const report = (p: Partial<DownloadProgress>) => {
    const prog: DownloadProgress = { filename: file.filename, received: offset, total: expected, speedBps: 0, etaSec: null, phase: "downloading", ...p };
    opts.onProgress?.(prog);
    bus.publish("download.progress", prog);
  };
  report({ phase: "connecting" });

  // identity encoding: content-length must equal the bytes we count (gzip would break the size check)
  const headers: Record<string, string> = { "user-agent": "AI-Studio/0.1", accept: "*/*", "accept-encoding": "identity", ...(opts.headers ?? {}) };
  if (offset > 0) headers.range = `bytes=${offset}-`;

  if (pending) {
    log.info(`${file.filename}: retomando ${pending.chunks} pedaço(s) da execução anterior`);
    const bytes = await downloadInChunks(file, tmp, pending.total, pending.chunks, { ...opts, headers: { ...headers, range: undefined as unknown as string } });
    return finalize(file, tmp, destPath, bytes, null, true, opts);
  }

  // MOD-07: vale a pena abrir várias conexões? (arquivo grande + servidor com Range + configuração)
  if (opts.parallelChunks && opts.parallelChunks > 1 && offset === 0) {
    const probe = await probeRange(file.url, headers, opts.signal);
    const decision = decideParallel({ totalBytes: probe.total ?? expected, acceptRanges: probe.acceptRanges, configuredChunks: opts.parallelChunks, alreadyOnDisk: offset });
    if (decision.parallel && (probe.total ?? expected)) {
      const total = (probe.total ?? expected)!;
      log.info(`${file.filename}: ${decision.reason}`);
      const bytes = await downloadInChunks(file, tmp, total, decision.chunks, { ...opts, headers });
      return finalize(file, tmp, destPath, bytes, null, false, opts);
    }
    log.debug(`${file.filename}: uma conexão só (${decision.reason})`);
  }

  let res: Response;
  try { res = await fetch(file.url, { headers, signal: opts.signal, redirect: "follow" }); }
  catch (e) {
    if (opts.signal?.aborted) throw new DownloadError("cancelado", "cancelled");
    throw new DownloadError(`Falha de rede ao baixar ${file.filename}: ${(e as Error).message}`, "network");
  }

  let resumed = false;
  if (offset > 0) {
    if (res.status === 206) resumed = true;
    else if (res.status === 200) { log.warn(`${file.filename}: servidor não suporta retomar; recomeçando`); offset = 0; }
    else throw new DownloadError(describeHttp(res, file), "http");
  } else if (res.status !== 200) {
    throw new DownloadError(describeHttp(res, file), "http");
  }

  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.startsWith("text/html")) {
    res.body?.cancel().catch(() => {});
    throw new DownloadError(`${file.url} devolveu uma página HTML, não um arquivo de modelo. Cole o link direto do arquivo (…/resolve/main/arquivo) ou o link do repositório para o Studio escolher o arquivo.`, "html");
  }
  // the server's own size wins over what the plan guessed (plans can carry a stale/wrong size)
  const serverTotal = (() => { const cl = Number(res.headers.get("content-length")); const cr = res.headers.get("content-range")?.match(/\/(\d+)$/); return cr ? Number(cr[1]) : cl ? cl + offset : null; })();
  if (expected && serverTotal && expected !== serverTotal) log.warn(`${file.filename}: plano dizia ${fmt(expected)}, servidor diz ${fmt(serverTotal)}; usando o servidor`);
  const total = serverTotal ?? expected;
  if (!res.body) throw new DownloadError("resposta sem corpo", "network");

  const hash = createHash("sha256");
  // when resuming we cannot hash the already-written prefix cheaply during the stream;
  // finalize() re-hashes the file from disk in that case.
  const hashLive = offset === 0;
  const out = fs.createWriteStream(tmp, { flags: offset > 0 ? "a" : "w" });
  let received = offset;
  let sniffed = offset > 0;
  let sniffBuf: Buffer[] = [];
  let sniffLen = 0;
  const t0 = Date.now(); let lastT = t0; let lastB = received; let speed = 0;
  const limiter = opts.maxSpeed ? makeLimiter(opts.maxSpeed) : null;

  const source = Readable.fromWeb(res.body as import("stream/web").ReadableStream<Uint8Array>);
  const inspector = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunkU8 of src) {
      const chunk = Buffer.from(chunkU8.buffer, chunkU8.byteOffset, chunkU8.byteLength);
      if (!sniffed) {
        sniffBuf.push(chunk); sniffLen += chunk.length;
        if (sniffLen >= 4096) {
          const head = Buffer.concat(sniffBuf).subarray(0, 4096);
          const v = headLooksValid(head, ext);
          if (!v.ok) throw new DownloadError(`${file.filename}: ${v.reason}. Download abortado antes de gravar lixo no disco.`, v.reason?.includes("HTML") ? "html" : "type");
          sniffed = true; sniffBuf = [];
        }
      }
      if (hashLive) hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastT >= 500) {
        speed = ((received - lastB) * 1000) / (now - lastT); lastT = now; lastB = received;
        report({ received, total, speedBps: speed, etaSec: total && speed > 0 ? Math.round((total - received) / speed) : null });
      }
      if (limiter) await limiter(chunk.length);
      yield chunk;
    }
  };
  try {
    await pipeline(source, inspector, out, { signal: opts.signal });
  } catch (e) {
    if (e instanceof DownloadError) { try { fs.unlinkSync(tmp); } catch { /* */ } throw e; }
    if (opts.signal?.aborted || (e as Error).name === "AbortError") throw new DownloadError("cancelado", "cancelled");
    throw new DownloadError(`${file.filename}: conexão interrompida (${(e as Error).message}). Rode de novo para retomar de ${fmt(received)}.`, "network");
  }
  if (!sniffed && sniffLen > 0) {
    const v = headLooksValid(Buffer.concat(sniffBuf), ext);
    if (!v.ok) { try { fs.unlinkSync(tmp); } catch { /* */ } throw new DownloadError(`${file.filename}: ${v.reason}.`, "type"); }
  }
  if (total && received !== total) throw new DownloadError(`${file.filename}: incompleto (${fmt(received)} de ${fmt(total)}). Rode de novo para retomar.`, "incomplete");
  return finalize(file, tmp, destPath, received, hashLive ? hash.digest("hex") : null, resumed, opts);
}

async function finalize(file: PlannedFile, tmp: string, destPath: string, bytes: number, liveSha: string | null, resumed: boolean, opts: DownloadOptions): Promise<DownloadResult> {
  opts.onProgress?.({ filename: file.filename, received: bytes, total: bytes, speedBps: 0, etaSec: null, phase: "verifying" });
  let sha = liveSha;
  if (!sha && (file.sha256 || bytes < 8 * 1024 ** 3)) sha = await hashFile(tmp, opts.signal);
  if (file.sha256 && sha && sha !== file.sha256.toLowerCase()) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    throw new DownloadError(`${file.filename}: hash SHA-256 não confere (esperado ${file.sha256.slice(0, 12)}…, obtido ${sha.slice(0, 12)}…). Arquivo descartado; tente de novo.`, "hash");
  }
  const inspection = inspectFile(tmp);
  if (inspection.format === "html") { try { fs.unlinkSync(tmp); } catch { /* */ } throw new DownloadError(`${file.filename} é uma página HTML, não um modelo.`, "html"); }
  await replaceWithRetry(tmp, destPath);
  const result: DownloadResult = { path: destPath, bytes, sha256: sha, verified: !file.sha256 || sha === file.sha256.toLowerCase(), inspection, resumed };
  opts.onProgress?.({ filename: file.filename, received: bytes, total: bytes, speedBps: 0, etaSec: null, phase: "done" });
  bus.publish("download.done", { filename: file.filename, path: destPath, bytes });
  return result;
}

export async function hashFile(p: string, signal?: AbortSignal): Promise<string> {
  const h = createHash("sha256");
  await pipeline(fs.createReadStream(p, { highWaterMark: 4 << 20 }), async function* (src) { for await (const c of src) { h.update(c as Buffer); yield; } }, { signal });
  return h.digest("hex");
}

async function replaceWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i === 5) throw new DownloadError(`não consegui gravar ${path.basename(to)}: ${(e as Error).message}`, "io"); await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
}

function makeLimiter(bps: number) {
  let allowance = bps; let last = Date.now();
  return async (n: number) => {
    const now = Date.now(); allowance = Math.min(bps, allowance + ((now - last) / 1000) * bps); last = now;
    allowance -= n;
    if (allowance < 0) await new Promise((r) => setTimeout(r, (-allowance / bps) * 1000));
  };
}

function describeHttp(res: Response, file: PlannedFile): string {
  const code = res.headers.get("x-error-code");
  if (code === "GatedRepo" || res.status === 401 || res.status === 403) return `${file.filename}: acesso negado (HTTP ${res.status}). Repositório gated ou privado: aceite a licença no Hugging Face e informe seu token nas configurações.`;
  if (res.status === 404) return `${file.filename}: arquivo não encontrado (HTTP 404). O link pode estar errado ou o arquivo foi removido.`;
  if (res.status === 416) return `${file.filename}: o arquivo parcial no disco é maior que o remoto; apague o .part e tente de novo.`;
  return `${file.filename}: HTTP ${res.status} ${res.statusText}`;
}

/** One cheap request to learn the size and whether the server slices (HEAD, falling back to Range). */
async function probeRange(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ total: number | null; acceptRanges: boolean }> {
  try {
    const head = await fetch(url, { method: "HEAD", headers, signal, redirect: "follow" });
    const len = Number(head.headers.get("content-length"));
    const accepts = (head.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes");
    if (head.ok && Number.isFinite(len) && len > 0) return { total: len, acceptRanges: accepts };
  } catch { /* alguns CDNs não respondem HEAD */ }
  try {
    const probe = await fetch(url, { headers: { ...headers, range: "bytes=0-0" }, signal, redirect: "follow" });
    probe.body?.cancel().catch(() => { /* já descartado */ });
    const cr = probe.headers.get("content-range")?.match(/\/(\d+)$/);
    if (probe.status === 206 && cr) return { total: Number(cr[1]), acceptRanges: true };
  } catch { /* sem probe: segue com uma conexão */ }
  return { total: null, acceptRanges: false };
}

export function fmt(n: number): string { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`; }
