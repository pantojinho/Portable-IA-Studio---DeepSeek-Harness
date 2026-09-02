import fs from "node:fs";
import path from "node:path";
import type { ModelKind } from "../core/paths.js";
import type { FileFormat, FileRole, Inspection } from "./types.js";

/**
 * Decide what a file is by reading its header. This is the guard that makes
 * "saved an HTML page as FLUX.2-klein-4B" impossible: nothing enters the
 * library without passing through here.
 */

const GGUF_MAGIC = 0x46554747;       // "GGUF" little-endian
const GGML_MAGIC = 0x67676d6c;       // "lmgg" as read LE from "ggml" (whisper.cpp)
const GGML_MAGIC_LE = 0x6c6d6767;

export function sniffFormat(head: Buffer): FileFormat {
  if (head.length < 4) return "unknown";
  const u32 = head.readUInt32LE(0);
  if (u32 === GGUF_MAGIC) return "gguf";
  if (u32 === GGML_MAGIC || u32 === GGML_MAGIC_LE) return "ggml";
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) return "zip";
  // safetensors: u64 LE header length followed by '{' (checked before text sniffing: a tiny
  // header length can look like whitespace bytes)
  if (head.length >= 9) {
    const len = Number(head.readBigUInt64LE(0));
    if (len > 0 && len < 512 * 1024 * 1024 && head[8] === 0x7b) return "safetensors";
  }
  const text = head.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
  if (text.startsWith("<!doctype") || text.startsWith("<html") || text.startsWith("<?xml") || text.includes("<head>")) return "html";
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  // onnx is protobuf; ModelProto usually starts with field 1 (ir_version, varint) = 0x08
  if (head[0] === 0x08 && head.length > 16) {
    const s = head.subarray(0, 64).toString("latin1");
    if (/onnx|pytorch|tf2onnx|skl2onnx|ai\.onnx/i.test(s) || head[2] === 0x12) return "onnx";
  }
  return "bin";
}

// ---------------------------------------------------------------- GGUF ---

const enum GgufType { UINT8 = 0, INT8, UINT16, INT16, UINT32, INT32, FLOAT32, BOOL, STRING, ARRAY, UINT64, INT64, FLOAT64 }

class Reader {
  off = 0;
  constructor(private fd: number, private buf: Buffer, public fileSize: number) {}
  private ensure(n: number): void {
    if (this.off + n > this.buf.length) {
      // grow: re-read from the file at current offset (headers can exceed our first read)
      const grow = Buffer.alloc(Math.max(this.buf.length * 2, this.off + n + 1 << 20));
      fs.readSync(this.fd, grow, 0, grow.length, 0);
      this.buf = grow;
    }
  }
  u8(): number { this.ensure(1); return this.buf[this.off++]!; }
  u16(): number { this.ensure(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u32(): number { this.ensure(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  i32(): number { this.ensure(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  u64(): number { this.ensure(8); const v = Number(this.buf.readBigUInt64LE(this.off)); this.off += 8; return v; }
  i64(): number { this.ensure(8); const v = Number(this.buf.readBigInt64LE(this.off)); this.off += 8; return v; }
  f32(): number { this.ensure(4); const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  f64(): number { this.ensure(8); const v = this.buf.readDoubleLE(this.off); this.off += 8; return v; }
  str(): string { const n = this.u64(); this.ensure(n); const s = this.buf.toString("utf8", this.off, this.off + n); this.off += n; return s; }
  value(t: number, depth = 0): unknown {
    switch (t) {
      case GgufType.UINT8: return this.u8();
      case GgufType.INT8: return this.u8();
      case GgufType.UINT16: return this.u16();
      case GgufType.INT16: return this.u16();
      case GgufType.UINT32: return this.u32();
      case GgufType.INT32: return this.i32();
      case GgufType.FLOAT32: return this.f32();
      case GgufType.BOOL: return this.u8() !== 0;
      case GgufType.STRING: return this.str();
      case GgufType.UINT64: return this.u64();
      case GgufType.INT64: return this.i64();
      case GgufType.FLOAT64: return this.f64();
      case GgufType.ARRAY: {
        const et = this.u32(); const n = this.u64();
        // tokenizer arrays are huge; keep only a few entries
        const keep = depth === 0 && n > 64 ? 8 : n;
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) { const v = this.value(et, depth + 1); if (i < keep) out.push(v); }
        return n > keep ? { __array: n, sample: out } : out;
      }
      default: throw new Error(`GGUF: tipo de metadado desconhecido ${t}`);
    }
  }
}

export interface GgufMeta { version: number; tensors: number; kv: Record<string, unknown> }

export function readGgufMeta(file: string): GgufMeta {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 2 << 20));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const r = new Reader(fd, buf, size);
    if (r.u32() !== GGUF_MAGIC) throw new Error("não é GGUF");
    const version = r.u32();
    if (version < 2 || version > 3) throw new Error(`GGUF versão ${version} não suportada`);
    const tensors = r.u64();
    const nkv = r.u64();
    const kv: Record<string, unknown> = {};
    for (let i = 0; i < nkv; i++) {
      const key = r.str();
      const type = r.u32();
      kv[key] = r.value(type);
      if (i > 4096) break;
    }
    return { version, tensors, kv };
  } finally { fs.closeSync(fd); }
}

const QUANT_NAMES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L",
  14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS",
  23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16",
};

const EMBEDDING_ARCHS = new Set(["bert", "nomic-bert", "jina-bert-v2", "xlm-roberta", "gte", "modernbert", "gemma-embedding", "qwen3-embedding"]);
const DIFFUSION_ARCHS = new Set(["flux", "flux2", "sd1", "sd2", "sdxl", "sd3", "wan", "ltx", "qwen_image", "z_image", "hunyuan", "chroma", "hidream", "lumina2"]);
const ENCODER_ARCHS = new Set(["clip", "t5", "t5encoder", "umt5", "clip-vision", "siglip"]);

function ggufInspection(meta: GgufMeta, filename: string): Inspection {
  const kv = meta.kv;
  const arch = String(kv["general.architecture"] ?? "").toLowerCase() || null;
  const type = String(kv["general.type"] ?? "model").toLowerCase();
  const name = (kv["general.name"] as string | undefined) ?? null;
  const ft = kv["general.file_type"];
  const quant = typeof ft === "number" ? QUANT_NAMES[ft] ?? `ft${ft}` : quantFromName(filename);
  const params = typeof kv["general.parameter_count"] === "number" ? (kv["general.parameter_count"] as number) : paramsFromName(name ?? filename);
  const ctx = arch ? (kv[`${arch}.context_length`] as number | undefined) ?? null : null;
  const notes: string[] = [];
  const base: Omit<Inspection, "kind" | "role"> = { format: "gguf", arch, name, quant, params, contextLength: ctx, vision: false, embedding: false, notes };

  if (type === "mmproj" || (arch === "clip" && kv["clip.has_vision_encoder"] !== undefined) || /mmproj/i.test(filename)) {
    return { ...base, kind: "vision", role: "mmproj", vision: true, arch: arch ?? "clip" };
  }
  if (type === "adapter") return { ...base, kind: "text", role: "lora", notes: ["adaptador LoRA (GGUF)"] };
  if (arch && DIFFUSION_ARCHS.has(arch)) return { ...base, kind: "image", role: "diffusion" };
  if (arch && ENCODER_ARCHS.has(arch)) return { ...base, kind: "image", role: "text_encoder" };
  if (arch === "vae") return { ...base, kind: "image", role: "vae" };
  if (arch === "whisper") return { ...base, kind: "speech", role: "main" };
  if (arch && (arch.includes("tts") || arch.includes("outetts") || arch === "wavtokenizer-dec")) return { ...base, kind: "tts", role: arch === "wavtokenizer-dec" ? "vae" : "main" };
  const embedding = !!arch && (EMBEDDING_ARCHS.has(arch) || /embedding|embed/i.test(name ?? filename));
  if (embedding) return { ...base, kind: /rerank/i.test(name ?? filename) ? "rerank" : "embeddings", role: "main", embedding: true };
  if (/rerank/i.test(name ?? filename)) return { ...base, kind: "rerank", role: "main", embedding: true };
  // OCR / vision-language: the text side lives here; needs an mmproj companion
  const isVlm = /ocr|vl\b|vision|-v-|glm4v|qwen2vl|qwen2\.5vl|qwen3vl|llava|minicpmv|gemma3/i.test(`${arch} ${name} ${filename}`);
  if (/ocr/i.test(`${name} ${filename}`)) return { ...base, kind: "ocr", role: "main", vision: true, notes: ["precisa do mmproj correspondente"] };
  return { ...base, kind: "text", role: "main", vision: isVlm, notes: isVlm ? ["modelo com visão: precisa do mmproj correspondente"] : [] };
}

// --------------------------------------------------------- safetensors ---

export function readSafetensorsHeader(file: string): { keys: string[]; dtypes: Set<string>; metadata: Record<string, string>; tensorBytes: number } {
  const fd = fs.openSync(file, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const len = Number(lenBuf.readBigUInt64LE(0));
    if (len <= 0 || len > 512 * 1024 * 1024) throw new Error("header safetensors inválido");
    const hb = Buffer.alloc(len);
    fs.readSync(fd, hb, 0, len, 8);
    const parsed = JSON.parse(hb.toString("utf8")) as Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] } | Record<string, string>>;
    const metadata = (parsed.__metadata__ as Record<string, string> | undefined) ?? {};
    const keys = Object.keys(parsed).filter((k) => k !== "__metadata__");
    const dtypes = new Set<string>();
    let tensorBytes = 0;
    for (const k of keys) {
      const t = parsed[k] as { dtype?: string; data_offsets?: [number, number] };
      if (t.dtype) dtypes.add(t.dtype);
      if (t.data_offsets) tensorBytes = Math.max(tensorBytes, t.data_offsets[1]);
    }
    return { keys, dtypes, metadata, tensorBytes };
  } finally { fs.closeSync(fd); }
}

function safetensorsInspection(file: string, filename: string): Inspection {
  const { keys, dtypes, metadata } = readSafetensorsHeader(file);
  const has = (re: RegExp) => keys.some((k) => re.test(k));
  const dtype = [...dtypes].join(",");
  const quant = /F8|E4M3|E5M2/i.test(dtype) ? "fp8" : dtypes.has("BF16") ? "bf16" : dtypes.has("F16") ? "fp16" : dtypes.has("F32") ? "fp32" : quantFromName(filename);
  const base: Omit<Inspection, "kind" | "role" | "arch"> = { format: "safetensors", name: metadata["modelspec.title"] ?? null, quant, params: paramsFromName(filename), contextLength: null, vision: false, embedding: false, notes: [] };
  const archHint = (metadata["modelspec.architecture"] ?? "").toLowerCase();

  // full checkpoints (SD1.x / SDXL / SD2) carry unet + vae + text encoders under these prefixes
  const hasUnet = has(/^model\.diffusion_model\./);
  const hasVae = has(/^first_stage_model\./) || has(/^vae\./) || has(/^decoder\.(conv_in|mid|up)/);
  const hasClip = has(/^cond_stage_model\./) || has(/^conditioner\.embedders\./) || has(/^text_model\./);
  if (hasUnet && (hasVae || hasClip)) {
    const arch = archHint.includes("sdxl") || has(/^conditioner\.embedders\.1/) ? "sdxl" : archHint.includes("sd-v2") ? "sd2" : "sd1";
    return { ...base, kind: "image", role: "main", arch };
  }
  if (has(/^(double_blocks|single_blocks)\./) || has(/^transformer\.(double|single)_blocks\./)) return { ...base, kind: "image", role: "diffusion", arch: keys.length > 0 && has(/img_in_patch|double_stream_modulation/) ? "flux2" : "flux" };
  if (has(/^blocks\.\d+\.(cross_attn|self_attn|ffn)\./) && has(/patch_embedding/)) return { ...base, kind: "video", role: "diffusion", arch: "wan" };
  if (has(/^transformer_blocks\.\d+\./) && has(/^caption_projection|context_embedder|x_embedder/)) return { ...base, kind: "image", role: "diffusion", arch: archHint.includes("sd3") ? "sd3" : "dit" };
  if (has(/^(encoder|decoder)\.(conv_in|down|up|mid)/) && !hasUnet) return { ...base, kind: "image", role: "vae", arch: "vae" };
  if (has(/^encoder\.block\.\d+\.layer\./) || has(/^shared\.weight$/) && has(/^encoder\.final_layer_norm/)) return { ...base, kind: "image", role: "text_encoder", arch: "t5" };
  if (has(/^text_model\.encoder\.layers\./) && !hasUnet) return { ...base, kind: "image", role: "text_encoder", arch: "clip" };
  if (has(/^model\.layers\.\d+\.(self_attn|mlp)\./) || has(/^layers\.\d+\.attention\./)) {
    // a raw LLM (transformers format): usable by llama.cpp only after conversion; also used as text encoder by flux2/qwen-image
    return { ...base, kind: "text", role: "main", arch: "transformers", notes: ["pesos no formato transformers: converta para GGUF para usar no llama.cpp, ou use como text encoder (Flux.2 / Qwen-Image)"] };
  }
  if (has(/lora_(up|down|A|B)\./) || has(/\.lora_(up|down)\.weight$/) || has(/lora_te|lora_unet/)) return { ...base, kind: "image", role: "lora", arch: "lora" };
  if (has(/^control_model\./) || has(/^controlnet/)) return { ...base, kind: "image", role: "controlnet", arch: "controlnet" };
  if (has(/^(encoder|decoder)\./) && has(/quantizer|codebook/)) return { ...base, kind: "tts", role: "vae", arch: "codec" };
  return { ...base, kind: null, role: "unknown", arch: archHint || null, notes: ["safetensors não classificado: " + keys.slice(0, 5).join(", ")] };
}

// ------------------------------------------------------------- helpers ---

export function quantFromName(name: string): string | null {
  // longest/most specific alternatives first: "Q8_0" must not be read as "Q8"
  const m = name.match(/(?<![a-z0-9])(IQ\d_[A-Z0-9]+|Q\d_K_[SML]|Q\d_[01]|Q\d_K|q8f16|F16|BF16|F32|fp8(?:_e4m3fn(?:_scaled)?)?|fp16|fp32|int8|int4|Q\d)(?![a-z0-9])/i);
  return m ? m[1]!.toUpperCase().replace("FP", "fp") : null;
}

export function paramsFromName(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = name.match(/(?:^|[-_ /.])(\d+(?:\.\d+)?)\s*b(?:[-_ /.]|$)/i);
  return m ? Math.round(Number(m[1]) * 1e9) : null;
}

/** Guess a kind/role from the file name alone. Only used for *planning* — final say is inspectFile(). */
export function guessFromName(filename: string): { kind: ModelKind | null; role: FileRole; format: FileFormat | null } {
  const f = filename.toLowerCase();
  const ext = path.extname(f);
  if (/mmproj/.test(f)) return { kind: "vision", role: "mmproj", format: "gguf" };
  if (ext === ".gguf") {
    if (/whisper/.test(f)) return { kind: "speech", role: "main", format: "gguf" };
    if (/ocr/.test(f)) return { kind: "ocr", role: "main", format: "gguf" };
    if (/embed/.test(f)) return { kind: "embeddings", role: "main", format: "gguf" };
    if (/rerank/.test(f)) return { kind: "rerank", role: "main", format: "gguf" };
    if (/flux|sd3|sdxl|stable-diffusion|wan|ltx|z-image|qwen-image|chroma|hidream/.test(f)) return { kind: /wan|ltx/.test(f) ? "video" : "image", role: /vae|ae\./.test(f) ? "vae" : /t5|clip|umt5|text.?encoder/.test(f) ? "text_encoder" : "diffusion", format: "gguf" };
    return { kind: "text", role: "main", format: "gguf" };
  }
  if (ext === ".bin" && /^ggml-|whisper/.test(path.basename(f))) return { kind: "speech", role: "main", format: "ggml" };
  if (ext === ".safetensors" || ext === ".ckpt" || ext === ".pt") {
    if (/lora/.test(f)) return { kind: "image", role: "lora", format: "safetensors" };
    if (/vae|\bae\b/.test(f)) return { kind: "image", role: "vae", format: "safetensors" };
    if (/t5|clip|umt5|text.?encoder/.test(f)) return { kind: "image", role: "text_encoder", format: "safetensors" };
    if (/controlnet/.test(f)) return { kind: "image", role: "controlnet", format: "safetensors" };
    if (/wan|ltx|hunyuan.?video|cogvideo/.test(f)) return { kind: "video", role: "diffusion", format: "safetensors" };
    if (/flux|sd3|z-image|qwen-image|chroma|hidream/.test(f)) return { kind: "image", role: "diffusion", format: "safetensors" };
    return { kind: "image", role: "main", format: "safetensors" };
  }
  if (ext === ".onnx") {
    // piper voices are named <lang>_<REGION>-<speaker>-<quality>.onnx
    const piper = /^[a-z]{2,3}_[a-z]{2}-[a-z0-9_]+-(x_low|low|medium|high)\.onnx$/i.test(path.basename(f));
    return { kind: /ocr|det|rec|cls/.test(f) ? "ocr" : "tts", role: piper || /voice|piper|kokoro/.test(f) ? "voice" : "main", format: "onnx" };
  }
  if (ext === ".json") return { kind: null, role: "config", format: "json" };
  return { kind: null, role: "unknown", format: null };
}

// --------------------------------------------------------------- entry ---

export function inspectFile(file: string): Inspection {
  const filename = path.basename(file);
  const fd = fs.openSync(file, "r");
  let head: Buffer;
  try { head = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const format = sniffFormat(head);
  const empty = (kind: ModelKind | null, role: FileRole, notes: string[] = []): Inspection =>
    ({ format, kind, role, arch: null, name: null, quant: quantFromName(filename), params: paramsFromName(filename), contextLength: null, vision: false, embedding: false, notes });

  switch (format) {
    case "html": return empty(null, "unknown", ["Isto é uma página HTML, não um modelo. Provavelmente a URL apontava para a página do repositório em vez do arquivo."]);
    case "gguf": try { return ggufInspection(readGgufMeta(file), filename); } catch (e) { return empty("text", "main", [`GGUF com header ilegível: ${(e as Error).message}`]); }
    case "safetensors": try { return safetensorsInspection(file, filename); } catch (e) { return empty(null, "unknown", [`safetensors ilegível: ${(e as Error).message}`]); }
    case "ggml": return { ...empty("speech", "main"), arch: "whisper" };
    case "onnx": { const g = guessFromName(filename); return { ...empty(g.kind ?? "tts", g.role), arch: "onnx" }; }
    case "json": { const g = guessFromName(filename); return empty(g.kind, "config"); }
    case "zip": return empty(null, "unknown", ["arquivo zip: será extraído após o download"]);
    default: { const g = guessFromName(filename); return empty(g.kind, g.role, g.kind ? [] : ["formato não reconhecido"]); }
  }
}

/** Fast, low-cost check for a partially downloaded file: is the head plausible for the expected format? */
export function headLooksValid(head: Buffer, expectedExt: string): { ok: boolean; reason?: string } {
  const f = sniffFormat(head);
  if (f === "html") return { ok: false, reason: "o servidor devolveu uma página HTML em vez do arquivo" };
  const ext = expectedExt.toLowerCase();
  if (ext === ".gguf" && f !== "gguf") return { ok: false, reason: `esperava GGUF, recebi ${f}` };
  if (ext === ".safetensors" && f !== "safetensors") return { ok: false, reason: `esperava safetensors, recebi ${f}` };
  if (ext === ".onnx" && f !== "onnx" && f !== "bin") return { ok: false, reason: `esperava ONNX, recebi ${f}` };
  if (ext === ".json" && f !== "json") return { ok: false, reason: `esperava JSON, recebi ${f}` };
  if (ext === ".zip" && f !== "zip") return { ok: false, reason: `esperava ZIP, recebi ${f}` };
  return { ok: true };
}
