import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { StudioContext } from "../core/context.js";
import { platform } from "../core/system.js";
import { logger } from "../core/log.js";
import { extractPdfImages, type PageImage } from "./extract/pdfimages.js";
import { detectFile } from "./extract/index.js";

const log = logger("ocr");

export interface OcrPage { page: number; markdown: string; image?: string }
export interface OcrResult { pages: OcrPage[]; markdown: string; model: string }

const OCR_PROMPT = "Transcreva TODO o texto desta página em Markdown, na ordem de leitura. "
  + "Preserve tabelas como tabelas Markdown, mantenha números, datas e códigos exatamente como estão "
  + "e não invente nada que não esteja na imagem. Responda só com o conteúdo transcrito.";

/**
 * DOC-03. OCR runs on llama.cpp with a vision model (GLM-OCR and friends): the page becomes an image,
 * the image goes in the chat message, the model writes Markdown. Pages come from the PDF's own
 * embedded images when possible, or from a rasteriser (mutool/pdftoppm) when one is available.
 */
export async function ocrFileToMarkdown(
  ctx: StudioContext, file: string,
  o: { model?: string | null; language?: string; prompt?: string; maxPages?: number; onPage?: (page: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  const detected = detectFile(file);
  const workDir = path.join(ctx.paths.cache, "ocr", `${path.basename(file, path.extname(file))}-${Date.now()}`);
  let images: PageImage[] = [];
  if (detected.kind === "image") {
    images = [{ page: 1, file, width: 0, height: 0, format: file.toLowerCase().endsWith(".png") ? "png" : "jpg" }];
  } else if (detected.kind === "pdf") {
    images = extractPdfImages(file, workDir, { maxPages: o.maxPages });
    if (!images.length) images = rasterize(ctx, file, workDir, o.maxPages);
    if (!images.length) {
      throw new Error("não consegui transformar as páginas em imagem. Instale o mutool ou o pdftoppm (poppler) e tente de novo, ou envie as páginas como PNG/JPG.");
    }
  } else {
    throw new Error(`OCR só aceita PDF ou imagem; este arquivo é '${detected.kind}'`);
  }

  const modelRef = o.model ?? ctx.config.documents.ocrModel ?? defaultOcrModel(ctx);
  if (!modelRef) {
    throw new Error("nenhum modelo de OCR na biblioteca. Baixe um com: aistudio models pull recipe:glm-ocr");
  }
  const found = ctx.engines.findModel(modelRef, ["ocr", "vision", "text"]);
  if (!found) throw new Error(`modelo de OCR '${modelRef}' não está na biblioteca`);
  if (!found.companions.some((c) => c.inspection.role === "mmproj")) {
    throw new Error(`o modelo '${found.model.filename}' não tem o projetor de visão (mmproj) ao lado. Baixe a receita inteira: aistudio models pull recipe:glm-ocr`);
  }
  const instance = await ctx.engines.start(found.model.id, undefined, o.signal);

  const pages: OcrPage[] = [];
  for (const img of images) {
    if (o.signal?.aborted) throw new Error("cancelled");
    o.onPage?.(img.page, images.length);
    const dataUrl = `data:image/${img.format === "jpg" ? "jpeg" : "png"};base64,${fs.readFileSync(img.file).toString("base64")}`;
    const res = await fetch(`${instance.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: o.signal,
      body: JSON.stringify({
        model: found.model.id, temperature: 0, max_tokens: 4096, stream: false,
        messages: [{
          role: "user",
          content: [{ type: "text", text: o.prompt ?? OCR_PROMPT }, { type: "image_url", image_url: { url: dataUrl } }],
        }],
      }),
    });
    if (!res.ok) throw new Error(`OCR página ${img.page} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const markdown = (data.choices?.[0]?.message?.content ?? "").trim();
    pages.push({ page: img.page, markdown, image: img.file });
  }
  const markdown = pages.map((p) => `<!-- página ${p.page} -->\n${p.markdown}`).join("\n\n").trim();
  return { pages, markdown, model: found.model.id };
}

export function defaultOcrModel(ctx: StudioContext): string | null {
  const ocr = ctx.models.registry.list("ocr").filter((m) => m.inspection.role === "main");
  if (ocr.length) return ocr[0]!.id;
  const vision = ctx.models.registry.list("text").find((m) => m.inspection.vision && m.inspection.role === "main");
  return vision?.id ?? null;
}

/** Fallback rasteriser: whatever the machine already has. Never installed silently. */
function rasterize(ctx: StudioContext, pdf: string, outDir: string, maxPages?: number): PageImage[] {
  fs.mkdirSync(outDir, { recursive: true });
  const exeName = (n: string) => (platform() === "win" ? `${n}.exe` : n);
  const candidates: { exe: string; args: (out: string) => string[] }[] = [
    { exe: exeName("mutool"), args: (out) => ["draw", "-r", "200", "-o", path.join(out, "pagina-%03d.png"), pdf, maxPages ? `1-${maxPages}` : "1-N"] },
    { exe: exeName("pdftoppm"), args: (out) => ["-r", "200", "-png", ...(maxPages ? ["-l", String(maxPages)] : []), pdf, path.join(out, "pagina")] },
  ];
  for (const c of candidates) {
    const exe = findOnPath(c.exe) ?? findInEngines(ctx, c.exe);
    if (!exe) continue;
    const r = spawnSync(exe, c.args(outDir), { windowsHide: true, stdio: "pipe" });
    if (r.status !== 0) { log.warn(`${c.exe}: ${r.stderr?.toString().slice(0, 200)}`); continue; }
    const files = fs.readdirSync(outDir).filter((f) => /\.png$/i.test(f)).sort();
    if (files.length) {
      return files.map((f, i) => ({ page: i + 1, file: path.join(outDir, f), width: 0, height: 0, format: "png" as const }));
    }
  }
  return [];
}

function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p)) return p; } catch { /* diretório sumiu */ }
  }
  return null;
}

function findInEngines(ctx: StudioContext, exe: string): string | null {
  const dirs = [path.join(ctx.paths.engines, "mupdf"), path.join(ctx.paths.engines, "poppler")];
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
