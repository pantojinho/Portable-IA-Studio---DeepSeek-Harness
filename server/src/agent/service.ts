import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import YAML from "yaml";
import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import { findFreePort } from "../core/ports.js";
import { platform } from "../core/system.js";
import { bus } from "../core/events.js";
import { logger } from "../core/log.js";
import type { AgentState, AgentRunRequest, AgentRunResult } from "./types.js";

const log = logger("agent");
export const DSH_VERSION = "0.1.1-rc.2";

/**
 * AGT-01/02/03/05. The Studio never re-implements the agent: it installs the pinned DeepSeek Harness
 * into agent/ (DSH_HOME), writes settings.yaml so the agent talks to the Studio's own /v1 (and to
 * cloud providers whose keys the user stored), supervises `dsh web`, and runs one-shot headless tasks.
 * Settings format: dsh docs/user/guide/providers.md (llm-pi-ai.providers.<id> → api/baseURL/compat/models).
 */
export class AgentService {
  private child: ChildProcess | null = null;
  private state: AgentState = { status: "not-installed", pid: null, url: null, version: null };

  constructor(private ctx: StudioContext) {
    if (this.dshBin()) this.state = { ...this.state, status: "stopped", version: this.installedVersion() };
  }

  get home(): string { return this.ctx.paths.agent; }
  private dshBin(): string | null {
    const bin = path.join(this.home, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    return fs.existsSync(bin) ? bin : null;
  }
  private installedVersion(): string | null {
    try { return (JSON.parse(fs.readFileSync(path.join(this.home, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")) as { version: string }).version; } catch { return null; }
  }
  private npmCmd(): { cmd: string; args: string[] } {
    // prefer the portable runtime's npm (no system Node needed); fall back to PATH
    const rt = path.join(this.ctx.paths.runtime, "node", `${platform() === "win" ? "win" : platform() === "mac" ? "mac" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`);
    const npmCli = platform() === "win" ? path.join(rt, "node_modules", "npm", "bin", "npm-cli.js") : path.join(rt, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) return { cmd: process.execPath, args: [npmCli] };
    return { cmd: platform() === "win" ? "npm.cmd" : "npm", args: [] };
  }

  status(): AgentState { return { ...this.state, version: this.state.version ?? this.installedVersion() }; }

  /**
   * AGT-01: install the pinned dsh into agent/ with pnpm (npm's resolver took >25 min on the dsh
   * dependency tree; pnpm does it in ~1 min). pnpm itself comes through `npx pnpm@11` (cached in
   * data/cache/npm). Native optional deps (node-pty, koffi) use prebuilt binaries via onlyBuiltDependencies.
   */
  install(job: JobContext): Promise<void> {
    fs.mkdirSync(this.home, { recursive: true });
    const pkgPath = path.join(this.home, "package.json");
    const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown> : {};
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "aistudio-agent", private: true, description: "DSH_HOME do AI Studio (dsh fixado)", ...pkg,
      pnpm: { onlyBuiltDependencies: ["node-pty", "koffi", "@deepseek-ai/dsh-subprocess-local", "protobufjs", "@google/genai"] } }, null, 2));
    this.state.status = "installing"; this.publish();
    const { cmd, args } = this.npmCmd();
    job.setMessage(`pnpm add @deepseek-ai/dsh@${DSH_VERSION} (1–3 min)`);
    return new Promise<void>((resolve, reject) => {
      const logFile = fs.openSync(path.join(this.ctx.paths.logs, "agent-install.log"), "a");
      const npxArgs = [...args.map((a) => a.replace(/npm-cli\.js$/, "npx-cli.js")), "--yes", "pnpm@11", "add", `@deepseek-ai/dsh@${DSH_VERSION}`, "--reporter=append-only"];
      const exe = cmd.endsWith(".cmd") ? cmd.replace(/npm\.cmd$/, "npx.cmd") : cmd;
      const child = spawn(exe, npxArgs, { cwd: this.home, env: { ...process.env, npm_config_cache: path.join(this.ctx.paths.cache, "npm") }, stdio: ["ignore", logFile, logFile], windowsHide: true, shell: platform() === "win" && exe.endsWith(".cmd") });
      job.signal.addEventListener("abort", () => child.kill());
      child.once("exit", (code) => {
        fs.closeSync(logFile);
        if (this.dshBin()) { this.state = { status: "stopped", pid: null, url: null, version: this.installedVersion() }; this.publish(); this.writeSettings(); resolve(); }
        else { this.state.status = "not-installed"; this.state.error = `instalação terminou com código ${code} sem o dsh (veja data/logs/agent-install.log)`; this.publish(); reject(new Error(this.state.error)); }
      });
    });
  }

  /** AGT-02: settings.yaml → provider "local" = the Studio's /v1, plus cloud providers with stored keys. */
  writeSettings(): string {
    const port = this.ctx.config.server.port;
    const textModels = this.ctx.models.registry.list("text").filter((m) => m.inspection.role === "main").map((m) => ({ id: m.id }));
    const providers: Record<string, unknown> = {
      local: {
        api: "openai-completions", baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "AISTUDIO_API_KEY",
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
        models: textModels.length ? textModels : [{ id: "text/…baixe-um-modelo" }],
      },
    };
    for (const [id, cfg] of Object.entries(this.ctx.providers.all())) {
      if (!this.ctx.providers.key(id) || cfg.models.length === 0) continue;
      providers[id] = { api: "openai-completions", baseURL: cfg.baseURL, apiKeyEnv: `AISTUDIO_PROVIDER_${id.toUpperCase()}`, models: cfg.models.map((m) => ({ id: m })) };
    }
    // AGT-04: the Studio's own MCP server, so the agent can generate images, speak, OCR and search projects
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const settings = {
      "llm-pi-ai": { providers },
      "dsh-mcp-client": {
        servers: {
          aistudio: {
            type: "http",
            url: mcpUrl,
            ...(this.ctx.config.server.apiKey ? { headers: { Authorization: `Bearer ${this.ctx.config.server.apiKey}` } } : {}),
          },
        },
      },
      // formato alternativo aceito por vários clientes MCP; inofensivo para quem ignora
      mcpServers: { aistudio: { type: "http", url: mcpUrl } },
    };
    const file = path.join(this.home, "settings.yaml");
    const doc = new YAML.Document(settings);
    doc.commentBefore = " Gerado pelo AI Studio. Provedor 'local' = o próprio Studio (/v1). Reescrito a cada 'aistudio agent start'; edite agent/settings.local.yaml para adições.";
    fs.writeFileSync(file, String(doc));
    return file;
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = { DSH_HOME: this.home, AISTUDIO_API_KEY: this.ctx.config.server.apiKey ?? "local" };
    for (const id of Object.keys(this.ctx.providers.all())) { const k = this.ctx.providers.key(id); if (k) env[`AISTUDIO_PROVIDER_${id.toUpperCase()}`] = k; }
    return env;
  }

  /** AGT-03: dsh web --port <p> --no-open, supervised. */
  async start(): Promise<AgentState> {
    const bin = this.dshBin();
    if (!bin) throw new Error("dsh não instalado. Rode: aistudio agent install");
    if (this.child && this.state.status === "ready") return this.status();
    this.writeSettings();
    const port = await findFreePort(this.ctx.config.agent.port, 3081, 3099);
    this.state = { status: "starting", pid: null, url: `http://127.0.0.1:${port}`, version: this.installedVersion() }; this.publish();
    const logFile = fs.openSync(path.join(this.ctx.paths.logs, "agent.log"), "a");
    fs.writeSync(logFile, `\n---- ${new Date().toISOString()} dsh web --port ${port}\n`);
    this.child = spawn(process.execPath, [bin, "web", "--port", String(port), "--no-open"], { cwd: this.ctx.config.agent.workspace ?? this.ctx.paths.root, env: { ...process.env, ...this.env() }, stdio: ["ignore", logFile, logFile], windowsHide: true });
    this.state.pid = this.child.pid ?? null;
    this.child.once("exit", (code) => { fs.closeSync(logFile); log.info(`dsh saiu (código ${code})`); this.child = null; this.state = { ...this.state, status: code === 0 ? "stopped" : "error", pid: null, error: code ? `dsh terminou com código ${code} (data/logs/agent.log)` : undefined }; this.publish(); });
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000 && this.child) {
      try { const r = await fetch(this.state.url!, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) { this.state.status = "ready"; this.publish(); return this.status(); } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (this.state.status !== "ready") { this.state.status = "error"; this.state.error = this.state.error ?? "dsh não respondeu em 120 s (data/logs/agent.log)"; this.publish(); throw new Error(this.state.error); }
    return this.status();
  }

  async stop(): Promise<void> {
    const c = this.child; if (!c) return;
    await new Promise<void>((resolve) => { const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* */ } resolve(); }, 5000); c.once("exit", () => { clearTimeout(t); resolve(); }); try { c.kill(); } catch { clearTimeout(t); resolve(); } });
    this.child = null; this.state = { ...this.state, status: "stopped", pid: null }; this.publish();
  }

  /** AGT-05: one-shot `dsh --profile headless "<task>"`. */
  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const bin = this.dshBin();
    if (!bin) throw new Error("dsh não instalado. Rode: aistudio agent install");
    this.writeSettings();
    const t0 = Date.now();
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(process.execPath, [bin, "--profile", "headless", req.task], { cwd: req.workspace ?? this.ctx.config.agent.workspace ?? this.ctx.paths.root, env: { ...process.env, ...this.env() }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
      const timer = setTimeout(() => child.kill(), (req.timeoutSec ?? 900) * 1000);
      child.once("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, output: out.trim(), durationMs: Date.now() - t0 }); });
    });
  }

  private publish(): void { bus.publish("agent.status", this.status()); }
}
