import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { resolvePaths, ensureLayout } from "./core/paths.js";
import { loadConfig, applyCliOverrides } from "./core/config.js";
import { initFileLogging, logger, setLogLevel } from "./core/log.js";
import { findFreePort } from "./core/ports.js";
import { createContext } from "./core/context.js";
import { createApp } from "./api/app.js";
import { systemInfo } from "./core/system.js";
import { runDoctor } from "./commands/doctor.js";

const VERSION = "0.1.0";
const log = logger("cli");

interface Args { cmd: string; rest: string[]; flags: Record<string, string | boolean> }

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else rest.push(a);
  }
  const cmd = rest.shift() ?? "serve";
  return { cmd, rest, flags };
}

const HELP = `AI Studio ${VERSION}

  aistudio serve   [--host H] [--port N] [--no-open] [--api-key K] [--data-dir D]
  aistudio doctor                      diagnóstico da máquina e da instalação
  aistudio models  <list|pull|inspect> gerenciar modelos (fase 1)
  aistudio service <install|uninstall|status>  rodar como serviço (fase 8)
  aistudio --help
`;

async function main(): Promise<void> {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === "help") { console.log(HELP); return; }
  if (flags.verbose) setLogLevel("debug");

  const paths = resolvePaths({ dataDir: typeof flags["data-dir"] === "string" ? flags["data-dir"] : undefined });
  ensureLayout(paths);
  initFileLogging(paths.logs);
  const config = applyCliOverrides(loadConfig(paths), flags);
  const ctx = createContext(paths, config, VERSION);

  switch (cmd) {
    case "serve": return serveCmd(ctx);
    case "doctor": return runDoctor(ctx);
    case "models": { const { modelsCmd } = await import("./commands/models.js"); return modelsCmd(ctx, rest, flags); }
    default:
      console.error(`Comando desconhecido: ${cmd}\n`); console.log(HELP); process.exitCode = 1;
  }
}

async function serveCmd(ctx: Awaited<ReturnType<typeof createContext>>): Promise<void> {
  const { host } = ctx.config.server;
  const port = await findFreePort(ctx.config.server.port, 1421, 1499, host);
  if (port !== ctx.config.server.port) log.warn(`Porta ${ctx.config.server.port} ocupada; usando ${port}.`);
  ctx.config.server.port = port;

  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
    console.log("");
    console.log("  ┌──────────────────────────────────────────────┐");
    console.log(`  │  AI Studio ${VERSION.padEnd(34)}│`);
    console.log(`  │  UI / API:  ${url.padEnd(33)}│`);
    console.log(`  │  OpenAI:    ${(url + "/v1").padEnd(33)}│`);
    console.log(`  │  Dados:     ${shorten(ctx.paths.data, 33).padEnd(33)}│`);
    console.log("  └──────────────────────────────────────────────┘");
    console.log("  Ctrl+C encerra.");
    if (ctx.config.server.openBrowser) openBrowser(url);
  });

  void systemInfo(ctx.paths.root).then((s) => log.info(`${s.platform}-${s.arch} · ${s.cpu} · RAM ${Math.round(s.ramMiB / 1024)} GB · GPU ${s.gpus.map((g) => `${g.name}${g.vramMiB ? ` ${Math.round(g.vramMiB / 1024)} GB` : ""}`).join(", ") || "nenhuma"} · backend ${s.recommendedBackend}`));

  const shutdown = () => { log.info("Encerrando…"); server.close(); setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

function shorten(s: string, n: number): string { return s.length <= n ? s : "…" + s.slice(s.length - n + 1); }

function openBrowser(url: string): void {
  const p = process.platform;
  const cmd = p === "win32" ? ["cmd", ["/c", "start", "", url]] as const : p === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
  try { spawn(cmd[0], [...cmd[1]], { detached: true, stdio: "ignore" }).unref(); } catch { /* headless */ }
}

main().catch((err) => { log.error("Falha fatal", err); process.exit(1); });
