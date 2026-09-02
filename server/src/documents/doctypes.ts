import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { StudioContext } from "../core/context.js";
import { chatJson } from "../core/llm.js";
import { logger } from "../core/log.js";
import type { DocType, ValidationResult } from "./types.js";
import { crossCheck, runValidators, type CrossCheckReport } from "./validators.js";
import { parseDelimited, readTextFile } from "./extract/text.js";
import { extractXlsx } from "./extract/office.js";
import { detectFile } from "./extract/index.js";

const log = logger("doctypes");

/**
 * DOC-07. Document types are data: a JSON schema for extraction plus the names of the checks to run
 * (documents/doctypes/*.yaml). Adding "apólice de seguro" is writing a YAML file, never code.
 */
export class DocTypeStore {
  private cache: Map<string, DocType> | null = null;

  constructor(private ctx: StudioContext) {}

  dir(): string { return path.join(this.ctx.paths.root, "documents", "doctypes"); }

  all(refresh = false): DocType[] {
    if (refresh) this.cache = null;
    if (!this.cache) {
      this.cache = new Map();
      for (const dir of [this.dir(), path.join(this.ctx.paths.data, "doctypes")]) {
        for (const name of safeReaddir(dir)) {
          if (!/\.ya?ml$/i.test(name)) continue;
          try {
            const parsed = YAML.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { doctypes?: DocType[] } | DocType[] | DocType;
            const list = Array.isArray(parsed) ? parsed : "doctypes" in (parsed as object) ? (parsed as { doctypes: DocType[] }).doctypes : [parsed as DocType];
            for (const dt of list ?? []) if (dt?.id) this.cache.set(dt.id, dt);
          } catch (e) { log.warn(`${name}: ${(e as Error).message}`); }
        }
      }
    }
    return [...this.cache.values()];
  }

  get(id: string): DocType | undefined { return this.all().find((d) => d.id === id); }

  /** Cheap first pass: the hints. Only ambiguous documents cost a model call. */
  classifyByHints(text: string): { id: string; score: number }[] {
    const sample = text.slice(0, 6000).toLowerCase();
    return this.all().map((dt) => {
      let score = 0;
      for (const hint of dt.hints ?? []) {
        const h = hint.toLowerCase();
        if (h.startsWith("/") && h.lastIndexOf("/") > 0) {
          try { if (new RegExp(h.slice(1, h.lastIndexOf("/")), "i").test(sample)) score += 2; } catch { /* regex ruim na receita */ }
        } else if (sample.includes(h)) score += 1;
      }
      return { id: dt.id, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  }

  async classify(text: string, o: { model?: string; signal?: AbortSignal } = {}): Promise<string | null> {
    const byHints = this.classifyByHints(text);
    if (byHints.length && (byHints.length === 1 || byHints[0]!.score >= byHints[1]!.score + 2)) return byHints[0]!.id;
    const types = this.all();
    if (!types.length) return null;
    try {
      const data = await chatJson<{ tipo?: string }>(this.ctx, {
        model: o.model, temperature: 0, maxTokens: 60, signal: o.signal,
        messages: [
          { role: "system", content: "Você classifica documentos brasileiros. Responda só com JSON." },
          { role: "user", content: `Tipos possíveis: ${types.map((t) => `${t.id} (${t.name})`).join(", ")}, ou "outro".\n\nDocumento:\n${text.slice(0, 4000)}\n\nResponda: {"tipo": "<id>"}` },
        ],
      });
      const id = String(data.tipo ?? "").trim();
      return types.some((t) => t.id === id) ? id : (byHints[0]?.id ?? null);
    } catch (e) {
      log.warn(`classificação por modelo falhou (${(e as Error).message}); usando as pistas`);
      return byHints[0]?.id ?? null;
    }
  }

  /** Extract the fields the type's schema asks for, then run its validators. */
  async extract(text: string, docType: DocType, o: { model?: string; signal?: AbortSignal } = {}): Promise<{ fields: Record<string, unknown>; validation: ValidationResult }> {
    const fields = await chatJson<Record<string, unknown>>(this.ctx, {
      model: o.model, temperature: 0, maxTokens: 1500, signal: o.signal,
      messages: [
        { role: "system", content: "Você extrai campos de documentos brasileiros. Copie os valores exatamente como aparecem (inclusive pontuação de CNPJ e datas). Se um campo não existir no documento, use null. Responda só o JSON." },
        { role: "user", content: `Tipo: ${docType.name}\nEsquema JSON esperado:\n${JSON.stringify(docType.schema, null, 2)}\n\nDocumento:\n${text.slice(0, 16000)}` },
      ],
    });
    const clean = pruneNulls(fields);
    return { fields: clean, validation: runValidators(docType.validators ?? [], clean, docType.id) };
  }

  validate(fields: Record<string, unknown>, docType: DocType): ValidationResult {
    return runValidators(docType.validators ?? [], fields, docType.id);
  }

  /** Compare a project's extracted documents with a spreadsheet/CSV the user exported. */
  crossCheckWithTable(projectId: string, tablePath: string, docTypeId: string): CrossCheckReport & { docType: string; table: string } {
    const docType = this.get(docTypeId);
    if (!docType) throw new Error(`tipo de documento '${docTypeId}' não existe`);
    if (!docType.crossCheck) throw new Error(`o tipo '${docTypeId}' não declara 'crossCheck' no YAML`);
    const table = readTable(tablePath);
    const documents = this.ctx.projects.sources(projectId)
      .filter((s) => s.docType === docTypeId && s.fields)
      .map((s) => ({ id: s.id, fields: s.fields! }));
    if (!documents.length) throw new Error(`nenhum documento do tipo '${docTypeId}' com campos extraídos neste projeto. Rode a extração primeiro.`);
    return { ...crossCheck(documents, table, docType.crossCheck), docType: docTypeId, table: path.basename(tablePath) };
  }
}

/** CSV/TSV/XLSX → rows keyed by the header, whatever the file the user exported. */
export function readTable(file: string): Record<string, string>[] {
  const kind = detectFile(file).kind;
  if (kind === "xlsx") {
    const md = extractXlsx(file).markdown;
    const rows = md.split("\n").filter((l) => l.trim().startsWith("|")).map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
    const table = rows.filter((r) => !r.every((c) => /^-+$/.test(c) || c === ""));
    return rowsToObjects(table);
  }
  return rowsToObjects(parseDelimited(readTextFile(file)));
}

function rowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

function pruneNulls(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out;
}

function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }
