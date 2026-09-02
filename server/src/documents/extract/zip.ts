import fs from "node:fs";
import zlib from "node:zlib";

/**
 * DOC-02. DOCX, XLSX and PPTX are ZIP files with XML inside. Node already ships the only hard part
 * (inflate, in node:zlib), so the Studio reads them without jszip and without a native module —
 * one dependency less in a bundle that must stay under 100 MB (AGENTS.md §2.2/§2.3).
 */
export interface ZipEntry { name: string; compressedSize: number; size: number; method: number; offset: number }

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;

export class ZipFile {
  private constructor(private buf: Buffer, readonly entries: ZipEntry[]) {}

  static open(file: string): ZipFile { return ZipFile.fromBuffer(fs.readFileSync(file)); }

  static fromBuffer(buf: Buffer): ZipFile {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error("não parece um arquivo ZIP (fim do diretório central não encontrado)");
    let count = buf.readUInt16LE(eocd + 10);
    let cenOffset = buf.readUInt32LE(eocd + 16);
    // ZIP64: the real numbers live in another record when the 32-bit fields are saturated
    if (count === 0xffff || cenOffset === 0xffffffff) {
      const loc = lastIndexOfSig(buf, EOCD64_LOCATOR_SIG, eocd);
      if (loc < 0) throw new Error("ZIP64 sem localizador: arquivo corrompido");
      const rec = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(rec) !== EOCD64_SIG) throw new Error("ZIP64 inválido");
      count = Number(buf.readBigUInt64LE(rec + 32));
      cenOffset = Number(buf.readBigUInt64LE(rec + 48));
    }
    const entries: ZipEntry[] = [];
    let p = cenOffset;
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== CEN_SIG) break;
      const method = buf.readUInt16LE(p + 10);
      let compressedSize = buf.readUInt32LE(p + 20);
      let size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      let offset = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
        const z = readZip64Extra(buf, p + 46 + nameLen, extraLen, { size, compressedSize, offset });
        size = z.size; compressedSize = z.compressedSize; offset = z.offset;
      }
      entries.push({ name, method, compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipFile(buf, entries);
  }

  has(name: string): boolean { return this.entries.some((e) => e.name === name); }
  names(re?: RegExp): string[] { return this.entries.map((e) => e.name).filter((n) => !re || re.test(n)); }

  read(name: string): Buffer {
    const e = this.entries.find((x) => x.name === name);
    if (!e) throw new Error(`'${name}' não existe dentro do arquivo`);
    const nameLen = this.buf.readUInt16LE(e.offset + 26);
    const extraLen = this.buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const raw = this.buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`compressão ${e.method} não suportada em '${name}'`);
  }

  text(name: string): string { return this.read(name).toString("utf8"); }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  return -1;
}

function lastIndexOfSig(buf: Buffer, sig: number, before: number): number {
  for (let i = before - 4; i >= Math.max(0, before - 100_000); i--) if (buf.readUInt32LE(i) === sig) return i;
  return -1;
}

function readZip64Extra(buf: Buffer, start: number, len: number, cur: { size: number; compressedSize: number; offset: number }) {
  let p = start;
  const end = start + len;
  const out = { ...cur };
  while (p + 4 <= end) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    let q = p + 4;
    if (id === 0x0001) {
      if (out.size === 0xffffffff) { out.size = Number(buf.readBigUInt64LE(q)); q += 8; }
      if (out.compressedSize === 0xffffffff) { out.compressedSize = Number(buf.readBigUInt64LE(q)); q += 8; }
      if (out.offset === 0xffffffff) { out.offset = Number(buf.readBigUInt64LE(q)); q += 8; }
      return out;
    }
    p += 4 + size;
  }
  return out;
}
