import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addApiKey, readApiKeys, removeApiKey, keyMatches, isLoopback, RateLimiter } from "./auth.js";
import { resolvePaths, ensureLayout } from "./paths.js";
import { DEFAULT_CONFIG } from "./config.js";

function paths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-auth-"));
  const p = resolvePaths({ root: dir });
  ensureLayout(p);
  return p;
}

describe("core/auth", () => {
  it("gera, lê e remove chaves do arquivo", () => {
    const p = paths();
    const k = addApiKey(p);
    expect(k.startsWith("sk-studio-")).toBe(true);
    expect(readApiKeys(p, DEFAULT_CONFIG)).toContain(k);
    expect(removeApiKey(p, k)).toBe(true);
    expect(readApiKeys(p, DEFAULT_CONFIG)).not.toContain(k);
    fs.rmSync(p.root, { recursive: true, force: true });
  });

  it("compara chaves sem vazar tamanho e aceita a do config", () => {
    const p = paths();
    const cfg = structuredClone(DEFAULT_CONFIG); cfg.server.apiKey = "abc123";
    expect(readApiKeys(p, cfg)).toEqual(["abc123"]);
    expect(keyMatches("abc123", ["abc123"])).toBe(true);
    expect(keyMatches("abc124", ["abc123"])).toBe(false);
    expect(keyMatches("abc", ["abc123"])).toBe(false);
    fs.rmSync(p.root, { recursive: true, force: true });
  });

  it("0.0.0.0 não é loopback (exige chave)", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.0.10")).toBe(false);
  });

  it("limita por minuto e libera quem está abaixo do limite", () => {
    const rl = new RateLimiter(() => 2);
    expect(rl.take("a")).toBeNull();
    expect(rl.take("a")).toBeNull();
    expect(rl.take("a")).toBeGreaterThan(0);
    expect(rl.take("b")).toBeNull();
    expect(new RateLimiter(() => 0).take("a")).toBeNull();
  });
});
