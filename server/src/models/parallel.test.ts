import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { decideParallel, splitRanges, MIN_PARALLEL_BYTES } from "./parallel.js";
import { downloadFile, hashFile } from "./downloader.js";
import type { PlannedFile } from "./types.js";

/** Um GGUF grande o bastante para o download em paralelo valer a pena (MOD-07). */
const big = Buffer.concat([Buffer.from("GGUF"), Buffer.from([3, 0, 0, 0]), Buffer.alloc(MIN_PARALLEL_BYTES + 5000, 42)]);
const sha = createHash("sha256").update(big).digest("hex");
let server: http.Server;
let base = "";
let rangeRequests = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const supportsRange = !req.url?.startsWith("/norange");
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": String(big.length), ...(supportsRange ? { "accept-ranges": "bytes" } : {}) });
      res.end();
      return;
    }
    const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (m && supportsRange) {
      rangeRequests++;
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : big.length - 1;
      const slice = big.subarray(start, end + 1);
      res.writeHead(206, { "content-type": "application/octet-stream", "content-length": String(slice.length), "content-range": `bytes ${start}-${end}/${big.length}`, "accept-ranges": "bytes" });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(big.length) });
    res.end(big);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const dest = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-par-")), name);
const planned = (url: string, extra: Partial<PlannedFile> = {}): PlannedFile =>
  ({ url, filename: "grande.gguf", kind: "text", role: "main", sizeBytes: big.length, sha256: null, tentative: false, ...extra });

describe("models/parallel (MOD-07)", () => {
  it("decide quando vale a pena abrir várias conexões", () => {
    expect(decideParallel({ totalBytes: 500e6, acceptRanges: true, configuredChunks: 4, alreadyOnDisk: 0 }).parallel).toBe(true);
    expect(decideParallel({ totalBytes: 500e6, acceptRanges: true, configuredChunks: 1, alreadyOnDisk: 0 })).toMatchObject({ parallel: false, reason: expect.stringContaining("uma conexão") });
    expect(decideParallel({ totalBytes: 500e6, acceptRanges: false, configuredChunks: 4, alreadyOnDisk: 0 })).toMatchObject({ parallel: false, reason: expect.stringContaining("Range") });
    expect(decideParallel({ totalBytes: 1e6, acceptRanges: true, configuredChunks: 4, alreadyOnDisk: 0 })).toMatchObject({ parallel: false, reason: expect.stringContaining("pequeno") });
    expect(decideParallel({ totalBytes: null, acceptRanges: true, configuredChunks: 4, alreadyOnDisk: 0 }).parallel).toBe(false);
    // um pedaço a cada ~32 MiB, respeitando o teto configurado
    expect(decideParallel({ totalBytes: 80 * 1024 * 1024, acceptRanges: true, configuredChunks: 8, alreadyOnDisk: 0 }).chunks).toBe(3);
  });

  it("divide o arquivo em faixas contíguas que cobrem tudo", () => {
    const ranges = splitRanges(1000, 3);
    expect(ranges).toEqual([{ index: 0, start: 0, end: 333 }, { index: 1, start: 334, end: 667 }, { index: 2, start: 668, end: 999 }]);
    expect(splitRanges(10, 4).at(-1)!.end).toBe(9);
    expect(splitRanges(10, 100).length).toBeLessThanOrEqual(10);
  });

  it("baixa em paralelo e o arquivo sai idêntico", async () => {
    rangeRequests = 0;
    const target = dest("grande.gguf");
    const r = await downloadFile(planned(`${base}/model.gguf`, { sha256: sha }), target, { parallelChunks: 4 });
    expect(r.bytes).toBe(big.length);
    expect(rangeRequests).toBeGreaterThan(1);          // usou mesmo várias faixas
    expect(await hashFile(target)).toBe(sha);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(fs.existsSync(`${target}.part.json`)).toBe(false);
  }, 30_000);

  it("cai para uma conexão só quando o servidor não aceita Range", async () => {
    rangeRequests = 0;
    const target = dest("semrange.gguf");
    const r = await downloadFile(planned(`${base}/norange.gguf`), target, { parallelChunks: 4 });
    expect(r.bytes).toBe(big.length);
    expect(rangeRequests).toBe(0);
    expect(await hashFile(target)).toBe(sha);
  }, 30_000);

  it("retoma aproveitando os pedaços que já terminaram", async () => {
    const target = dest("retoma.gguf");
    const tmp = `${target}.part`;
    // simula uma execução anterior que gravou o primeiro pedaço e morreu
    const chunkSize = Math.ceil(big.length / 2);
    fs.writeFileSync(tmp, Buffer.alloc(big.length));
    const fd = fs.openSync(tmp, "r+");
    fs.writeSync(fd, big.subarray(0, chunkSize), 0, chunkSize, 0);
    fs.closeSync(fd);
    fs.writeFileSync(`${tmp}.json`, JSON.stringify({ url: `${base}/model.gguf`, total: big.length, chunkSize, done: [0] }));
    rangeRequests = 0;
    const r = await downloadFile(planned(`${base}/model.gguf`, { sha256: sha }), target, { parallelChunks: 2 });
    expect(r.bytes).toBe(big.length);
    expect(rangeRequests).toBe(1);                      // só o pedaço que faltava
    expect(await hashFile(target)).toBe(sha);
  }, 30_000);
});
