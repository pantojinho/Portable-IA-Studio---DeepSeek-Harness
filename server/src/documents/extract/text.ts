import fs from "node:fs";
import path from "node:path";
import type { ExtractedDoc } from "./office.js";

/**
 * DOC-02. The easy formats, still without dependencies: plain text, Markdown, CSV/TSV, HTML and
 * e-mail (.eml). Everything comes out as Markdown so chunking, search and citations see one shape.
 */

export function extractPlain(file: string): ExtractedDoc {
  return { markdown: readTextFile(file).trim(), meta: { format: path.extname(file).slice(1) || "txt" } };
}

// ------------------------------------------------------------------- csv ---

export function extractCsv(file: string): ExtractedDoc {
  const raw = readTextFile(file);
  const rows = parseDelimited(raw);
  if (!rows.length) return { markdown: "", meta: { format: "csv", rows: 0 } };
  const header = rows[0]!;
  const body = rows.slice(1);
  const table = [`| ${header.map(escapeCell).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${header.map((_, i) => escapeCell(r[i] ?? "")).join(" | ")} |`)];
  return { markdown: table.join("\n"), meta: { format: "csv", rows: body.length, columns: header } };
}

/** RFC-4180 with a twist: Brazilian exports often use ';' and commas inside numbers. */
export function parseDelimited(raw: string, delimiter?: string): string[][] {
  const text = raw.replace(/^\uFEFF/, "");
  const delim = delimiter ?? guessDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function guessDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  const counts = [",", ";", "\t", "|"].map((d) => [d, sample.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts.sort((a, b) => b[1] - a[1])[0]![0] : ",";
}

// ------------------------------------------------------------------ html ---

export function extractHtml(file: string): ExtractedDoc {
  return { markdown: htmlToMarkdown(readTextFile(file)), meta: { format: "html" } };
}

/** A small, predictable HTML→Markdown: headings, lists, links, tables, code, and nothing else. */
export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/\r\n?/g, "\n");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|tr|li|h[1-6])>/gi, "\n");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `);
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<t[dh][^>]*>/gi, " | ");
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
    const clean = stripTags(text).trim();
    return clean ? `[${clean}](${href})` : href;
  });
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**").replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return title && !s.startsWith(`# ${title}`) ? `# ${title}\n\n${s}` : s;
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, ""); }

export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", atilde: "ã", otilde: "õ", ccedil: "ç", acirc: "â", ecirc: "ê", ocirc: "ô", agrave: "à" };
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (all, name: string) => named[name.toLowerCase()] ?? all);
}

// ------------------------------------------------------------------- eml ---

export interface ParsedMail { from: string; to: string; subject: string; date: string; body: string; attachments: { filename: string; content: Buffer }[] }

export function extractEml(file: string): ExtractedDoc & { mail: ParsedMail } {
  const mail = parseEml(fs.readFileSync(file));
  const md = [`# ${mail.subject || "(sem assunto)"}`, "", `- De: ${mail.from}`, `- Para: ${mail.to}`, `- Data: ${mail.date}`,
    mail.attachments.length ? `- Anexos: ${mail.attachments.map((a) => a.filename).join(", ")}` : "", "", mail.body].filter((l) => l !== "").join("\n");
  return { markdown: md.trim(), meta: { format: "eml", attachments: mail.attachments.map((a) => a.filename) }, mail };
}

/** MIME parsing good enough for real mail: multipart, quoted-printable, base64, HTML fallback. */
export function parseEml(buf: Buffer): ParsedMail {
  const raw = buf.toString("latin1");
  const { headers, body } = splitHeaders(raw);
  const boundary = /boundary="?([^";\s]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  const attachments: { filename: string; content: Buffer }[] = [];
  let text = "";
  let html = "";
  const handlePart = (partHeaders: Record<string, string>, partBody: string) => {
    const type = (partHeaders["content-type"] ?? "text/plain").toLowerCase();
    const encoding = (partHeaders["content-transfer-encoding"] ?? "7bit").toLowerCase();
    const disposition = partHeaders["content-disposition"] ?? "";
    const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? /name="?([^";]+)"?/i.exec(type)?.[1];
    const decoded = decodeBody(partBody, encoding, charsetOf(type));
    if (filename && /attachment|inline/i.test(disposition)) {
      attachments.push({ filename: decodeHeader(filename), content: encoding === "base64" ? Buffer.from(partBody.replace(/\s/g, ""), "base64") : Buffer.from(decoded, "utf8") });
      return;
    }
    if (type.startsWith("text/html")) html += decoded;
    else if (type.startsWith("text/")) text += decoded;
  };
  if (boundary) {
    for (const part of splitParts(body, boundary)) {
      const p = splitHeaders(part);
      const inner = /boundary="?([^";\s]+)"?/i.exec(p.headers["content-type"] ?? "")?.[1];
      if (inner) for (const sub of splitParts(p.body, inner)) { const q = splitHeaders(sub); handlePart(q.headers, q.body); }
      else handlePart(p.headers, p.body);
    }
  } else handlePart(headers, body);
  const bodyText = (text.trim() || htmlToMarkdown(html)).trim();
  return {
    from: decodeHeader(headers.from ?? ""), to: decodeHeader(headers.to ?? ""),
    subject: decodeHeader(headers.subject ?? ""), date: headers.date ?? "",
    body: bodyText, attachments,
  };
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const sep = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const idx = raw.indexOf(sep);
  const head = idx < 0 ? raw : raw.slice(0, idx);
  const body = idx < 0 ? "" : raw.slice(idx + sep.length);
  const headers: Record<string, string> = {};
  let current = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) { headers[current] += ` ${line.trim()}`; continue; }
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    current = m[1]!.toLowerCase();
    headers[current] = m[2] ?? "";
  }
  return { headers, body };
}

function splitParts(body: string, boundary: string): string[] {
  return body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\r?\n?`))
    .map((p) => p.replace(/^\r?\n/, ""))
    .filter((p) => p.trim());
}

function decodeBody(body: string, encoding: string, charset: string): string {
  if (encoding === "base64") return Buffer.from(body.replace(/\s/g, ""), "base64").toString(charset as BufferEncoding);
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body, charset);
  return Buffer.from(body, "latin1").toString(charset as BufferEncoding);
}

export function decodeQuotedPrintable(s: string, charset = "utf8"): string {
  const bytes: number[] = [];
  const text = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /[0-9a-f]{2}/i.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(text.charCodeAt(i) & 255);
  }
  return Buffer.from(bytes).toString(charset as BufferEncoding);
}

/** "=?UTF-8?B?...?=" subjects. */
export function decodeHeader(s: string): string {
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, enc: string, data: string) => {
    const cs = normalizeCharset(charset);
    return enc.toLowerCase() === "b"
      ? Buffer.from(data, "base64").toString(cs as BufferEncoding)
      : decodeQuotedPrintable(data.replace(/_/g, " "), cs);
  }).trim();
}

function charsetOf(contentType: string): string { return normalizeCharset(/charset="?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8"); }
function normalizeCharset(cs: string): string {
  const c = cs.toLowerCase().replace(/["']/g, "");
  if (c === "utf-8" || c === "utf8") return "utf8";
  if (c === "us-ascii" || c === "ascii") return "ascii";
  return "latin1"; // iso-8859-1/windows-1252: Node lê como latin1 sem módulo extra
}

function escapeCell(s: string): string { return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim(); }

/** Files arrive in UTF-8 or latin1; the BOM and a decode probe decide. */
export function readTextFile(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  const utf8 = buf.toString("utf8");
  return utf8.includes("\uFFFD") ? buf.toString("latin1") : utf8;
}
