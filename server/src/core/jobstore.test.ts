import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobStore } from "./jobstore.js";
import { resolvePaths } from "./paths.js";
import type { JobInfo } from "./jobs.js";

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-jobs-"));
  return { store: new JobStore(resolvePaths({ root: dir, dataDir: path.join(dir, "data") })), dir };
}
const job = (over: Partial<JobInfo> = {}): JobInfo => ({ id: "j1", kind: "download", title: "Baixar X", status: "running", progress: 0.5, message: "…", createdAt: 1000, startedAt: 1001, ...over });

describe("core/jobstore", () => {
  it("grava, atualiza e lê o histórico", () => {
    const { store: s, dir } = store();
    s.record(job());
    s.record(job({ status: "done", progress: 1, endedAt: 2000, result: { files: ["a.gguf"] } }));
    const h = s.history();
    expect(h).toHaveLength(1);
    expect(h[0]!.status).toBe("done");
    expect((h[0]!.result as { files: string[] }).files).toEqual(["a.gguf"]);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it("marca como falho o que ficou rodando no desligamento", () => {
    const { store: s, dir } = store();
    s.record(job());
    s.record(job({ id: "j2", status: "queued" }));
    expect(s.recoverOrphans()).toBe(2);
    expect(s.get("j1")!.error).toMatch(/reinício/);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it("apaga só o que já terminou há muito tempo", () => {
    const { store: s, dir } = store();
    s.record(job({ id: "old", status: "done", endedAt: 1 }));
    s.record(job({ id: "new", status: "done", endedAt: Date.now() }));
    expect(s.prune(30)).toBe(1);
    expect(s.history().map((j) => j.id)).toEqual(["new"]);
    s.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
