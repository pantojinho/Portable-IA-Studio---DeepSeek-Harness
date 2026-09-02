import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * DOC-03 (rasterisation without a new engine). A scanned PDF is almost always one big image per
 * page — usually a JPEG. Pulling those images out is enough to feed the OCR model, and it needs no
 * poppler/mupdf install: JPEG streams are written as-is, raw bitmaps are re-encoded as PNG here
 * (node:zlib does the compression). When a PDF really is vector text, `extractPdf` already read it.
 */
export interface PageImage { page: number; file: string; width: number; height: number; format: "jpg" | "png" }

export function extractPdfImages(pdfFile: string, outDir: string, o: { maxPages?: number } = {}): PageImage[] {
  const buf = fs.readFileSync(pdfFile);
  const latin = buf.toString("latin1");
  fs.mkdirSync(outDir, { recursive: true });
  const out: PageImage[] = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  let page = 0;
  while ((m = re.exec(latin))) {
    if (o.maxPages && page >= o.maxPages) break;
    const start = m.index + m[0].length;
    const endObj = latin.indexOf("endobj", start);
    const body = latin.slice(start, endObj < 0 ? start + 500_000 : endObj);
    const streamAt = body.indexOf("stream");
    if (streamAt < 0) continue;
    const dict = body.slice(0, streamAt);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const width = Number(/\/Width\s+(\d+)/.exec(dict)?.[1] ?? 0);
    const height = Number(/\/Height\s+(\d+)/.exec(dict)?.[1] ?? 0);
    if (width < 64 || height < 64) continue;                 // ícones e logotipos não são páginas
    const dataStart = start + streamAt + (body.slice(streamAt).startsWith("stream\r\n") ? 8 : 7);
    const declared = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? NaN);
    const endStream = latin.indexOf("endstream", dataStart);
    const end = Number.isFinite(declared) && dataStart + declared <= buf.length ? dataStart + declared : (endStream < 0 ? buf.length : endStream);
    const data = buf.subarray(dataStart, end);
    const filters = /\/Filter\s*(?:\/(\w+)|\[([^\]]*)\])/.exec(dict);
    const filter = filters?.[1] ?? (filters?.[2] ?? "").split("/").map((s) => s.trim()).filter(Boolean).pop() ?? "";
    page++;
    const base = path.join(outDir, `pagina-${String(page).padStart(3, "0")}`);
    if (filter === "DCTDecode") {
      const file = `${base}.jpg`;
      fs.writeFileSync(file, data);
      out.push({ page, file, width, height, format: "jpg" });
      continue;
    }
    if (filter === "FlateDecode") {
      try {
        const raw = zlib.inflateSync(data);
        const bpc = Number(/\/BitsPerComponent\s+(\d+)/.exec(dict)?.[1] ?? 8);
        const gray = /\/DeviceGray/.test(dict) || /\/CalGray/.test(dict);
        const rgb = /\/DeviceRGB/.test(dict) || /\/CalRGB/.test(dict);
        if (bpc === 8 && (gray || rgb)) {
          const file = `${base}.png`;
          fs.writeFileSync(file, encodePng(raw, width, height, gray ? 1 : 3));
          out.push({ page, file, width, height, format: "png" });
          continue;
        }
        if (bpc === 1 && gray) {
          const file = `${base}.png`;
          fs.writeFileSync(file, encodePng(expandBilevel(raw, width, height), width, height, 1));
          out.push({ page, file, width, height, format: "png" });
          continue;
        }
      } catch { /* imagem em formato que não sabemos desempacotar */ }
    }
    page--; // não conseguimos usar esta imagem
  }
  return out;
}

/** Minimal PNG writer: no interlace, filter 0, one IDAT. */
export function encodePng(pixels: Buffer, width: number, height: number, channels: 1 | 3): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, Math.min(pixels.length, (y + 1) * stride));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                          // bit depth
  ihdr[9] = channels === 1 ? 0 : 2;     // colour type: grayscale / truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
}

function expandBilevel(raw: Buffer, width: number, height: number): Buffer {
  const out = Buffer.alloc(width * height);
  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = raw[y * rowBytes + (x >> 3)] ?? 0;
      out[y * width + x] = (byte >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
  }
  return out;
}

let table: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
