import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.AISTUDIO_LOG as Level) || "info";
let fileStream: fs.WriteStream | null = null;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function initFileLogging(logsDir: string): void {
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, "aistudio.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, path.join(logsDir, "aistudio.1.log"));
    }
  } catch { /* ignore */ }
  fileStream = fs.createWriteStream(file, { flags: "a" });
}

export function setLogLevel(l: Level): void { minLevel = l; }

function stamp(): string { return new Date().toISOString().replace("T", " ").slice(0, 19); }

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${msg}${extra !== undefined ? " " + safe(extra) : ""}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  fileStream?.write(line + "\n");
}

function safe(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write("debug", scope, m, e),
    info: (m: string, e?: unknown) => write("info", scope, m, e),
    warn: (m: string, e?: unknown) => write("warn", scope, m, e),
    error: (m: string, e?: unknown) => write("error", scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
