import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonRunner } from "./pythonvenv.js";
import { resolvePaths, ensureLayout } from "../core/paths.js";
import type { StudioContext } from "../core/context.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function runner(): PythonRunner {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-py-"));
  const paths = resolvePaths({ root: repoRoot, dataDir });
  ensureLayout(paths);
  const ctx = { paths, engines: { installer: { installedAny: () => null } } } as unknown as StudioContext;
  return new PythonRunner(ctx);
}

const r = runner();
const hasPython = Boolean(r.systemPython());

describe("engines/pythonvenv (AUD-10)", () => {
  it("lê o catálogo de pacotes (dados, não código)", () => {
    const cat = r.catalog();
    expect(Object.keys(cat)).toContain("demo");
    expect(cat["tts-clone"]!.requirements!.length).toBeGreaterThan(0);
    expect(cat["tts-clone"]!.nonCommercial).toBe(true);
    expect(cat.demo!.requirements ?? []).toHaveLength(0);
  });

  it("explica o que fazer quando o pacote não existe", () => {
    expect(() => r.package("nao-existe")).toThrow(/não existe/);
  });

  it("lista o estado de cada pacote", () => {
    const status = r.status();
    expect(status.find((s) => s.id === "music")?.requirements).toBeGreaterThan(0);
  });

  it.skipIf(!hasPython)("sobe o servidor de eco e conversa por JSON", async () => {
    const answer = await r.call<{ echo: { msg: string } }>("demo", "/echo", { msg: "oi" });
    expect(answer.echo.msg).toBe("oi");
    r.stopAll();
  }, 30_000);
});
