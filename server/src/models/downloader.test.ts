import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { downloadFile, DownloadError } from "./downloader.js";
import type { PlannedFile } from "./types.js";

// A tiny origin that serves: a fake GGUF (with Range support), an HTML page, and a "flaky" file.
let server: http.Server; let base = "";
const gguf = Buffer.concat([Buffer.from("GGUF"), Buffer.from([3, 0, 0, 0]), Buffer.alloc(200_000, 7)]);
const sha = createHash("sha256").update(gguf).digest("hex");
let flakyCalls = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/model.gguf" || req.url === "/flaky.gguf") {
      const range = req.headers.range?.match(/bytes=(\d+)-/);
      const start = range ? Number(range[1]) : 0;
      const isFlaky = req.url === "/flaky.gguf" && flakyCalls++ === 0;
      const end = isFlaky ? 50_000 : gguf.length;
      res.writeHead(range ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(gguf.length - start), ...(range ? { "content-range": `bytes ${start}-${gguf.length - 1}/${gguf.length}` } : {}), "accept-ranges": "bytes" });
      res.write(gguf.subarray(start, end));
      if (isFlaky) setTimeout(() => res.destroy(), 80); else res.end();
      return;
    }
    if (req.url === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><head></head><body>repo</body></html>"); return; }
    if (req.url === "/page-as-octet") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("<!doctype html>\n<html class=\"\">" + " ".repeat(5000)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

function dest(name: string): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-dl-")), name); }
function planned(url: string, filename: string, extra: Partial<PlannedFile> = {}): PlannedFile { return { url, filename, kind: "text", role: "main", sizeBytes: null, sha256: null, tentative: true, ...extra }; }

describe("downloadFile", () => {
  it("downloads, verifies sha and inspects", async () => {
    const d = dest("model.gguf");
    const r = await downloadFile(planned(`${base}/model.gguf`, "model.gguf", { sizeBytes: gguf.length, sha256: sha }), d);
    expect(fs.existsSync(d)).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.inspection.format).toBe("gguf");
    expect(fs.existsSync(d + ".part")).toBe(false);
  });
  it("rejects an HTML response by content-type", async () => {
    await expect(downloadFile(planned(`${base}/page`, "FLUX.2-klein-4B.safetensors"), dest("x.safetensors"))).rejects.toMatchObject({ code: "html" });
  });
  it("rejects HTML even when the server lies about the content-type", async () => {
    const d = dest("Z-Image-Turbo.gguf");
    await expect(downloadFile(planned(`${base}/page-as-octet`, "Z-Image-Turbo.gguf"), d)).rejects.toBeInstanceOf(DownloadError);
    expect(fs.existsSync(d)).toBe(false);
    expect(fs.existsSync(d + ".part")).toBe(false);
  });
  it("resumes an interrupted download with Range", async () => {
    const d = dest("flaky.gguf");
    const f = planned(`${base}/flaky.gguf`, "flaky.gguf", { sizeBytes: gguf.length, sha256: sha });
    await expect(downloadFile(f, d)).rejects.toMatchObject({ code: "network" });
    expect(fs.statSync(d + ".part").size).toBeGreaterThan(0);
    const r = await downloadFile(f, d);
    expect(r.resumed).toBe(true);
    expect(r.verified).toBe(true);
    expect(fs.statSync(d).size).toBe(gguf.length);
  });
  it("fails on wrong sha", async () => {
    await expect(downloadFile(planned(`${base}/model.gguf`, "m.gguf", { sha256: "0".repeat(64) }), dest("m.gguf"))).rejects.toMatchObject({ code: "hash" });
  });
});
