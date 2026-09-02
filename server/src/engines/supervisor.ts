import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import type { EngineAdapter, EngineId, EngineInstance, LaunchOptions } from "./types.js";
import { EngineRegistry } from "./registry.js";

const log = logger("supervisor");

/**
 * ENG-02 + ENG-03 (minimal). Owns child processes: start, wait-healthy, idle unload, VRAM budget
 * (LRU eviction), stop-all on exit. Adapters only build args and talk HTTP; nothing else spawns.
 * Reuse: ULS serve.cjs L1857 (ports), L2741 (health), L4378 (spawn) — behaviour kept, code rewritten.
 */
export class Supervisor {
  private procs = new Map<string, ChildProcess>();
  private locks = new Map<string, Promise<EngineInstance>>();
  private timer: NodeJS.Timeout;

  constructor(private ctx: StudioContext, readonly registry: EngineRegistry) {
    this.timer = setInterval(() => void this.reapIdle(), 60_000);
    this.timer.unref();
    const bye = () => { void this.stopAll(); };
    process.once("SIGINT", bye); process.once("SIGTERM", bye); process.once("exit", bye);
  }

  instances(): EngineInstance[] { return this.registry.running(); }

  /** One instance per (engine, model). Concurrent callers share the same launch. */
  ensure(engine: EngineId, opts: LaunchOptions): Promise<EngineInstance> {
    const id = `${engine}:${opts.model.id}`;
    const live = this.registry.instance(id);
    if (live && (live.status === "ready" || live.status === "busy")) { live.lastUsedAt = Date.now(); return Promise.resolve(live); }
    const pending = this.locks.get(id);
    if (pending) return pending;
    const p = this.launch(engine, id, opts).finally(() => this.locks.delete(id));
    this.locks.set(id, p);
    return p;
  }

  private async launch(engine: EngineId, id: string, opts: LaunchOptions): Promise<EngineInstance> {
    const adapter = this.registry.get(engine);
    if (!adapter) throw new Error(`motor '${engine}' não registrado`);
    await this.makeRoom(adapter, opts);
    const inst = await adapter.launch(opts);
    inst.id = id;
    this.publish(inst);
    return inst;
  }

  /** VRAM budget: evict least-recently-used instances until the new one fits. */
  private async makeRoom(adapter: EngineAdapter, opts: LaunchOptions): Promise<void> {
    const need = adapter.estimateVramMiB(opts) ?? 0;
    const budget = this.budgetMiB();
    if (!need || !budget) return;
    const running = this.instances().filter((i) => i.status === "ready" || i.status === "busy").sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    let used = running.reduce((a, i) => a + (i.vramMiB ?? 0), 0);
    for (const victim of running) {
      if (used + need <= budget) break;
      log.info(`VRAM: ${used + need} > ${budget} MiB; descarregando ${victim.id}`);
      await this.stop(victim.id);
      used -= victim.vramMiB ?? 0;
    }
  }

  private budgetMiB(): number {
    const cfg = this.ctx.config.engines.vramBudgetMiB;
    if (typeof cfg === "number") return cfg;
    return this.ctx.models.vramMiB ? Math.round(this.ctx.models.vramMiB * 0.92) : 0;
  }

  async stop(id: string): Promise<void> {
    const inst = this.registry.instance(id);
    if (!inst) return;
    inst.status = "stopping"; this.publish(inst);
    const adapter = this.registry.get(inst.engine);
    try { await adapter?.stop(inst); } catch (e) { log.warn(`stop ${id}: ${(e as Error).message}`); }
    this.registry.forget(id);
    inst.status = "stopped"; this.publish(inst);
  }

  async stopAll(): Promise<void> {
    clearInterval(this.timer);
    for (const inst of this.instances()) await this.stop(inst.id);
  }

  private async reapIdle(): Promise<void> {
    const idleMin = this.ctx.config.engines.idleUnloadMinutes;
    if (!idleMin) return;
    const cutoff = Date.now() - idleMin * 60_000;
    for (const inst of this.instances()) {
      if (inst.status === "ready" && (inst.lastUsedAt ?? inst.startedAt ?? 0) < cutoff) { log.info(`ocioso há ${idleMin} min: ${inst.id}`); await this.stop(inst.id); }
    }
  }

  publish(inst: EngineInstance): void {
    if (inst.status !== "stopped") this.registry.track(inst);
    bus.publish("engine.status", { id: inst.id, engine: inst.engine, status: inst.status, model: inst.model?.id ?? null, port: inst.port, vramMiB: inst.vramMiB, error: inst.error });
  }

  // --------------------------------------------------- process helpers ---

  /** Spawn a child with logs in data/logs/<name>.log. Resolves the child; caller waits for health. */
  spawnLogged(name: string, exe: string, args: string[], env: Record<string, string> = {}): ChildProcess {
    fs.mkdirSync(this.ctx.paths.logs, { recursive: true });
    const logFile = fs.openSync(path.join(this.ctx.paths.logs, `${name}.log`), "a");
    fs.writeSync(logFile, `\n---- ${new Date().toISOString()} ${path.basename(exe)} ${args.join(" ")}\n`);
    const child = spawn(exe, args, { cwd: path.dirname(exe), env: { ...process.env, ...env }, stdio: ["ignore", logFile, logFile], windowsHide: true });
    child.once("exit", (code) => { fs.closeSync(logFile); log.info(`${name} saiu (código ${code})`); });
    this.procs.set(name, child);
    return child;
  }

  /** Poll `url` until 2xx, or fail when the child dies / timeout elapses. */
  async waitHealthy(child: ChildProcess, url: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const t0 = Date.now();
    let exited: number | null = null;
    child.once("exit", (code) => { exited = code ?? -1; });
    while (Date.now() - t0 < timeoutMs) {
      if (signal?.aborted) { child.kill(); throw new Error("cancelado"); }
      if (exited !== null) throw new Error(`o processo terminou antes de ficar pronto (código ${exited}). Veja data/logs.`);
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error(`o motor não respondeu em ${Math.round(timeoutMs / 1000)} s. Veja data/logs.`);
  }

  kill(child: ChildProcess | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, 5000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
      try { child.kill(); } catch { clearTimeout(t); resolve(); }
    });
  }
}
