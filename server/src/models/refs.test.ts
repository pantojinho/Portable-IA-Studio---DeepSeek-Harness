import { describe, it, expect } from "vitest";
import { parseRef } from "./refs.js";

describe("parseRef", () => {
  it("parses the ten acceptance links as HF repos", () => {
    const links = [
      "https://huggingface.co/baidu/Unlimited-OCR", "https://huggingface.co/tiiuae/Falcon-OCR", "https://huggingface.co/black-forest-labs/FLUX.1-dev",
      "https://huggingface.co/krea/Krea-2-Turbo", "https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA", "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo",
      "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0", "https://huggingface.co/stabilityai/stable-diffusion-3.5-medium",
      "https://huggingface.co/cagliostrolab/animagine-xl-4.0", "https://huggingface.co/firstpixel/F5-TTS-pt-br", "https://huggingface.co/zai-org/GLM-OCR",
    ];
    for (const l of links) {
      const r = parseRef(l);
      expect(r.provider).toBe("huggingface");
      if (r.provider === "huggingface") { expect(r.repo).toBe(l.replace("https://huggingface.co/", "")); expect(r.path).toBeNull(); }
    }
  });
  it("parses blob/resolve/tree links", () => {
    expect(parseRef("https://huggingface.co/ggml-org/GLM-OCR-GGUF/blob/main/GLM-OCR-Q8_0.gguf")).toMatchObject({ repo: "ggml-org/GLM-OCR-GGUF", path: "GLM-OCR-Q8_0.gguf", revision: "main" });
    expect(parseRef("https://huggingface.co/ggml-org/GLM-OCR-GGUF/resolve/main/mmproj-GLM-OCR-Q8_0.gguf?download=true")).toMatchObject({ path: "mmproj-GLM-OCR-Q8_0.gguf" });
    expect(parseRef("https://huggingface.co/Comfy-Org/z_image_turbo/tree/main/split_files/text_encoders")).toMatchObject({ repo: "Comfy-Org/z_image_turbo", subpath: "split_files/text_encoders", path: null });
    expect(parseRef("https://huggingface.co/stabilityai/stable-diffusion-3.5-medium/tree/main/text_encoders")).toMatchObject({ subpath: "text_encoders" });
  });
  it("parses short forms", () => {
    expect(parseRef("unsloth/Qwen3-4B-GGUF")).toMatchObject({ provider: "huggingface", repo: "unsloth/Qwen3-4B-GGUF", quantHint: null });
    expect(parseRef("unsloth/Qwen3-4B-GGUF:Q4_K_M")).toMatchObject({ quantHint: "Q4_K_M" });
    expect(parseRef("hf://rhasspy/piper-voices/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx")).toMatchObject({ repo: "rhasspy/piper-voices", path: "pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx" });
    expect(parseRef("recipe:flux1-dev")).toMatchObject({ provider: "recipe", id: "flux1-dev" });
  });
  it("parses civitai and direct urls", () => {
    expect(parseRef("https://civitai.com/models/133005?modelVersionId=920957")).toMatchObject({ provider: "civitai", modelId: 133005, versionId: 920957 });
    expect(parseRef("https://civitai.com/api/download/models/920957")).toMatchObject({ provider: "civitai", versionId: 920957 });
    expect(parseRef("https://example.com/files/model.safetensors")).toMatchObject({ provider: "url", filename: "model.safetensors" });
  });
  it("rejects garbage", () => {
    expect(() => parseRef("not a link")).toThrow();
    expect(() => parseRef("")).toThrow();
  });
});
