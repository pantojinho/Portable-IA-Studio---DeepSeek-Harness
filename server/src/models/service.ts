import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { archiveBaseName, extractArchive, flattenSingleChild, isArchive } from "../core/archive.js";
import type { JobInfo } from "../core/jobs.js";
import { HfClient } from "./hf.js";
import { RecipeStore } from "./recipes.js";
import { ModelRegistry, walk, writeSidecar } from "./registry.js";
import { resolvePlan, fmtBytes } from "./resolver.js";
import { downloadFile, DownloadError } from "./downloader.js";
import { detectGpus } from "../core/system.js";
import type { DownloadPlan, PlannedFile } from "./types.js";
import { logger } from "../core/log.js";
import os from "node:os";

const log = logger("models");

/**
 * Facade used by the API and the CLI: resolve → plan → job that downloads,
 * verifies, classifies by content and files everything in the library.
 */
export class ModelService {
  readonly hf: HfClient;
  readonly recipes: RecipeStore;
  readonly registry: ModelRegistry;
  vramMiB: number | null = null;

  constructor(private ctx: StudioContext) {
    this.hf = new HfClient({ token: this.readSecret("hf_token"), mirror: ctx.config.downloads.hfMirror, cacheDir: ctx.paths.cache });
    this.recipes = new RecipeStore([ctx.paths.recipes]);
    this.registry = new ModelRegistry(ctx.paths);
    void detectGpus().then((g) => { this.vramMiB = g.reduce((m, x) => Math.max(m, x.vramMiB ?? 0), 0) || null; });
  }

  // --- secrets -----------------------------------------------------------
  readSecret(name: string): string | null {
    try { return fs.readFileSync(path.join(this.ctx.paths.secrets, name), "utf8").trim() || null; } catch { return null; }
  }
  writeSecret(name: string, value: string | null): void {
    const p = path.join(this.ctx.paths.secrets, name);
    if (!value) { try { fs.unlinkSync(p); } catch { /* */ } }
    else { fs.mkdirSync(this.ctx.paths.secrets, { recursive: true }); fs.writeFileSync(p, value, { mode: 0o600 }); }
    if (name === "hf_token") this.hf.setToken(value);
    if (name === "civitai_token") { if (value) process.env.CIVITAI_TOKEN = value; else delete process.env.CIVITAI_TOKEN; }
  }

  // --- resolve -------------------------------------------------------------
  async resolve(ref: string, opts: { quant?: string | null } = {}): Promise<DownloadPlan> {
    const plan = await resolvePlan(ref, { hf: this.hf, recipes: this.recipes, vramMiB: this.vramMiB, ramMiB: Math.round(os.totalmem() / 1048576), quant: opts.quant ?? null });
    // mark files already present
    for (const f of plan.files) {
      const dest = this.destFor(f);
      if (fs.existsSync(dest) && (!f.sizeBytes || fs.statSync(dest).size === f.sizeBytes)) (f as PlannedFile & { present?: boolean }).present = true;
    }
    return plan;
  }

  destFor(f: PlannedFile): string { return this.registry.destPath(f.kind, f.filename, f.subdir); }

  // --- pull ----------------------------------------------------------------
  pull(plan: DownloadPlan): JobInfo {
    const title = plan.title;
    return this.ctx.jobs.create("download", title, async (job) => {
      const results: { file: string; path: string; skipped: boolean }[] = [];
      const total = plan.files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0);
      let doneBytes = 0;
      for (let i = 0; i < plan.files.length; i++) {
        const f = plan.files[i]!;
        const dest = this.destFor(f);
        const label = `${i + 1}/${plan.files.length} ${f.filename}`;
        if (fs.existsSync(dest) && (!f.sizeBytes || fs.statSync(dest).size === f.sizeBytes)) {
          results.push({ file: f.filename, path: dest, skipped: true });
          doneBytes += f.sizeBytes ?? 0;
          job.setProgress(total ? doneBytes / total : -1, `${label}: já existe`);
          continue;
        }
        job.setMessage(`${label}: conectando…`);
        const headers = f.repo && this.hf.hasToken() ? this.hf.headers() : f.url.includes("civitai.com") && process.env.CIVITAI_TOKEN ? { authorization: `Bearer ${process.env.CIVITAI_TOKEN}` } : {};
        try {
          const r = await downloadFile(f, dest, {
            headers, signal: job.signal, maxSpeed: this.ctx.config.downloads.maxSpeedMiBps ? this.ctx.config.downloads.maxSpeedMiBps * 1048576 : null,
            parallelChunks: this.ctx.config.downloads.parallelChunks,
            onProgress: (p) => {
              const cur = doneBytes + p.received;
              job.setProgress(total ? Math.min(0.999, cur / total) : -1, `${label}: ${p.phase === "verifying" ? "verificando" : p.phase === "done" ? "ok" : `${fmtBytes(p.received)}${p.total ? ` / ${fmtBytes(p.total)}` : ""} · ${fmtBytes(p.speedBps)}/s${p.etaSec != null ? ` · ${eta(p.etaSec)}` : ""}`}`);
            },
          });
          // tentative kind (name-based) → trust the bytes and move if needed
          let finalPath = r.path;
          if (f.tentative && r.inspection.kind && r.inspection.kind !== f.kind) {
            const better = this.registry.destPath(r.inspection.kind, f.filename, f.subdir);
            fs.mkdirSync(path.dirname(better), { recursive: true });
            fs.renameSync(r.path, better); finalPath = better;
            job.log.info(`${f.filename}: reclassificado por conteúdo ${f.kind} → ${r.inspection.kind}`);
          }
          // MOD-08: a voice pack is an archive; unpack it and keep the folder, not the .tar.bz2
          if (f.extract || isArchive(f.filename)) {
            job.setMessage(`${label}: extraindo`);
            const dir = path.join(path.dirname(finalPath), archiveBaseName(f.filename));
            fs.rmSync(dir, { recursive: true, force: true });
            extractArchive(finalPath, dir);
            flattenSingleChild(dir);
            fs.unlinkSync(finalPath);
            const inside = [...walk(dir)];
            fs.writeFileSync(path.join(dir, "aistudio.pack.json"), JSON.stringify({
              ref: plan.ref, url: f.url, recipe: plan.recipeId ?? null, role: f.role,
              extractedAt: new Date().toISOString(), files: inside.map((x) => path.relative(dir, x).split(path.sep).join("/")),
            }, null, 2));
            job.log.info(`${f.filename}: ${inside.length} arquivo(s) extraídos em ${dir}`);
            results.push({ file: f.filename, path: dir, skipped: false });
            doneBytes += f.sizeBytes ?? r.bytes;
            continue;
          }
          writeSidecar(finalPath, {
            source: { ref: plan.ref, repo: f.repo, revision: f.revision, repoPath: f.repoPath, url: f.url, sha256: r.sha256 ?? undefined, license: plan.license, gated: plan.gated, downloadedAt: new Date().toISOString() },
            recipe: plan.recipeId ? { id: plan.recipeId, role: f.role } : undefined,
          });
          results.push({ file: f.filename, path: finalPath, skipped: false });
          doneBytes += f.sizeBytes ?? r.bytes;
        } catch (e) {
          if (e instanceof DownloadError && e.code === "cancelled") throw new Error("cancelled");
          throw e;
        }
      }
      // recipe companions: record which files belong together
      if (plan.recipeId) {
        const paths = results.map((r) => r.path);
        for (const p of paths) writeSidecar(p, { companions: paths.filter((x) => x !== p).map((x) => path.relative(this.ctx.paths.models, x).split(path.sep).join("/")) });
      }
      this.registry.scan();
      log.info(`concluído: ${title} (${results.filter((r) => !r.skipped).length} baixado(s), ${results.filter((r) => r.skipped).length} já existia(m))`);
      return { files: results, recipeId: plan.recipeId ?? null };
    }, { ref: plan.ref, totalBytes: plan.totalBytes, files: plan.files.map((f) => f.filename), recipeId: plan.recipeId ?? null });
  }
}

function eta(sec: number): string { return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}min` : `${(sec / 3600).toFixed(1)}h`; }
