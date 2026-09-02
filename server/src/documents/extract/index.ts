import fs from "node:fs";
import path from "node:path";
import { extractDocx, extractPptx, extractXlsx, type ExtractedDoc } from "./office.js";
import { extractPdf } from "./pdf.js";
import { extractCsv, extractEml, extractHtml, extractPlain, readTextFile } from "./text.js";
import { ZipFile } from "./zip.js";

/**
 * DOC-02. What a file *is* comes from its bytes first and its name second — the same rule the model
 * library follows (AGENTS.md §2.4). Types the Studio cannot read as text (images, scanned PDFs,
 * audio, video) are reported so the ingester can route them to OCR (DOC-03) or whisper (AUD-01).
 */
export type DocKind = "pdf" | "docx" | "xlsx" | "pptx" | "eml" | "html" | "csv" | "text" | "image" | "audio" | "video" | "archive" | "unknown";

export interface DetectedFile { kind: DocKind; mime: string; ext: string }

const MIME: Record<DocKind, string> = {
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822", html: "text/html", csv: "text/csv", text: "text/plain",
  image: "image/*", audio: "audio/*", video: "video/*", archive: "application/zip", unknown: "application/octet-stream",
};

export function detectFile(file: string): DetectedFile {
  const ext = path.extname(file).toLowerCase();
  const head = readHead(file, 16);   // 16 bytes cobrem RIFF/WAVE, ftyp e PNG
  const kind = detectKind(file, head, ext);
  return { kind, mime: MIME[kind], ext: ext.replace(".", "") };
}

function detectKind(file: string, head: Buffer, ext: string): DocKind {
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b) return zipKind(file, ext);      // PK: OOXML ou zip
  if (head.subarray(0, 3).toString("latin1") === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return "audio";
  if (head.subarray(0, 4).toString("latin1") === "RIFF") return head.subarray(8, 12).toString("latin1") === "WAVE" ? "audio" : "video";
  if (head.subarray(0, 4).toString("latin1") === "OggS" || head.subarray(0, 4).toString("latin1") === "fLaC") return "audio";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return [".m4a", ".m4b", ".aac"].includes(ext) ? "audio" : "video";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video";   // matroska/webm
  if (head.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n" || (head[0] === 0xff && head[1] === 0xd8)) return "image";
  if (head.subarray(0, 6).toString("latin1").startsWith("GIF8") || head.subarray(0, 2).toString("latin1") === "BM") return "image";
  if ([".tif", ".tiff"].includes(ext) || head.subarray(0, 4).toString("latin1") === "II*\0") return "image";
  if (ext === ".webp" || head.subarray(8, 12).toString("latin1") === "WEBP") return "image";

  const sample = sampleText(file);
  if (/^\s*(from|to|subject|date|received|message-id|mime-version)\s*:/im.test(sample.slice(0, 2000)) && /\n\s*\n/.test(sample)) return "eml";
  if (/<html|<!doctype html|<body|<div|<p>/i.test(sample.slice(0, 4000))) return "html";
  if (ext === ".csv" || ext === ".tsv" || looksTabular(sample)) return "csv";
  if (ext === ".eml" || ext === ".mbox") return "eml";
  if (sample.trim()) return "text";
  return "unknown";
}

function zipKind(file: string, ext: string): DocKind {
  try {
    const zip = ZipFile.fromBuffer(fs.readFileSync(file));
    if (zip.has("word/document.xml")) return "docx";
    if (zip.has("xl/workbook.xml") || zip.names(/^xl\/worksheets\//).length) return "xlsx";
    if (zip.names(/^ppt\/slides\/slide\d+\.xml$/).length) return "pptx";
    if (zip.has("content.xml")) return "archive";   // ODF: sem suporte ainda
    return "archive";
  } catch { return ext === ".docx" ? "docx" : ext === ".xlsx" ? "xlsx" : ext === ".pptx" ? "pptx" : "archive"; }
}

function looksTabular(sample: string): boolean {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  if (lines.length < 2) return false;
  for (const d of [",", ";", "\t"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) return true;
  }
  return false;
}

/** Text of a document as Markdown. Returns `needsOcr` when there is nothing to read. */
export interface ExtractionResult extends ExtractedDoc { kind: DocKind; needsOcr: boolean; needsTranscription: boolean; pagesText?: { page: number; text: string }[] }

export function extractDocument(file: string): ExtractionResult {
  const { kind } = detectFile(file);
  switch (kind) {
    case "pdf": {
      const doc = extractPdf(file);
      const markdown = doc.pages.map((p) => `<!-- página ${p.page} -->\n${p.text}`).join("\n\n").trim();
      return {
        kind, markdown, pages: doc.pages.length, pagesText: doc.pages,
        meta: { format: "pdf", encrypted: doc.encrypted, ...doc.info },
        needsOcr: !doc.hasText, needsTranscription: false,
      };
    }
    case "docx": return { kind, ...extractDocx(file), needsOcr: false, needsTranscription: false };
    case "xlsx": return { kind, ...extractXlsx(file), needsOcr: false, needsTranscription: false };
    case "pptx": return { kind, ...extractPptx(file), needsOcr: false, needsTranscription: false };
    case "eml": { const { mail, ...rest } = extractEml(file); void mail; return { kind, ...rest, needsOcr: false, needsTranscription: false }; }
    case "html": return { kind, ...extractHtml(file), needsOcr: false, needsTranscription: false };
    case "csv": return { kind, ...extractCsv(file), needsOcr: false, needsTranscription: false };
    case "text": return { kind, ...extractPlain(file), needsOcr: false, needsTranscription: false };
    case "image": return { kind, markdown: "", meta: { format: "image" }, needsOcr: true, needsTranscription: false };
    case "audio": case "video": return { kind, markdown: "", meta: { format: kind }, needsOcr: false, needsTranscription: true };
    default:
      return { kind, markdown: safePlain(file), meta: { format: "desconhecido" }, needsOcr: false, needsTranscription: false };
  }
}

function safePlain(file: string): string {
  try { const t = readTextFile(file); return /�/.test(t) ? "" : t.trim(); } catch { return ""; }
}

function readHead(file: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  let fd: number | null = null;
  try { fd = fs.openSync(file, "r"); const read = fs.readSync(fd, buf, 0, n, 0); return buf.subarray(0, read); }
  catch { return Buffer.alloc(0); }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* */ } }
}

function sampleText(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(8192, fs.statSync(file).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const s = buf.toString("utf8");
    return s.includes("�") ? buf.toString("latin1") : s;
  } catch { return ""; }
}
