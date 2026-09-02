import type { ValidationIssue, ValidationResult } from "./types.js";

/**
 * DOC-07. Checks that only need arithmetic — no model, no network — so a wrong invoice is caught
 * even offline. Everything here is Brazilian document reality: NF-e keys, CNPJ/CPF, totals, dates.
 */
export type Validator = (fields: Record<string, unknown>, ctx: { docType?: string }) => ValidationIssue[];

export function onlyDigits(s: unknown): string { return String(s ?? "").replace(/\D+/g, ""); }

/** NF-e / NFC-e key: 44 digits whose last one is a mod-11 check digit over the other 43. */
export function nfeKeyCheckDigit(key43: string): number {
  const weights = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  for (let i = key43.length - 1, w = 0; i >= 0; i--, w++) {
    sum += Number(key43[i]) * weights[w % weights.length]!;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidNfeKey(key: unknown): boolean {
  const k = onlyDigits(key);
  if (k.length !== 44) return false;
  return nfeKeyCheckDigit(k.slice(0, 43)) === Number(k[43]);
}

export function isValidCnpj(value: unknown): boolean {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    let pos = len - 7, sum = 0;
    for (let i = 0; i < len; i++) {
      sum += Number(c[i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export function isValidCpf(value: unknown): boolean {
  const c = onlyDigits(value);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

/** "1.234,56", "R$ 1.234,56", "1234.56" → 1234.56 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value ?? "").replace(/[^\d,.-]/g, "").trim();
  if (!s) return null;
  // "1.234,56" (pt-BR) · "1,234.56" (en) · "2.500" (milhar pt-BR: três casas exatas) · "2.5" (decimal)
  const normalized = s.includes(",") && s.lastIndexOf(",") > s.lastIndexOf(".")
    ? s.replace(/\./g, "").replace(",", ".")
    : /^-?\d{1,3}(\.\d{3})+$/.test(s)
      ? s.replace(/\./g, "")
      : s.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** "01/09/2026", "2026-09-01", "01-09-26" → ISO date, or null. */
export function parseDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const iso = `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

const issue = (code: string, message: string, severity: ValidationIssue["severity"] = "error", field?: string): ValidationIssue => ({ code, severity, message, field });

export const VALIDATORS: Record<string, Validator> = {
  nfeKey: (f) => {
    const key = f.chaveAcesso ?? f.chave ?? f.accessKey;
    if (key === undefined || key === null || String(key).trim() === "") return [issue("nfe_key_missing", "A chave de acesso da NF-e não foi encontrada.", "warning", "chaveAcesso")];
    const digits = onlyDigits(key);
    if (digits.length !== 44) return [issue("nfe_key_length", `A chave tem ${digits.length} dígitos; deveria ter 44.`, "error", "chaveAcesso")];
    return isValidNfeKey(digits) ? [] : [issue("nfe_key_dv", "O dígito verificador da chave de acesso não confere (mod 11).", "error", "chaveAcesso")];
  },
  cnpj: (f) => {
    const out: ValidationIssue[] = [];
    for (const field of ["cnpjEmitente", "cnpjDestinatario", "cnpj", "cnpjPrestador", "cnpjTomador"]) {
      const v = f[field];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      if (!isValidCnpj(v)) out.push(issue("cnpj_invalido", `CNPJ inválido em ${field}: ${String(v)}`, "error", field));
    }
    return out;
  },
  cpf: (f) => {
    const out: ValidationIssue[] = [];
    for (const field of ["cpf", "cpfDestinatario", "cpfTomador"]) {
      const v = f[field];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      if (!isValidCpf(v)) out.push(issue("cpf_invalido", `CPF inválido em ${field}: ${String(v)}`, "error", field));
    }
    return out;
  },
  /** The sum of the items has to be the total (1 cent of tolerance for rounding). */
  itemsSum: (f) => {
    const items = Array.isArray(f.itens) ? f.itens : Array.isArray(f.items) ? f.items : null;
    const total = parseAmount(f.valorTotal ?? f.total ?? f.valor);
    if (!items || total === null) return [];
    let sum = 0;
    for (const raw of items) {
      const it = raw as Record<string, unknown>;
      const value = parseAmount(it.valorTotal ?? it.total ?? it.valor);
      if (value !== null) { sum += value; continue; }
      const qty = parseAmount(it.quantidade ?? it.qtd) ?? 1;
      const unit = parseAmount(it.valorUnitario ?? it.precoUnitario);
      if (unit !== null) sum += qty * unit;
    }
    const diff = Math.abs(sum - total);
    return diff <= 0.01 ? [] : [issue("soma_itens", `A soma dos itens (${sum.toFixed(2)}) não bate com o total (${total.toFixed(2)}); diferença de ${diff.toFixed(2)}.`, "error", "valorTotal")];
  },
  dates: (f) => {
    const out: ValidationIssue[] = [];
    const emission = parseDate(f.dataEmissao ?? f.emissao ?? f.data);
    const due = parseDate(f.dataVencimento ?? f.vencimento);
    if ((f.dataEmissao ?? f.emissao ?? f.data) && !emission) out.push(issue("data_invalida", "Data de emissão em formato desconhecido.", "warning", "dataEmissao"));
    if ((f.dataVencimento ?? f.vencimento) && !due) out.push(issue("data_invalida", "Data de vencimento em formato desconhecido.", "warning", "dataVencimento"));
    if (emission && due && due < emission) out.push(issue("vencimento_antes_emissao", "O vencimento é anterior à emissão.", "error", "dataVencimento"));
    if (emission && emission > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) {
      out.push(issue("data_futura", "A data de emissão está no futuro.", "warning", "dataEmissao"));
    }
    return out;
  },
  required: (f, ctx) => {
    const needed = ctx.docType === "nfe" ? ["numero", "valorTotal", "dataEmissao"] : ["valorTotal"];
    return needed.filter((k) => f[k] === undefined || f[k] === null || String(f[k]).trim() === "")
      .map((k) => issue("campo_faltando", `Campo obrigatório não encontrado: ${k}.`, "warning", k));
  },
  positiveAmounts: (f) => {
    const out: ValidationIssue[] = [];
    for (const field of ["valorTotal", "total", "valor", "valorLiquido"]) {
      const v = f[field];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      const n = parseAmount(v);
      if (n === null) out.push(issue("valor_ilegivel", `Valor não numérico em ${field}: ${String(v)}`, "error", field));
      else if (n < 0) out.push(issue("valor_negativo", `Valor negativo em ${field}.`, "warning", field));
    }
    return out;
  },
};

export function runValidators(names: string[], fields: Record<string, unknown>, docType?: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  for (const name of names) {
    const v = VALIDATORS[name];
    if (!v) { issues.push(issue("validador_desconhecido", `Validador '${name}' não existe.`, "info")); continue; }
    try { issues.push(...v(fields, { docType })); }
    catch (e) { issues.push(issue("validador_falhou", `Validador '${name}' falhou: ${(e as Error).message}`, "info")); }
  }
  return { ok: !issues.some((i) => i.severity === "error"), issues, checkedAt: new Date().toISOString() };
}

// ------------------------------------------------------ cross-check ---

export interface CrossCheckRow { key: string; found: boolean; differences: { column: string; document: string; table: string }[] }
export interface CrossCheckReport {
  matched: number; missingInTable: number; missingInDocuments: number; different: number;
  rows: CrossCheckRow[];
  extraInTable: string[];
}

/**
 * Compare extracted documents against a spreadsheet the user exported from their system: what is
 * missing on each side, and where the values disagree.
 */
export function crossCheck(
  documents: { id: string; fields: Record<string, unknown> }[],
  table: Record<string, string>[],
  spec: { key: string[]; compare: string[] },
): CrossCheckReport {
  const keyOf = (row: Record<string, unknown>) => spec.key.map((k) => normalizeValue(row[k] ?? findLoose(row, k))).join("|");
  const tableByKey = new Map<string, Record<string, string>>();
  for (const row of table) tableByKey.set(keyOf(row), row);

  const rows: CrossCheckRow[] = [];
  let matched = 0, missingInTable = 0, different = 0;
  const seen = new Set<string>();
  for (const doc of documents) {
    const key = keyOf(doc.fields);
    const row = tableByKey.get(key);
    if (!row) { rows.push({ key, found: false, differences: [] }); missingInTable++; continue; }
    seen.add(key);
    const differences = spec.compare.flatMap((column) => {
      const a = normalizeValue(doc.fields[column] ?? findLoose(doc.fields, column));
      const b = normalizeValue(row[column] ?? findLoose(row, column));
      if (a === "" && b === "") return [];
      return a === b ? [] : [{ column, document: a, table: b }];
    });
    if (differences.length) different++; else matched++;
    rows.push({ key, found: true, differences });
  }
  const extraInTable = [...tableByKey.keys()].filter((k) => !seen.has(k) && !rows.some((r) => r.key === k));
  return { matched, missingInTable, missingInDocuments: extraInTable.length, different, rows, extraInTable };
}

/** Column names differ in case/accents between the document and the spreadsheet. */
function findLoose(row: Record<string, unknown>, key: string): unknown {
  const want = normalizeKey(key);
  for (const [k, v] of Object.entries(row)) if (normalizeKey(k) === want) return v;
  return undefined;
}

function normalizeKey(k: string): string {
  return k.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Numbers compare as numbers, dates as ISO, everything else as trimmed text. */
export function normalizeValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (!s) return "";
  // 1) datas em qualquer formato viram ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)) {
    const date = parseDate(s);
    if (date) return date;
  }
  // 2) documentos (CNPJ, CPF, chave da NF-e) comparam só pelos dígitos
  const digits = s.replace(/\D+/g, "");
  if (digits.length >= 11 && /^[\d.\-/\s]+$/.test(s)) return digits;
  // 3) dinheiro compara como número
  if (/^R?\$?\s*-?\d[\d.,]*$/.test(s)) {
    const amount = parseAmount(s);
    if (amount !== null) return String(Math.round(amount * 100) / 100);
  }
  return s.replace(/\s+/g, " ").toLowerCase();
}
