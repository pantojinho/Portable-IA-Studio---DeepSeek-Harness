import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import YAML from "yaml";
import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import { findFreePort } from "../core/ports.js";
import { platform } from "../core/system.js";
import { logger } from "../core/log.js";

const log = logger("python");

/**
 * AUD-10. Some models only exist as Python (voice cloning, music). The Studio keeps them at arm's
 * length: one venv per package under engines/python-venv/<id>/, created by a portable `uv` that is
 * downloaded on demand, plus a tiny HTTP server (engines/python/<id>/server.py) speaking JSON.
 * Nothing is installed on the system and no npm native module is involved (AGENTS.md §2.1/§2.3).
 */
export interface PythonPackage {
  id: string;
  name: string;
  /** python version uv installs inside the folder when missing */
  python?: string;
  /** pinned requirements; empty means "standard library only" (no venv needed) */
  requirements?: string[];
  /** extra index (e.g. torch cu124 wheels) */
  indexUrl?: string;
  extraIndexUrl?: string;
  env?: Record<string, string>;
  description?: string;
  license?: string;
  nonCommercial?: boolean;
}

interface Running { proc: ChildProcess; baseUrl: string; startedAt: number; lastUsedAt: number }

export class PythonRunner {
  private servers = new Map<string, Running>();
  private starting = new Map<string, Promise<string>>();
  private catalogCache: Record<string, PythonPackage> | null = null;

  constructor(private ctx: StudioContext) {
    const bye = () => this.stopAll();
    process.once("exit", bye); process.once("SIGINT", bye); process.once("SIGTERM", bye);
  }

  /** engines/python/packages.yaml — data, not code (AGENTS.md §2.9). */
  catalog(): Record<string, PythonPackage> {
    if (!this.catalogCache) {
      const file = path.join(this.ctx.paths.engines, "python", "packages.yaml");
      try {
        const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as { packages?: PythonPackage[] };
        this.catalogCache = Object.fromEntries((parsed.packages ?? []).map((p) => [p.id, p]));
      } catch (e) {
        log.warn(`sem catálogo Python (${(e as Error).message})`);
        this.catalogCache = {};
      }
    }
    return this.catalogCache;
  }

  package(id: string): PythonPackage {
    const pkg = this.catalog()[id];
    if (!pkg) throw new Error(`pacote Python '${id}' não existe. Veja engines/python/packages.yaml (${Object.keys(this.catalog()).join(", ") || "vazio"}).`);
    return pkg;
  }

  venvDir(id: string): string { return path.join(this.ctx.paths.engines, "python-venv", id); }
  sourceDir(id: string): string { return path.join(this.ctx.paths.engines, "python", id); }

  venvPython(id: string): string | null {
    const p = platform() === "win" ? path.join(this.venvDir(id), "Scripts", "python.exe") : path.join(this.venvDir(id), "bin", "python");
    return fs.existsSync(p) ? p : null;
  }

  /** Portable uv, downloaded into engines/uv/ the first time it is needed. */
  async uv(install = true): Promise<string | null> {
    const have = this.ctx.engines.installer.installedAny("uv");
    if (have) return have.exe;
    const onPath = systemBinary(platform() === "win" ? "uv.exe" : "uv");
    if (onPath) return onPath;
    if (!install) return null;
    const inst = await this.ctx.engines.ensureInstalled("uv", "cpu");
    return inst.exe;
  }

  installed(id: string): boolean {
    const pkg = this.catalog()[id];
    if (!pkg) return false;
    if (!pkg.requirements?.length) return Boolean(this.systemPython());
    return Boolean(this.venvPython(id));
  }

  /** Create the venv and install the pinned requirements. Long: always called inside a job. */
  async install(id: string, job?: JobContext): Promise<string> {
    const pkg = this.package(id);
    if (!pkg.requirements?.length) {
      const py = this.systemPython();
      if (!py) throw new Error(`'${id}' precisa de um Python. Instale o Python 3 ou rode: aistudio engines install uv`);
      return py;
    }
    const uv = await this.uv();
    if (!uv) throw new Error("uv não disponível: sem ele não dá para criar o ambiente Python. Rode: aistudio engines install uv");
    const dir = this.venvDir(id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    job?.setMessage(`criando ambiente Python de ${pkg.name}`);
    run(uv, ["venv", "--python", pkg.python ?? "3.12", dir], { UV_PYTHON_INSTALL_DIR: path.join(this.ctx.paths.engines, "python-runtime") });
    const python = this.venvPython(id);
    if (!python) throw new Error(`uv criou ${dir} mas não achei o python dentro`);
    const args = ["pip", "install", "--python", python, ...(pkg.indexUrl ? ["--index-url", pkg.indexUrl] : []), ...(pkg.extraIndexUrl ? ["--extra-index-url", pkg.extraIndexUrl] : []), ...pkg.requirements];
    job?.setMessage(`instalando ${pkg.requirements.length} dependência(s) de ${pkg.name} (pode demorar)`);
    run(uv, args, { UV_PYTHON_INSTALL_DIR: path.join(this.ctx.paths.engines, "python-runtime") });
    log.info(`${id}: ambiente pronto em ${dir}`);
    return python;
  }

  /** Start (or reuse) the package's HTTP server and return its base URL. */
  async server(id: string): Promise<string> {
    const live = this.servers.get(id);
    if (live && live.proc.exitCode === null) { live.lastUsedAt = Date.now(); return live.baseUrl; }
    const pending = this.starting.get(id);
    if (pending) return pending;
    const p = this.startServer(id).finally(() => this.starting.delete(id));
    this.starting.set(id, p);
    return p;
  }

  private async startServer(id: string): Promise<string> {
    const pkg = this.package(id);
    const script = path.join(this.sourceDir(id), "server.py");
    if (!fs.existsSync(script)) throw new Error(`falta ${script} (o servidor Python do pacote '${id}')`);
    const python = (pkg.requirements?.length ? this.venvPython(id) : this.systemPython()) ?? (await this.install(id));
    const port = await findFreePort(8700, 8700, 8799);
    const baseUrl = `http://127.0.0.1:${port}`;
    fs.mkdirSync(this.ctx.paths.logs, { recursive: true });
    const logFile = fs.openSync(path.join(this.ctx.paths.logs, `python-${id}.log`), "a");
    const proc = spawn(python, [script, "--port", String(port)], {
      cwd: this.sourceDir(id), windowsHide: true, stdio: ["ignore", logFile, logFile],
      env: { ...process.env, ...(pkg.env ?? {}), AISTUDIO_MODELS: this.ctx.paths.models, AISTUDIO_OUTPUTS: this.ctx.paths.outputs, HF_HOME: path.join(this.ctx.paths.cache, "hf") },
    });
    proc.once("exit", (code) => { fs.closeSync(logFile); this.servers.delete(id); log.info(`servidor ${id} saiu (código ${code})`); });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      if (proc.exitCode !== null) throw new Error(`o servidor Python '${id}' terminou antes de responder (código ${proc.exitCode}). Veja data/logs/python-${id}.log`);
      try { const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) }); if (r.ok) break; } catch { /* subindo */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (proc.exitCode !== null) throw new Error(`servidor Python '${id}' não subiu`);
    this.servers.set(id, { proc, baseUrl, startedAt: Date.now(), lastUsedAt: Date.now() });
    log.info(`${id} servindo em ${baseUrl}`);
    return baseUrl;
  }

  async call<T = Record<string, unknown>>(id: string, route: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const baseUrl = await this.server(id);
    const r = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${id}${route} → HTTP ${r.status}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text) as T; } catch { throw new Error(`${id}${route} devolveu algo que não é JSON: ${text.slice(0, 200)}`); }
  }

  /** AUD-06: cloning engines all answer the same POST /tts. */
  async tts(engine: string, opts: { text: string; output: string; refWav?: string; language?: string; speed?: number; params: Record<string, unknown> }, signal?: AbortSignal): Promise<string> {
    const id = engine.startsWith("python:") ? engine.slice(7) : engine;
    const pkg = this.catalog()[id];
    if (!pkg) throw new Error(`não sei falar com o motor '${engine}'. Motores de voz: piper, kokoro, outetts, ${Object.keys(this.catalog()).join(", ")}.`);
    const r = await this.call<{ file: string }>(id, "/tts", { ...opts, engine: id, ref_wav: opts.refWav }, signal);
    return r.file;
  }

  /** AUD-09: music generation, always inside a job (minutes on 6 GB). */
  async music(engine: string, opts: Record<string, unknown>, signal?: AbortSignal): Promise<{ file: string; durationSec?: number }> {
    return this.call<{ file: string; durationSec?: number }>(engine, "/music", opts, signal);
  }

  status(): { id: string; name: string; installed: boolean; running: boolean; requirements: number; nonCommercial: boolean }[] {
    return Object.values(this.catalog()).map((p) => ({
      id: p.id, name: p.name, installed: this.installed(p.id), running: this.servers.has(p.id),
      requirements: p.requirements?.length ?? 0, nonCommercial: Boolean(p.nonCommercial),
    }));
  }

  stop(id: string): void {
    const s = this.servers.get(id);
    if (!s) return;
    try { s.proc.kill(); } catch { /* já morreu */ }
    this.servers.delete(id);
  }

  stopAll(): void { for (const id of [...this.servers.keys()]) this.stop(id); }

  systemPython(): string | null {
    for (const name of platform() === "win" ? ["python.exe", "python3.exe"] : ["python3", "python"]) {
      const p = systemBinary(name);
      if (p && spawnSync(p, ["-c", "import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)"], { windowsHide: true }).status === 0) return p;
    }
    return null;
  }
}

function run(exe: string, args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync(exe, args, { stdio: "pipe", windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    throw new Error(`${path.basename(exe)} ${args.slice(0, 2).join(" ")} falhou: ${(r.stderr?.toString() || r.stdout?.toString() || "").slice(-400)}`);
  }
}

function systemBinary(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* diretório sumiu */ }
  }
  return null;
}
