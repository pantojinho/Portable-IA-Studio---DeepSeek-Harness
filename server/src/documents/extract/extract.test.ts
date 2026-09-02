import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ZipFile } from "./zip.js";
import { extractDocx, extractXlsx, extractPptx, markdownTable, columnIndex } from "./office.js";
import { parsePdf } from "./pdf.js";
import { parseDelimited, htmlToMarkdown, parseEml, decodeHeader, decodeQuotedPrintable, guessDelimiter } from "./text.js";
import { detectFile, extractDocument } from "./index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-doc-"));

/** Minimal ZIP writer (only used by these tests) so we can build real .docx/.xlsx files. */
function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(deflated.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A real (tiny) PDF with an uncompressed content stream. */
function makePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  objs.forEach((o, i) => { pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  pdf += "trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF";
  return Buffer.from(pdf, "latin1");
}

describe("documents/extract", () => {
  it("lê um ZIP escrito de verdade (deflate e stored)", () => {
    const buf = makeZip({ "a.txt": "olá mundo", "b/c.txt": "segundo" });
    const zip = ZipFile.fromBuffer(buf);
    expect(zip.names().sort()).toEqual(["a.txt", "b/c.txt"]);
    expect(zip.text("a.txt")).toBe("olá mundo");
    expect(() => zip.read("nao-existe")).toThrow(/não existe/);
  });

  it("extrai DOCX com títulos, listas e tabelas", () => {
    const dir = tmp();
    const file = path.join(dir, "doc.docx");
    fs.writeFileSync(file, makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": `<?xml version="1.0"?><w:document><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Contrato de Prestação</w:t></w:r></w:p>
        <w:p><w:r><w:t>Cláusula &amp; primeira.</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t>Item um</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Produto</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Valor</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Café</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10,00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`,
    }));
    const md = extractDocx(file).markdown;
    expect(md).toContain("# Contrato de Prestação");
    expect(md).toContain("Cláusula & primeira.");
    expect(md).toContain("- Item um");
    expect(md).toContain("| Produto | Valor |");
    expect(md).toContain("| Café | 10,00 |");
    expect(detectFile(file).kind).toBe("docx");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extrai XLSX com nomes de planilha e strings compartilhadas", () => {
    const dir = tmp();
    const file = path.join(dir, "p.xlsx");
    fs.writeFileSync(file, makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Notas" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Chave</t></si><si><t>Valor</t></si><si><t>NF 123</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500.5</v></c></row>
      </sheetData></worksheet>`,
    }));
    const out = extractXlsx(file);
    expect(out.markdown).toContain("## Notas");
    expect(out.markdown).toContain("| Chave | Valor |");
    expect(out.markdown).toContain("| NF 123 | 1500.5 |");
    expect(detectFile(file).kind).toBe("xlsx");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extrai PPTX slide a slide, com notas", () => {
    const dir = tmp();
    const file = path.join(dir, "s.pptx");
    fs.writeFileSync(file, makeZip({
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Título do slide</a:t></a:r></a:p><a:p><a:r><a:t>Ponto um</a:t></a:r></a:p></p:sld>`,
      "ppt/notesSlides/notesSlide1.xml": `<p:notes><a:p><a:r><a:t>Falar devagar</a:t></a:r></a:p></p:notes>`,
    }));
    const out = extractPptx(file);
    expect(out.pages).toBe(1);
    expect(out.markdown).toContain("## Slide 1");
    expect(out.markdown).toContain("Título do slide");
    expect(out.markdown).toContain("- Ponto um");
    expect(out.markdown).toContain("Notas: Falar devagar");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lê o texto de um PDF e sabe quando ele é só imagem", () => {
    const doc = parsePdf(makePdf("Nota Fiscal 12345"));
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.text).toContain("Nota Fiscal 12345");
    expect(doc.hasText).toBe(true);
    const scanned = parsePdf(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer<<>>\n%%EOF", "latin1"));
    expect(scanned.hasText).toBe(false);
  });

  it("marca PDF sem texto como caso de OCR", () => {
    const dir = tmp();
    const file = path.join(dir, "scan.pdf");
    fs.writeFileSync(file, Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer<<>>\n%%EOF", "latin1"));
    const r = extractDocument(file);
    expect(r.kind).toBe("pdf");
    expect(r.needsOcr).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lê CSV com ponto e vírgula, aspas e quebras de linha", () => {
    const rows = parseDelimited('nome;valor\n"Empresa; Ltda";1.500,00\n"com ""aspas""";2\n');
    expect(rows).toEqual([["nome", "valor"], ["Empresa; Ltda", "1.500,00"], ['com "aspas"', "2"]]);
    expect(guessDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("converte HTML em Markdown legível", () => {
    const md = htmlToMarkdown(`<html><head><title>Fatura</title><style>x{}</style></head><body>
      <h1>Fatura 900</h1><p>Total: <b>R$ 10,00</b></p><ul><li>Item</li></ul>
      <a href="https://x.com">site</a></body></html>`);
    expect(md).toContain("# Fatura");
    expect(md).toContain("**R$ 10,00**");
    expect(md).toContain("- Item");
    expect(md).toContain("[site](https://x.com)");
    expect(md).not.toContain("<");
  });

  it("lê e-mail MIME com anexo e assunto codificado", () => {
    const eml = [
      "From: Fulano <fulano@exemplo.com>",
      "To: eu@exemplo.com",
      "Subject: =?UTF-8?B?Tm90YSBmaXNjYWwgZGUgc2VydmnDp28=?=",
      "Date: Mon, 1 Sep 2026 10:00:00 -0300",
      'Content-Type: multipart/mixed; boundary="XX"',
      "",
      "--XX",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Segue a nota fiscal em anexo. Valor: R=C3=A9is 10",
      "--XX",
      'Content-Type: application/pdf; name="nota.pdf"',
      'Content-Disposition: attachment; filename="nota.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF-1.4 fake").toString("base64"),
      "--XX--",
      "",
    ].join("\r\n");
    const mail = parseEml(Buffer.from(eml, "utf8"));
    expect(mail.subject).toBe("Nota fiscal de serviço");
    expect(mail.from).toContain("fulano@exemplo.com");
    expect(mail.body).toContain("Réis 10");
    expect(mail.attachments.map((a) => a.filename)).toEqual(["nota.pdf"]);
    expect(mail.attachments[0]!.content.toString("latin1")).toContain("%PDF");
  });

  it("decodifica cabeçalhos e quoted-printable", () => {
    expect(decodeHeader("=?iso-8859-1?Q?Ol=E1_mundo?=")).toBe("Olá mundo");
    expect(decodeQuotedPrintable("a=C3=A7=C3=A3o")).toBe("ação");
  });

  it("detecta o tipo pelos bytes, não pela extensão", () => {
    const dir = tmp();
    const mentindo = path.join(dir, "planilha.xlsx");
    fs.writeFileSync(mentindo, makePdf("na verdade um PDF"));
    expect(detectFile(mentindo).kind).toBe("pdf");
    const png = path.join(dir, "foto.txt");
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(detectFile(png).kind).toBe("image");
    const wav = path.join(dir, "audio.bin");
    const w = Buffer.alloc(12); w.write("RIFF", 0, "latin1"); w.write("WAVE", 8, "latin1");
    fs.writeFileSync(wav, w);
    expect(detectFile(wav).kind).toBe("audio");
    expect(extractDocument(wav).needsTranscription).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("utilidades de tabela", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("AA")).toBe(26);
    expect(markdownTable([["a", "b"], ["1"]])).toBe("| a | b |\n| --- | --- |\n| 1 |  |");
  });
});
