import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoiceRegistry, languageFromName, genderFromName, prettyName, slug } from "./voices.js";
import { splitForTts } from "./tts.js";
import { detectVoicePack, buildSherpaTtsArgs } from "../engines/sherpaonnx.js";
import { resolvePaths, ensureLayout } from "../core/paths.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import type { StudioContext } from "../core/context.js";

function studio() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-voz-"));
  const paths = resolvePaths({ root });
  ensureLayout(paths);
  const tts = path.join(paths.models, "tts");
  // pacote Piper (VITS)
  const piper = path.join(tts, "vits-piper-pt_BR-faber-medium");
  fs.mkdirSync(path.join(piper, "espeak-ng-data"), { recursive: true });
  fs.writeFileSync(path.join(piper, "pt_BR-faber-medium.onnx"), "x");
  fs.writeFileSync(path.join(piper, "tokens.txt"), "a 1\n");
  // pacote Kokoro com lista de falantes
  const kokoro = path.join(tts, "kokoro-multi-lang-v1_0");
  fs.mkdirSync(path.join(kokoro, "espeak-ng-data"), { recursive: true });
  fs.writeFileSync(path.join(kokoro, "model.onnx"), "x");
  fs.writeFileSync(path.join(kokoro, "tokens.txt"), "a 1\n");
  fs.writeFileSync(path.join(kokoro, "voices.bin"), "x");
  fs.writeFileSync(path.join(kokoro, "voices.txt"), "pf_dora\npm_alex\npm_santa\n");
  // pasta que não é pacote nenhum
  fs.mkdirSync(path.join(tts, "vazio"), { recursive: true });
  const ctx = { paths, config: structuredClone(DEFAULT_CONFIG) } as unknown as StudioContext;
  return { ctx, paths, root, piper, kokoro };
}

describe("audio/voices (AUD-02/03/04)", () => {
  it("descobre pacotes baixados e cria uma voz por falante", () => {
    const { ctx, root } = studio();
    const reg = new VoiceRegistry(ctx);
    const ids = reg.list().map((v) => v.id);
    expect(ids).toContain("vits-piper-pt_br-faber-medium");
    expect(ids).toContain("kokoro-multi-lang-v1_0:pf_dora");
    expect(ids).toContain("kokoro-multi-lang-v1_0:pm_santa");
    const faber = reg.get("vits-piper-pt_br-faber-medium")!;
    expect(faber.engine).toBe("piper");
    expect(faber.language).toBe("pt-BR");
    expect(reg.get("kokoro-multi-lang-v1_0:pf_dora")!.gender).toBe("f");
    expect(reg.get("kokoro-multi-lang-v1_0:pm_alex")!.params!.speakerId).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("escolhe a voz padrão pelo idioma e respeita a configuração", () => {
    const { ctx, root } = studio();
    const reg = new VoiceRegistry(ctx);
    expect(reg.defaultFor("pt-BR")!.id).toBe("vits-piper-pt_br-faber-medium");
    ctx.config.audio.defaultVoice = "kokoro-multi-lang-v1_0:pm_alex";
    expect(reg.defaultFor("pt-BR")!.id).toBe("kokoro-multi-lang-v1_0:pm_alex");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("salva e apaga vozes do usuário, mas não as de pacote", () => {
    const { ctx, root } = studio();
    const reg = new VoiceRegistry(ctx);
    const v = reg.save({ name: "Minha Voz", engine: "tts-clone", language: "pt-BR" });
    expect(v.id).toBe("minha-voz");
    expect(reg.get("minha-voz")!.builtin).toBe(false);
    expect(reg.delete("minha-voz")).toBe(true);
    expect(() => reg.delete("vits-piper-pt_br-faber-medium")).toThrow(/pacote baixado/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("identifica o tipo do pacote pelo conteúdo, não pelo nome", () => {
    const { piper, kokoro, root } = studio();
    expect(detectVoicePack(piper)!.kind).toBe("vits");
    expect(detectVoicePack(piper)!.dataDir).toBe(path.join(piper, "espeak-ng-data"));
    expect(detectVoicePack(kokoro)!.kind).toBe("kokoro");
    expect(detectVoicePack(kokoro)!.speakers).toEqual(["pf_dora", "pm_alex", "pm_santa"]);
    expect(detectVoicePack(path.join(root, "models", "tts", "vazio"))).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("monta os argumentos certos para cada família", () => {
    const { piper, kokoro, root } = studio();
    const vits = buildSherpaTtsArgs(detectVoicePack(piper)!, { text: "olá", output: "o.wav", speed: 2 });
    expect(vits.join(" ")).toContain("--vits-model=");
    expect(vits.join(" ")).toContain("--vits-length-scale=0.5");
    expect(vits.at(-1)).toBe("olá");
    const kok = buildSherpaTtsArgs(detectVoicePack(kokoro)!, { text: "oi", output: "o.wav", speakerId: 2 });
    expect(kok.join(" ")).toContain("--kokoro-voices=");
    expect(kok.join(" ")).toContain("--sid=2");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("nomes: idioma, gênero e slug", () => {
    expect(languageFromName("vits-piper-pt_BR-faber-medium")).toBe("pt-BR");
    expect(languageFromName("kokoro-multi-lang-v1_0")).toBe("und");
    expect(genderFromName("pf_dora")).toBe("f");
    expect(genderFromName("pm_alex")).toBe("m");
    expect(prettyName("vits-piper-pt_BR-faber-medium")).toBe("pt BR faber medium");
    expect(slug("Minha Voz Ção")).toBe("minha-voz-cao");
  });

  it("quebra textos longos em frases inteiras", () => {
    expect(splitForTts("Oi. Tudo bem?")).toEqual(["Oi. Tudo bem?"]);
    const parts = splitForTts("Frase um bem grande aqui. Frase dois também grande. Frase três.", 30);
    expect(parts.every((p) => p.length <= 30)).toBe(true);
    expect(parts.join(" ")).toBe("Frase um bem grande aqui. Frase dois também grande. Frase três.");
    const long = splitForTts("a".repeat(50) + " " + "b".repeat(50), 60);
    expect(long).toHaveLength(2);
  });
});
