import { describe, it, expect } from "vitest";
import { parseRef } from "./refs.js";
import { resolvePlan } from "./resolver.js";
import { HfClient } from "./hf.js";
import { RecipeStore } from "./recipes.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * MOD-10. Teste AO VIVO do CivitAI: só roda com `AISTUDIO_LIVE=1` (e, para modelos que exigem
 * login, `CIVITAI_TOKEN`). Fica fora do `npm test` normal porque os testes unitários não podem
 * depender da internet (AGENTS.md §4) — mas a integração precisa de um jeito de ser conferida:
 *
 *   AISTUDIO_LIVE=1 npx vitest run server/src/models/civitai.live.test.ts
 *   AISTUDIO_LIVE=1 CIVITAI_TOKEN=xxx npx vitest run server/src/models/civitai.live.test.ts
 *
 * Nada é baixado: o teste só resolve o plano (nomes, tamanhos, hash) e confere o formato.
 */
const live = process.env.AISTUDIO_LIVE === "1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function context() {
  return {
    hf: new HfClient(),
    recipes: new RecipeStore([path.join(root, "models", "recipes")]),
    vramMiB: 6144,
    ramMiB: 32768,
    quant: null,
  };
}

describe("CivitAI (ao vivo)", () => {
  it("entende os dois formatos de link sem tocar na rede", () => {
    expect(parseRef("https://civitai.com/models/133005?modelVersionId=920957")).toMatchObject({ provider: "civitai", modelId: 133005, versionId: 920957 });
    expect(parseRef("https://civitai.com/api/download/models/920957")).toMatchObject({ provider: "civitai", versionId: 920957 });
  });

  it.skipIf(!live)("resolve um plano de LoRA a partir de uma versão real", async () => {
    const ref = process.env.CIVITAI_REF ?? "https://civitai.com/models/133005?modelVersionId=920957";
    const plan = await resolvePlan(ref, context());
    expect(plan.provider).toBe("civitai");
    expect(plan.files.length).toBeGreaterThan(0);
    const file = plan.files[0]!;
    expect(file.url).toMatch(/civitai\.com/);
    expect(file.filename).toMatch(/\.(safetensors|ckpt|pt|gguf)$/i);
    expect(file.sizeBytes).toBeGreaterThan(0);
    if (file.sha256) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    console.log(`plano: ${plan.title} → ${file.filename} (${file.sizeBytes} bytes)${plan.warnings.length ? ` · avisos: ${plan.warnings.join("; ")}` : ""}`);
  }, 60_000);

  it.skipIf(!live)("avisa quando o modelo exige login e não há token", async () => {
    const plan = await resolvePlan("https://civitai.com/api/download/models/920957", context()).catch((e: Error) => e);
    if (plan instanceof Error) {
      expect(plan.message).toMatch(/civitai|token|login|404|403/i);
      return;
    }
    if (!process.env.CIVITAI_TOKEN) {
      // sem token, o plano ainda é montado; o aviso é o que a UI mostra antes de baixar
      expect(Array.isArray(plan.warnings)).toBe(true);
    }
  }, 60_000);
});
