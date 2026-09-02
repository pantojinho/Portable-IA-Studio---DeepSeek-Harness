import fs from "node:fs";
import zlib from "node:zlib";

/**
 * DOC-02. PDF → text, written from scratch: pdfjs would drag a large dependency (and a canvas) into a
 * bundle that must stay small, and all the Studio needs here is the text layer plus enough structure
 * to cite a page. A PDF with no text layer (a scan) returns empty pages, which is exactly the signal
 * `documents/ocr.ts` (DOC-03) waits for.
 */
export interface PdfPage { page: number; text: string }
export interface PdfDocument { pages: PdfPage[]; hasText: boolean; encrypted: boolean; info: Record<string, string> }

interface PdfObject { num: number; raw: string; stream: Buffer | null }

export function extractPdf(file: string): PdfDocument {
  return parsePdf(fs.readFileSync(file));
}

export function parsePdf(buf: Buffer): PdfDocument {
  const latin = buf.toString("latin1");
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin);
  const objects = collectObjects(buf, latin);
  const info = readInfo(objects);
  const pageObjs = orderedPages(objects);
  const pages: PdfPage[] = [];
  pageObjs.forEach((pageNum, i) => {
    const page = objects.get(pageNum);
    if (!page) return;
    const fonts = pageFonts(page.raw, objects);
    const content = contentFor(page.raw, objects);
    pages.push({ page: i + 1, text: contentText(content, fonts).trim() });
  });
  if (!pages.length) {
    // no page tree we could follow: fall back to every content-looking stream, in file order
    let n = 0;
    for (const obj of objects.values()) {
      if (!obj.stream) continue;
      const text = contentText(obj.stream.toString("latin1"), new Map());
      if (text.trim()) pages.push({ page: ++n, text: text.trim() });
    }
  }
  return { pages, hasText: pages.some((p) => p.text.length > 8), encrypted, info };
}

// --------------------------------------------------------------- objects ---

function collectObjects(buf: Buffer, latin: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const endIdx = latin.indexOf("endobj", start);
    const body = latin.slice(start, endIdx < 0 ? Math.min(latin.length, start + 200_000) : endIdx);
    const streamAt = body.indexOf("stream");
    let stream: Buffer | null = null;
    let raw = body;
    if (streamAt >= 0) {
      raw = body.slice(0, streamAt);
      const dataStart = start + streamAt + (body.slice(streamAt).startsWith("stream\r\n") ? 8 : 7);
      const declared = Number(/\/Length\s+(\d+)/.exec(raw)?.[1] ?? NaN);
      const endStream = latin.indexOf("endstream", dataStart);
      const end = Number.isFinite(declared) && dataStart + declared <= buf.length && (endStream < 0 || dataStart + declared <= endStream + 2)
        ? dataStart + declared
        : endStream < 0 ? buf.length : endStream;
      stream = decodeStream(buf.subarray(dataStart, end), raw);
    }
    objects.set(num, { num, raw, stream });
  }
  // objects packed inside object streams (PDF 1.5+) — very common in modern files
  for (const obj of [...objects.values()]) {
    if (!obj.stream || !/\/Type\s*\/ObjStm/.test(obj.raw)) continue;
    for (const [num, raw] of parseObjStm(obj)) if (!objects.has(num)) objects.set(num, { num, raw, stream: null });
  }
  return objects;
}

function decodeStream(data: Buffer, dict: string): Buffer | null {
  const filters = [...dict.matchAll(/\/Filter\s*(?:\/(\w+)|\[([^\]]*)\])/g)].flatMap((m) => m[1] ? [m[1]] : (m[2] ?? "").split("/").map((s) => s.trim()).filter(Boolean));
  let out: Buffer = Buffer.from(data);
  for (const f of filters.length ? filters : ["None"]) {
    try {
      if (f === "FlateDecode") out = zlib.inflateSync(out);
      else if (f === "LZWDecode" || f === "DCTDecode" || f === "JPXDecode" || f === "CCITTFaxDecode" || f === "JBIG2Decode") return null; // imagem: é caso de OCR
      else if (f === "ASCIIHexDecode") out = Buffer.from(out.toString("latin1").replace(/[^0-9a-f]/gi, "").replace(/(..)/g, "$1 ").trim().split(" ").map((h) => parseInt(h, 16)));
      else if (f === "ASCII85Decode") out = ascii85(out);
    } catch { return null; }
  }
  // /Predictor 12 (PNG up) is used by xref streams; content streams rarely need it
  if (/\/Predictor\s+1[0-5]/.test(dict)) {
    const columns = Number(/\/Columns\s+(\d+)/.exec(dict)?.[1] ?? 1);
    out = pngPredictor(out, columns);
  }
  return out;
}

function parseObjStm(obj: PdfObject): [number, string][] {
  const data = obj.stream!.toString("latin1");
  const n = Number(/\/N\s+(\d+)/.exec(obj.raw)?.[1] ?? 0);
  const first = Number(/\/First\s+(\d+)/.exec(obj.raw)?.[1] ?? 0);
  const header = data.slice(0, first).trim().split(/\s+/).map(Number);
  const out: [number, string][] = [];
  for (let i = 0; i < n; i++) {
    const num = header[i * 2];
    const off = header[i * 2 + 1];
    if (num === undefined || off === undefined) break;
    const nextOff = header[i * 2 + 3];
    out.push([num, data.slice(first + off, nextOff === undefined ? undefined : first + nextOff)]);
  }
  return out;
}

/** Page order from the page tree; falls back to object order when the tree is broken. */
function orderedPages(objects: Map<number, PdfObject>): number[] {
  const pagesNodes = [...objects.values()].filter((o) => /\/Type\s*\/Pages\b/.test(o.raw));
  const root = pagesNodes.find((o) => !/\/Parent\b/.test(o.raw)) ?? pagesNodes[0];
  const order: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth = 0) => {
    if (depth > 64 || seen.has(num)) return;
    seen.add(num);
    const o = objects.get(num);
    if (!o) return;
    if (/\/Type\s*\/Page\b/.test(o.raw) && !/\/Type\s*\/Pages\b/.test(o.raw)) { order.push(num); return; }
    for (const kid of refs(/\/Kids\s*\[([^\]]*)\]/.exec(o.raw)?.[1] ?? "")) walk(kid, depth + 1);
  };
  if (root) walk(root.num);
  if (!order.length) {
    for (const o of objects.values()) if (/\/Type\s*\/Page\b/.test(o.raw) && !/\/Type\s*\/Pages\b/.test(o.raw)) order.push(o.num);
  }
  return order;
}

function refs(s: string): number[] {
  return [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
}

function contentFor(pageRaw: string, objects: Map<number, PdfObject>): string {
  const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(pageRaw)?.[1] ?? "";
  const parts: string[] = [];
  for (const num of refs(contents)) {
    const o = objects.get(num);
    if (o?.stream) parts.push(o.stream.toString("latin1"));
  }
  return parts.join("\n");
}

function readInfo(objects: Map<number, PdfObject>): Record<string, string> {
  const info: Record<string, string> = {};
  for (const o of objects.values()) {
    if (!/\/(Title|Author|Producer|CreationDate)\s*\(/.test(o.raw)) continue;
    for (const m of o.raw.matchAll(/\/(Title|Author|Subject|Producer|Creator|CreationDate)\s*\(([^)]*)\)/g)) {
      info[m[1]!.toLowerCase()] = decodePdfString(m[2]!, null);
    }
    if (Object.keys(info).length) break;
  }
  return info;
}

// ----------------------------------------------------------------- fonts ---

type CMap = Map<number, string>;

function pageFonts(pageRaw: string, objects: Map<number, PdfObject>): Map<string, CMap> {
  const fonts = new Map<string, CMap>();
  const resRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageRaw)?.[1];
  const resources = resRef ? objects.get(Number(resRef))?.raw ?? "" : (/\/Resources\s*<<([\s\S]*?)>>\s*(?:\/|$)/.exec(pageRaw)?.[1] ?? pageRaw);
  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
  for (const m of fontDict.matchAll(/\/([^\s/]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fontObj = objects.get(Number(m[2]));
    if (!fontObj) continue;
    const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObj.raw)?.[1];
    const cmapObj = toUnicodeRef ? objects.get(Number(toUnicodeRef)) : undefined;
    if (cmapObj?.stream) fonts.set(m[1]!, parseCMap(cmapObj.stream.toString("latin1")));
  }
  return fonts;
}

/** ToUnicode CMaps map character codes to UTF-16 — without them, subset fonts read as garbage. */
export function parseCMap(text: string): CMap {
  const map: CMap = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1]!, 16), utf16beToString(m[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
      const from = parseInt(m[1]!, 16), to = parseInt(m[2]!, 16);
      if (m[3]) {
        const base = parseInt(m[3], 16);
        for (let c = from; c <= to && c - from < 65536; c++) map.set(c, String.fromCodePoint(base + (c - from)));
      } else if (m[4]) {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16beToString(x[1]!));
        items.forEach((s, i) => map.set(from + i, s));
      }
    }
  }
  return map;
}

function utf16beToString(hex: string): string {
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16);
    if (!Number.isNaN(code)) out += String.fromCharCode(code);
  }
  return out || String.fromCharCode(parseInt(hex, 16) || 32);
}

// -------------------------------------------------------------- content ---

/**
 * Walk the content stream operators that produce text: Tj, ', ", TJ (with kerning that becomes a
 * space), Tf (font switch) and the positioning operators that end a line.
 */
export function contentText(content: string, fonts: Map<string, CMap>): string {
  type Operand = number | { name: string } | { s: string } | { mark: "[" | "]" };
  let out = "";
  let font: CMap | null = null;
  let i = 0;
  const stack: Operand[] = [];
  const flushLine = () => { if (!out.endsWith("\n")) out += "\n"; };

  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "(") {
      const { text, next } = readLiteral(content, i);
      stack.push({ s: text });
      i = next;
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end < 0) break;
      stack.push({ s: hexString(content.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (ch === "[" || ch === "]") { stack.push({ mark: ch }); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < content.length && !/[\s()<>[\]]/.test(content[j]!)) j++;
    const token = content.slice(i, j);
    i = j;
    if (token.startsWith("/")) { stack.push({ name: token.slice(1) }); continue; }   // /F1 é operando
    if (/^[-+.\d]/.test(token)) { stack.push(Number(token)); continue; }
    switch (token) {
      case "Tf": {
        const name = [...stack].reverse().find((x): x is { name: string } => typeof x === "object" && "name" in x);
        font = name ? fonts.get(name.name) ?? null : null;
        break;
      }
      case "Tj": {
        const s1 = lastString(stack);
        if (s1 !== null) out += decodePdfString(s1, font);
        break;
      }
      case "'": case '"': {
        flushLine();
        const s2 = lastString(stack);
        if (s2 !== null) out += decodePdfString(s2, font);
        break;
      }
      case "TJ": {
        for (const it of stack) {
          if (typeof it === "number") { if (it <= -120) out += " "; }
          else if ("s" in it) out += decodePdfString(it.s, font);
        }
        break;
      }
      case "Td": case "TD": case "T*": case "ET": flushLine(); break;
      default: break;
    }
    stack.length = 0;   // um operador consome seus operandos
  }
  return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

function lastString(stack: readonly (number | { name: string } | { s: string } | { mark: string })[]): string | null {
  for (let k = stack.length - 1; k >= 0; k--) {
    const v = stack[k];
    if (v && typeof v === "object" && "s" in v) return v.s;
  }
  return null;
}

function readLiteral(content: string, start: number): { text: string; next: number } {
  let depth = 0, out = "", i = start;
  for (; i < content.length; i++) {
    const c = content[i]!;
    if (c === "\\") {
      const n = content[i + 1] ?? "";
      const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0];
      if (octal) { out += String.fromCharCode(parseInt(octal, 8)); i += octal.length; continue; }
      out += { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[n] ?? n;
      i++;
      continue;
    }
    if (c === "(") { depth++; if (depth === 1) continue; }
    if (c === ")") { depth--; if (depth === 0) { i++; break; } }
    if (depth > 0) out += c;
  }
  return { text: out, next: i };
}

function hexString(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  return out;
}

/** Without a CMap, PDF text is PDFDocEncoding/WinAnsi — close enough to latin1 for Portuguese. */
export function decodePdfString(s: string, font: CMap | null): string {
  if (!font || font.size === 0) {
    if (s.startsWith("\xFE\xFF")) { // UTF-16BE marker
      let out = "";
      for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
      return out;
    }
    return s;
  }
  // two-byte codes when the CMap only knows values above 255
  const twoByte = [...font.keys()].some((k) => k > 255);
  let out = "";
  if (twoByte) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      const code = (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1);
      out += font.get(code) ?? "";
    }
    return out;
  }
  for (const ch of s) out += font.get(ch.charCodeAt(0)) ?? ch;
  return out;
}

function ascii85(buf: Buffer): Buffer {
  const s = buf.toString("latin1").replace(/\s/g, "").replace(/^<~/, "").replace(/~>$/, "");
  const out: number[] = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === "z") { out.push(0, 0, 0, 0); i++; continue; }
    const chunk = s.slice(i, i + 5).padEnd(5, "u");
    let n = 0;
    for (const c of chunk) n = n * 85 + (c.charCodeAt(0) - 33);
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, Math.min(4, s.length - i - 1)));
    i += 5;
  }
  return Buffer.from(out);
}

function pngPredictor(data: Buffer, columns: number): Buffer {
  const rowLen = columns + 1;
  if (data.length % rowLen !== 0) return data;
  const out = Buffer.alloc((data.length / rowLen) * columns);
  let prev = Buffer.alloc(columns);
  for (let r = 0; r * rowLen < data.length; r++) {
    const type = data[r * rowLen]!;
    const row = Buffer.from(data.subarray(r * rowLen + 1, r * rowLen + 1 + columns));
    if (type === 2) for (let i = 0; i < columns; i++) row[i] = (row[i]! + prev[i]!) & 255;
    row.copy(out, r * columns);
    prev = row;
  }
  return out;
}
