import { ZipFile } from "./zip.js";

/**
 * DOC-02. Word, Excel and PowerPoint → Markdown, reading the OOXML directly. The goal is not perfect
 * fidelity: it is text a model can quote from, with headings, tables and sheet names preserved so the
 * citation (DOC-05) can point at something the user recognises.
 */
export interface ExtractedDoc { markdown: string; pages?: number; meta?: Record<string, unknown> }

// ------------------------------------------------------------------ docx ---

export function extractDocx(file: string): ExtractedDoc {
  const zip = ZipFile.open(file);
  const xml = zip.text("word/document.xml");
  const body = xml.slice(xml.indexOf("<w:body"), xml.lastIndexOf("</w:body>"));
  const blocks: string[] = [];
  for (const block of splitBlocks(body)) {
    if (block.tag === "tbl") { blocks.push(docxTable(block.xml)); continue; }
    const style = attr(block.xml.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1]);
    const text = paragraphText(block.xml);
    if (!text.trim()) continue;
    const heading = /^Heading(\d)/i.exec(style ?? "") ?? /^Ttulo(\d)|^Título(\d)/i.exec(style ?? "");
    if (heading) blocks.push(`${"#".repeat(Math.min(6, Number(heading[1]) || 1))} ${text}`);
    else if (/ListParagraph/i.test(style ?? "")) blocks.push(`- ${text}`);
    else blocks.push(text);
  }
  return { markdown: blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(), meta: { format: "docx" } };
}

function splitBlocks(body: string): { tag: "p" | "tbl"; xml: string }[] {
  const out: { tag: "p" | "tbl"; xml: string }[] = [];
  const re = /<w:(p|tbl)(?:\s[^>]*)?>([\s\S]*?)<\/w:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push({ tag: m[1] as "p" | "tbl", xml: m[0]! });
  return out;
}

function paragraphText(xml: string): string {
  let out = "";
  const re = /<w:(t|tab|br)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1] === "t") out += decodeXml(m[2] ?? "");
    else if (m[1] === "tab") out += "\t";
    else out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

function docxTable(xml: string): string {
  const rows: string[][] = [];
  const rowRe = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cellRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1]!))) cells.push(paragraphText(c[1]!).replace(/\n/g, " ").replace(/\|/g, "\\|"));
    if (cells.length) rows.push(cells);
  }
  return markdownTable(rows);
}

// ------------------------------------------------------------------ xlsx ---

export function extractXlsx(file: string): ExtractedDoc {
  const zip = ZipFile.open(file);
  const shared = zip.has("xl/sharedStrings.xml") ? sharedStrings(zip.text("xl/sharedStrings.xml")) : [];
  const names = sheetNames(zip);
  const parts: string[] = [];
  let sheets = 0;
  for (const [target, name] of names) {
    if (!zip.has(target)) continue;
    const rows = sheetRows(zip.text(target), shared);
    if (!rows.length) continue;
    sheets++;
    parts.push(`## ${name}`, "", markdownTable(rows), "");
  }
  return { markdown: parts.join("\n").trim(), pages: sheets, meta: { format: "xlsx", sheets: names.map(([, n]) => n) } };
}

function sheetNames(zip: ZipFile): [string, string][] {
  const out: [string, string][] = [];
  try {
    const wb = zip.text("xl/workbook.xml");
    const rels = zip.has("xl/_rels/workbook.xml.rels") ? zip.text("xl/_rels/workbook.xml.rels") : "";
    const relMap = new Map<string, string>();
    const relRe = /Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = relRe.exec(rels))) relMap.set(rm[1]!, rm[2]!.replace(/^\/?xl\//, ""));
    const re = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wb))) {
      const target = relMap.get(m[2]!) ?? `worksheets/sheet${out.length + 1}.xml`;
      out.push([`xl/${target}`.replace("xl/xl/", "xl/"), decodeXml(m[1]!)]);
    }
  } catch { /* planilha sem workbook.xml: cai no fallback */ }
  if (!out.length) for (const n of zip.names(/^xl\/worksheets\/sheet\d+\.xml$/)) out.push([n, n.replace(/.*\/(.*)\.xml/, "$1")]);
  return out;
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1]!))) text += decodeXml(t[1]!);
    out.push(text);
  }
  return out;
}

function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let r: RegExpExecArray | null;
  while ((r = rowRe.exec(xml))) {
    const cells: string[] = [];
    const cellRe = /<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(r[1]!))) {
      const attrs = c[1] ?? "";
      const inner = c[2] ?? "";
      const col = columnIndex(/r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "");
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "inlineStr") value = decodeXml((/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner)?.[1]) ?? "");
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
        value = type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
      }
      if (col >= 0) { while (cells.length < col) cells.push(""); cells[col] = value.replace(/\|/g, "\\|"); }
      else cells.push(value);
    }
    while (cells.length && cells.at(-1) === "") cells.pop();
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** "A" → 0, "B" → 1, "AA" → 26. */
export function columnIndex(ref: string): number {
  if (!ref) return -1;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ------------------------------------------------------------------ pptx ---

export function extractPptx(file: string): ExtractedDoc {
  const zip = ZipFile.open(file);
  const slides = zip.names(/^ppt\/slides\/slide\d+\.xml$/).sort(byNumber);
  const parts: string[] = [];
  slides.forEach((name, i) => {
    const xml = zip.text(name);
    const lines: string[] = [];
    const paraRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
    let p: RegExpExecArray | null;
    while ((p = paraRe.exec(xml))) {
      let text = "";
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(p[1]!))) text += decodeXml(t[1]!);
      if (text.trim()) lines.push(text.trim());
    }
    const notesName = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    const notes: string[] = [];
    if (zip.has(notesName)) {
      const nx = zip.text(notesName);
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(nx))) { const s = decodeXml(t[1]!).trim(); if (s) notes.push(s); }
    }
    parts.push(`## Slide ${i + 1}`, "", ...(lines.length ? [lines[0]!, "", ...lines.slice(1).map((l) => `- ${l}`)] : ["(sem texto)"]));
    if (notes.length) parts.push("", `> Notas: ${notes.join(" ")}`);
    parts.push("");
  });
  return { markdown: parts.join("\n").trim(), pages: slides.length, meta: { format: "pptx", slides: slides.length } };
}

// ---------------------------------------------------------------- helpers ---

export function markdownTable(rows: string[][]): string {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const head = pad(rows[0]!);
  const body = rows.slice(1).map(pad);
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function decodeXml(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attr(v: string | undefined): string | undefined { return v; }
function byNumber(a: string, b: string): number {
  return (Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}
