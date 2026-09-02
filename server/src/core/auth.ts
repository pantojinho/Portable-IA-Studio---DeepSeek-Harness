import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Paths } from "./paths.js";
import type { StudioConfig } from "./config.js";

/**
 * API-01. Keys live in data/secrets/api_keys (one per line, `#` = comment); `--api-key` adds one for
 * the run. On 127.0.0.1 no key is required — that is the portable-single-user case; the moment the
 * server is bound to another address a key becomes mandatory (invariant AGENTS.md §2.6).
 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0.0.0.0" ? host !== "0.0.0.0" : false;
}

export function keysFile(paths: Paths): string { return path.join(paths.secrets, "api_keys"); }

export function readApiKeys(paths: Paths, config: StudioConfig): string[] {
  const keys = new Set<string>();
  if (config.server.apiKey) keys.add(config.server.apiKey);
  try {
    for (const line of fs.readFileSync(keysFile(paths), "utf8").split(/\r?\n/)) {
      const k = line.trim();
      if (k && !k.startsWith("#")) keys.add(k);
    }
  } catch { /* no file yet */ }
  return [...keys];
}

export function addApiKey(paths: Paths, key?: string): string {
  const value = key?.trim() || `sk-studio-${randomBytes(24).toString("base64url")}`;
  fs.mkdirSync(paths.secrets, { recursive: true });
  const file = keysFile(paths);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# AI Studio — uma chave por linha\n";
  if (!cur.split(/\r?\n/).some((l) => l.trim() === value)) fs.writeFileSync(file, `${cur.replace(/\s*$/, "")}\n${value}\n`, { mode: 0o600 });
  return value;
}

export function removeApiKey(paths: Paths, key: string): boolean {
  const file = keysFile(paths);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => l.trim() !== key.trim());
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join("\n"), { mode: 0o600 });
  return true;
}

/** Never show a key twice: the UI lists prefix + fingerprint only. */
export function fingerprint(key: string): { prefix: string; sha256: string } {
  return { prefix: key.slice(0, 8), sha256: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

export function keyMatches(given: string, keys: string[]): boolean {
  const g = Buffer.from(given);
  return keys.some((k) => { const b = Buffer.from(k); return b.length === g.length && timingSafeEqual(b, g); });
}

/** Fixed-window counter per client. Cheap and enough to blunt a script; not a WAF. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private perMinute: () => number) {}

  /** Returns null when allowed, or the seconds to wait. */
  take(clientId: string): number | null {
    const limit = this.perMinute();
    if (!limit) return null;
    const now = Date.now();
    const e = this.hits.get(clientId);
    if (!e || e.resetAt <= now) { this.hits.set(clientId, { count: 1, resetAt: now + 60_000 }); return null; }
    if (e.count >= limit) return Math.ceil((e.resetAt - now) / 1000);
    e.count++;
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    return null;
  }
}
