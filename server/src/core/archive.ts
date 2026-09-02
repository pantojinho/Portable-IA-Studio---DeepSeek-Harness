import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "./system.js";

/**
 * MOD-08. Voice packs and engine builds arrive as archives. `tar` handles .zip, .tar.gz, .tar.xz and
 * .tar.bz2 on Windows 10+ (bsdtar), macOS and Linux — no npm dependency, no native module.
 */
export const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|tar\.xz|tar\.bz2|tbz2?)$/i;

export function isArchive(name: string): boolean { return ARCHIVE_RE.test(name); }

/** "vits-piper-pt_BR-faber-medium.tar.bz2" → "vits-piper-pt_BR-faber-medium" */
export function archiveBaseName(name: string): string { return name.replace(ARCHIVE_RE, ""); }

export function extractArchive(archive: string, into: string): void {
  fs.mkdirSync(into, { recursive: true });
  const tar = platform() === "win" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const r = spawnSync(tar, ["-xf", archive, "-C", into], { stdio: "pipe", windowsHide: true });
  if (r.status !== 0) throw new Error(`falha ao extrair ${path.basename(archive)}: ${r.stderr?.toString().slice(0, 300) || "tar não disponível"}`);
}

/**
 * Archives often wrap everything in one folder ("vits-piper-x/model.onnx"). Flatten that so callers
 * always find the files directly under `dir`.
 */
export function flattenSingleChild(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return;
  const inner = path.join(dir, entries[0]!.name);
  for (const name of fs.readdirSync(inner)) fs.renameSync(path.join(inner, name), path.join(dir, name));
  fs.rmdirSync(inner);
}
