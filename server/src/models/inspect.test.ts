import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectFile, sniffFormat, headLooksValid, quantFromName, paramsFromName, guessFromName } from "./inspect.js";

function tmp(name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-inspect-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

/** Build a minimal GGUF v3 file with string/uint32 metadata. */
function gguf(kv: Record<string, string | number>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(Buffer.from("GGUF"), u32(3), u64(0), u64(Object.keys(kv).length));
  for (const [k, v] of Object.entries(kv)) {
    parts.push(str(k));
    if (typeof v === "string") parts.push(u32(8), str(v));
    else parts.push(u32(4), u32(v));
  }
  return Buffer.concat(parts);
}

function safetensors(keys: string[], dtype = "F16"): Buffer {
  const header: Record<string, unknown> = {};
  let off = 0;
  for (const k of keys) { header[k] = { dtype, shape: [2], data_offsets: [off, off + 4] }; off += 4; }
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, Buffer.alloc(off)]);
}

describe("sniffFormat", () => {
  it("detects HTML pages saved as models (the ULS bug)", () => {
    expect(sniffFormat(Buffer.from("<!doctype html>\n<html class=\"\">"))).toBe("html");
    expect(sniffFormat(Buffer.from("  <html><head>"))).toBe("html");
  });
  it("detects gguf, ggml, zip, json, safetensors", () => {
    expect(sniffFormat(Buffer.from("GGUF\x03\x00\x00\x00"))).toBe("gguf");
    expect(sniffFormat(Buffer.from("lmgg\x00\x00\x00\x00"))).toBe("ggml");
    expect(sniffFormat(Buffer.from("PK\x03\x04rest"))).toBe("zip");
    expect(sniffFormat(Buffer.from('{"a":1}'))).toBe("json");
    expect(sniffFormat(safetensors(["x"]))).toBe("safetensors");
  });
});

describe("inspectFile", () => {
  it("rejects an HTML page with a clear note", () => {
    const p = tmp("FLUX.2-klein-4B", Buffer.from("<!doctype html>\n<html class=\"\">\n<head><meta charset=\"utf-8\" />"));
    const r = inspectFile(p);
    expect(r.format).toBe("html");
    expect(r.kind).toBeNull();
    expect(r.notes[0]).toMatch(/página HTML/);
  });
  it("classifies a text GGUF with quant and context", () => {
    const p = tmp("Qwen3-4B-Q4_K_M.gguf", gguf({ "general.architecture": "qwen3", "general.name": "Qwen3 4B", "general.file_type": 15, "qwen3.context_length": 40960 }));
    const r = inspectFile(p);
    expect(r).toMatchObject({ format: "gguf", kind: "text", role: "main", arch: "qwen3", quant: "Q4_K_M", contextLength: 40960, params: 4e9 });
  });
  it("classifies an mmproj and an OCR model", () => {
    expect(inspectFile(tmp("mmproj-glmocr.gguf", gguf({ "general.architecture": "clip", "general.type": "mmproj" })))).toMatchObject({ kind: "vision", role: "mmproj" });
    expect(inspectFile(tmp("glmocr-Q8_0.gguf", gguf({ "general.architecture": "glm4v", "general.name": "GLM-OCR", "general.file_type": 7 })))).toMatchObject({ kind: "ocr", role: "main", vision: true });
  });
  it("classifies embeddings, whisper, flux and wan GGUFs", () => {
    expect(inspectFile(tmp("e.gguf", gguf({ "general.architecture": "bert", "general.name": "bge-m3" })))).toMatchObject({ kind: "embeddings", embedding: true });
    expect(inspectFile(tmp("w.gguf", gguf({ "general.architecture": "whisper" })))).toMatchObject({ kind: "speech" });
    expect(inspectFile(tmp("f.gguf", gguf({ "general.architecture": "flux" })))).toMatchObject({ kind: "image", role: "diffusion", arch: "flux" });
    expect(inspectFile(tmp("w2.gguf", gguf({ "general.architecture": "wan" })))).toMatchObject({ kind: "image", role: "diffusion", arch: "wan" });
  });
  it("classifies safetensors checkpoints, vae, text encoders and loras", () => {
    expect(inspectFile(tmp("ds8.safetensors", safetensors(["model.diffusion_model.input_blocks.0.0.weight", "first_stage_model.decoder.conv_in.weight", "cond_stage_model.transformer.text_model.x"])))).toMatchObject({ kind: "image", role: "main", arch: "sd1" });
    expect(inspectFile(tmp("xl.safetensors", safetensors(["model.diffusion_model.x", "conditioner.embedders.1.model.x"])))).toMatchObject({ arch: "sdxl" });
    expect(inspectFile(tmp("ae.safetensors", safetensors(["encoder.conv_in.weight", "decoder.up.0.block.0.conv1.weight"])))).toMatchObject({ role: "vae" });
    expect(inspectFile(tmp("t5.safetensors", safetensors(["encoder.block.0.layer.0.SelfAttention.q.weight", "shared.weight"])))).toMatchObject({ role: "text_encoder", arch: "t5" });
    expect(inspectFile(tmp("flux.safetensors", safetensors(["double_blocks.0.img_attn.qkv.weight", "single_blocks.0.linear1.weight"], "BF16")))).toMatchObject({ kind: "image", role: "diffusion", arch: "flux", quant: "bf16" });
    expect(inspectFile(tmp("lora.safetensors", safetensors(["lora_unet_down_blocks_0.lora_up.weight"])))).toMatchObject({ role: "lora" });
    expect(inspectFile(tmp("llm.safetensors", safetensors(["model.layers.0.self_attn.q_proj.weight"])))).toMatchObject({ kind: "text", arch: "transformers" });
  });
});

describe("helpers", () => {
  it("parses quant and params from names", () => {
    expect(quantFromName("x-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantFromName("x-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantFromName("model_q8f16.onnx")).toBe("Q8F16");
    expect(paramsFromName("Qwen3-35B-A3B")).toBe(35e9);
    expect(paramsFromName("Kokoro-82M")).toBeNull();
  });
  it("guesses kinds from names for planning", () => {
    expect(guessFromName("ggml-large-v3-turbo.bin")).toMatchObject({ kind: "speech" });
    expect(guessFromName("wan2.2_ti2v_5B_fp16.safetensors")).toMatchObject({ kind: "video", role: "diffusion" });
    expect(guessFromName("pt_BR-faber-medium.onnx")).toMatchObject({ kind: "tts", role: "voice" });
  });
  it("headLooksValid rejects html for a gguf", () => {
    expect(headLooksValid(Buffer.from("<!doctype html>"), ".gguf").ok).toBe(false);
    expect(headLooksValid(Buffer.from("GGUF\x03\x00\x00\x00"), ".gguf").ok).toBe(true);
  });
});
