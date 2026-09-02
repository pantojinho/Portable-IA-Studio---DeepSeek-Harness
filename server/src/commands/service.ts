import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import { platform } from "../core/system.js";
import { logger } from "../core/log.js";

const log = logger("service");
const SERVICE_NAME = "AIStudio";

/**
 * SVC-01. "Rodar sozinho ao ligar o computador" without an installer and without admin rights:
 * Windows → a scheduled task at logon; macOS → a LaunchAgent; Linux → a systemd --user unit.
 * All three point at the launcher inside the folder, so moving the folder is undoing the service
 * (the commands say exactly that).
 */
export async function serviceCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const action = rest[0] ?? "status";
  const manager = new ServiceManager(ctx, flags);
  switch (action) {
    case "install": return manager.install();
    case "uninstall": return manager.uninstall();
    case "status": return manager.status();
    case "start": return manager.start();
    case "stop": return manager.stop();
    case "logs": return manager.logs();
    default:
      throw new Error("uso: aistudio service <install|uninstall|status|start|stop|logs> [--port N] [--host H]");
  }
}

export class ServiceManager {
  constructor(private ctx: StudioContext, private flags: Record<string, string | boolean> = {}) {}

  private launcher(): string {
    const p = platform();
    const file = p === "win" ? "aistudio.cmd" : "aistudio";
    const full = path.join(this.ctx.paths.root, file);
    if (!fs.existsSync(full)) throw new Error(`não encontrei o lançador ${file} em ${this.ctx.paths.root}`);
    return full;
  }

  private args(): string[] {
    const args = ["serve", "--headless", "--no-open"];
    if (typeof this.flags.port === "string") args.push("--port", this.flags.port);
    if (typeof this.flags.host === "string") args.push("--host", this.flags.host);
    return args;
  }

  private plistPath(): string { return path.join(os.homedir(), "Library", "LaunchAgents", "com.aistudio.server.plist"); }
  private unitPath(): string { return path.join(os.homedir(), ".config", "systemd", "user", "aistudio.service"); }

  install(): void {
    const p = platform();
    const exe = this.launcher();
    const args = this.args();
    if (p === "win") {
      const command = `"${exe}" ${args.join(" ")}`;
      run("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", SERVICE_NAME, "/TR", command]);
      console.log(`  ✔ tarefa "${SERVICE_NAME}" criada: o Studio sobe no seu login.`);
      console.log(`     Para remover: aistudio service uninstall`);
      return;
    }
    if (p === "mac") {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.aistudio.server</string>
  <key>ProgramArguments</key>
  <array>
${[exe, ...args].map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(this.ctx.paths.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(path.join(this.ctx.paths.logs, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(this.ctx.paths.logs, "service.log"))}</string>
</dict>
</plist>
`;
      fs.mkdirSync(path.dirname(this.plistPath()), { recursive: true });
      fs.mkdirSync(this.ctx.paths.logs, { recursive: true });
      fs.writeFileSync(this.plistPath(), plist);
      run("launchctl", ["unload", this.plistPath()], true);
      run("launchctl", ["load", "-w", this.plistPath()]);
      console.log(`  ✔ LaunchAgent instalado em ${this.plistPath()} (sobe no login, reinicia se cair).`);
      return;
    }
    const unit = `[Unit]
Description=AI Studio (local, portátil)
After=network.target

[Service]
Type=simple
WorkingDirectory=${this.ctx.paths.root}
ExecStart=${systemdCommand(exe, args)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(this.unitPath()), { recursive: true });
    fs.writeFileSync(this.unitPath(), unit);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "aistudio.service"]);
    console.log(`  ✔ serviço de usuário instalado (${this.unitPath()}).`);
    console.log("     Para ele subir sem você logar: sudo loginctl enable-linger $USER");
  }

  uninstall(): void {
    const p = platform();
    if (p === "win") { run("schtasks", ["/Delete", "/F", "/TN", SERVICE_NAME], true); console.log("  ✔ tarefa removida."); return; }
    if (p === "mac") {
      run("launchctl", ["unload", "-w", this.plistPath()], true);
      try { fs.unlinkSync(this.plistPath()); } catch { /* já não existia */ }
      console.log("  ✔ LaunchAgent removido.");
      return;
    }
    run("systemctl", ["--user", "disable", "--now", "aistudio.service"], true);
    try { fs.unlinkSync(this.unitPath()); } catch { /* já não existia */ }
    run("systemctl", ["--user", "daemon-reload"], true);
    console.log("  ✔ serviço removido.");
  }

  status(): void {
    const p = platform();
    const out = p === "win" ? run("schtasks", ["/Query", "/TN", SERVICE_NAME, "/V", "/FO", "LIST"], true)
      : p === "mac" ? run("launchctl", ["list", "com.aistudio.server"], true)
        : run("systemctl", ["--user", "status", "aistudio.service", "--no-pager"], true);
    const installed = p === "mac" ? fs.existsSync(this.plistPath()) : p === "linux" ? fs.existsSync(this.unitPath()) : /(TaskName|Nome da Tarefa)/i.test(out);
    console.log(installed ? "  Serviço instalado." : "  Serviço não instalado (aistudio service install).");
    if (out.trim()) console.log(out.trim().split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n"));
  }

  start(): void {
    const p = platform();
    if (p === "win") run("schtasks", ["/Run", "/TN", SERVICE_NAME]);
    else if (p === "mac") run("launchctl", ["start", "com.aistudio.server"]);
    else run("systemctl", ["--user", "start", "aistudio.service"]);
    console.log("  ✔ pedido de início enviado.");
  }

  stop(): void {
    const p = platform();
    if (p === "win") run("schtasks", ["/End", "/TN", SERVICE_NAME], true);
    else if (p === "mac") run("launchctl", ["stop", "com.aistudio.server"], true);
    else run("systemctl", ["--user", "stop", "aistudio.service"], true);
    console.log("  ✔ pedido de parada enviado.");
  }

  logs(): void {
    const file = path.join(this.ctx.paths.logs, "service.log");
    const studio = path.join(this.ctx.paths.logs, "aistudio.log");
    for (const f of [file, studio]) {
      if (!fs.existsSync(f)) continue;
      console.log(`\n  ── ${f} ──`);
      const text = fs.readFileSync(f, "utf8");
      console.log(text.split("\n").slice(-40).join("\n"));
    }
    if (platform() === "linux") console.log("\n  Mais: journalctl --user -u aistudio.service -n 50");
    log.debug("logs exibidos");
  }
}

function run(exe: string, args: string[], tolerant = false): string {
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !tolerant) {
    throw new Error(`${exe} ${args[0]} falhou: ${out.trim().split("\n").slice(0, 3).join(" | ") || `código ${r.status}`}`);
  }
  return out;
}

/**
 * A pasta do dono se chama "Portable IA Studio": com espaço. O systemd só entende espaço em
 * ExecStart se o argumento estiver entre aspas (e a aspa dentro do valor, escapada).
 */
export function systemdCommand(exe: string, args: string[]): string {
  const quote = (a: string) => (/[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a);
  return [exe, ...args].map(quote).join(" ");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
