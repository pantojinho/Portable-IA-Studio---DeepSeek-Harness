import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Paths } from "../core/paths.js";
import type { JobContext } from "../core/jobs.js";
import { osArch, platform, type Backend } from "../core/system.js";
import { extractArchive } from "../core/archive.js";
import { downloadFile } from "../models/downloader.js";
import { globToRegExp } from "../models/hf.js";
import { walk } from "../models/registry.js";
import type { EngineId, EngineInstall } from "./types.js";
import { logger } from "../core/log.js";

const log = logger("engines");

interface CatalogEngine {
  release?: string;
  base?: string;
  keep?: string[];
  exe?: Record<string, string>;
  builds?: Record<string, Record<string, { file: string; requires?: string[]; sha256?: string; note?: string }>>;
}
type Catalog = Record<string, CatalogEngine | number>;

/**
 * ENG-01 + ENG-11. Puts a runnable engine build in engines/<engine>/<os-arch>/<backend>/.
 * Two sources: adopt binaries an Uncensored-Local-Studio install already downloaded (hardlink, free),
 * or download the pinned release from engines/catalog.yaml (tar handles .zip/.tar.gz on all 3 OS).
 */
export class EngineInstaller {
  private catalogCache: Catalog | null = null;
  constructor(private paths: Paths) {}

  catalog(): Catalog {
    if (!this.catalogCache) {
      const p = path.join(this.paths.engines, "catalog.yaml");
      this.catalogCache = fs.existsSync(p) ? (YAML.parse(fs.readFileSync(p, "utf8")) as Catalog) : {};
    }
    return this.catalogCache;
  }

  dirFor(engine: EngineId, backend: Backend): string { return path.join(this.paths.engines, engine, osArch(), backend); }

  installed(engine: EngineId, backend: Backend): EngineInstall | null {
    const dir = this.dirFor(engine, backend);
    const meta = path.join(dir, "install.json");
    if (!fs.existsSync(meta)) return null;
    try {
      const inst = JSON.parse(fs.readFileSync(meta, "utf8")) as EngineInstall;
      return fs.existsSync(inst.exe) ? inst : null;
    } catch { return null; }
  }

  /** Any backend installed for this engine, best first (cuda > rocm > metal > vulkan > cpu). */
  installedAny(engine: EngineId, preferred?: Backend): EngineInstall | null {
    const order: Backend[] = preferred ? [preferred, "cuda", "rocm", "metal", "vulkan", "cpu"] : ["cuda", "rocm", "metal", "vulkan", "cpu"];
    for (const b of order) { const i = this.installed(engine, b); if (i) return i; }
    return null;
  }

  private exeName(engine: EngineId): string {
    const e = this.catalog()[engine] as CatalogEngine | undefined;
    const name = e?.exe?.[platform()] ?? (engine === "llamacpp" ? "llama-server" : engine === "sdcpp" ? "sd-cli" : engine === "whispercpp" ? "whisper-cli" : engine);
    return platform() === "win" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
  }

  private keepGlobs(engine: EngineId): RegExp[] {
    const e = this.catalog()[engine] as CatalogEngine | undefined;
    const globs = e?.keep ?? ["*"];
    return [...globs, "*.dll", "*.so*", "*.dylib", "*.metal"].map((g) => globToRegExp(g));
  }

  private finish(engine: EngineId, backend: Backend, version: string, dir: string, source: string): EngineInstall {
    const exe = path.join(dir, this.exeName(engine));
    if (!fs.existsSync(exe)) throw new Error(`instalação de ${engine} sem executável ${path.basename(exe)} em ${dir}`);
    if (platform() !== "win") { try { fs.chmodSync(exe, 0o755); } catch { /* */ } }
    const inst: EngineInstall = { engine, backend, version, dir, exe, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ ...inst, source }, null, 2));
    log.info(`${engine}/${backend} pronto (${source}) → ${dir}`);
    return inst;
  }

  // ------------------------------------------------------------ adopt ---

  /** Where ULS keeps each engine. Returns candidate dirs (first existing wins). */
  private ulsDirs(engine: EngineId, backend: Backend, ulsRoot: string): string[] {
    const p = platform();
    const app = path.join(ulsRoot, "app");
    if (engine === "llamacpp") {
      if (p === "win") return [path.join(app, "llm-backend", "win", backend === "rocm" ? "hip" : backend)];
      if (p === "linux") return [path.join(app, "llm-backend", "linux", backend)];
      return [path.join(app, "llm-backend", "mac", process.arch === "arm64" ? "arm64" : "x64")];
    }
    if (engine === "sdcpp") {
      if (p === "win") return [path.join(app, "backend", "win", backend)];
      if (p === "linux") return [path.join(app, "backend", "linux", backend)];
      return [path.join(app, "backend", "mac")];
    }
    if (engine === "whispercpp") return [path.join(app, "speech-backend", p, backend)]; // ULS only ships cpu; no fake gpu adoption
    return [];
  }

  adoptFromUls(engine: EngineId, backend: Backend, ulsRoots: string[]): EngineInstall | null {
    for (const root of ulsRoots) {
      for (const src of this.ulsDirs(engine, backend, root)) {
        if (!fs.existsSync(src)) continue;
        const exeName = this.exeName(engine);
        // ULS renames the sd server per backend (sd-cuda.exe); sd-cli is what we drive
        if (!fs.existsSync(path.join(src, exeName))) continue;
        const dir = this.dirFor(engine, backend);
        fs.mkdirSync(dir, { recursive: true });
        const keep = this.keepGlobs(engine);
        let n = 0;
        for (const f of fs.readdirSync(src)) {
          if (!keep.some((re) => re.test(f))) continue;
          const to = path.join(dir, f);
          if (fs.existsSync(to)) { n++; continue; }
          try { fs.linkSync(path.join(src, f), to); } catch { fs.copyFileSync(path.join(src, f), to); }
          n++;
        }
        const version = readText(path.join(src, ".backend-version")) ?? "uls";
        log.info(`adotado ${engine}/${backend} do ULS (${n} arquivos, hardlink) de ${src}`);
        return this.finish(engine, backend, version, dir, `uls:${src}`);
      }
    }
    return null;
  }

  // ---------------------------------------------------------- download ---

  async install(engine: EngineId, backend: Backend, job: JobContext): Promise<EngineInstall> {
    const e = this.catalog()[engine] as CatalogEngine | undefined;
    const build = e?.builds?.[osArch()]?.[backend];
    if (!e || !build || /TODO/.test(build.file)) throw new Error(`Sem build de ${engine} para ${osArch()}/${backend} no catálogo (engines/catalog.yaml). Tarefa ENG-01.`);
    const release = e.release ?? "";
    const urlOf = (f: string) => (/^https?:\/\//.test(f) ? f : (e.base ?? "").replace("{release}", release) + f.replace("{release}", release));
    const dir = this.dirFor(engine, backend);
    const tmp = path.join(this.paths.cache, "engines", `${engine}-${backend}`);
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    const archives = [build.file, ...(build.requires ?? [])];
    for (let i = 0; i < archives.length; i++) {
      const url = urlOf(archives[i]!);
      const name = path.basename(new URL(url).pathname);
      job.setMessage(`baixando ${name}`);
      const dest = path.join(tmp, name);
      await downloadFile({ url, filename: name, kind: "text", role: "unknown", sizeBytes: null, sha256: build.sha256 ?? null, tentative: false }, dest, {
        signal: job.signal, onProgress: (p) => job.setProgress(p.total ? (i + p.received / p.total) / archives.length : -1, `${name}: ${Math.round(p.received / 1048576)} MB`),
      });
      job.setMessage(`extraindo ${name}`);
      extract(dest, path.join(tmp, "x" + i));
      fs.unlinkSync(dest);
    }
    fs.mkdirSync(dir, { recursive: true });
    const keep = this.keepGlobs(engine);
    let n = 0;
    for (const f of walk(tmp)) {
      const base = path.basename(f);
      if (!keep.some((re) => re.test(base))) continue;
      fs.copyFileSync(f, path.join(dir, base)); n++;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    log.info(`${engine}/${backend}: ${n} arquivos instalados de ${archives.length} pacote(s)`);
    return this.finish(engine, backend, release || "catalog", dir, `catalog:${build.file}`);
  }
}

function readText(p: string): string | null { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } }

/** Kept for callers that import it from here; the implementation lives in core/archive.ts (MOD-08). */
export const extract = extractArchive;
