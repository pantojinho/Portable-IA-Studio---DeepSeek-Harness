import { describe, it, expect } from "vitest";
import {
  isValidNfeKey, isValidCnpj, isValidCpf, parseAmount, parseDate, runValidators, crossCheck, normalizeValue, nfeKeyCheckDigit,
} from "./validators.js";

// 43 dígitos + DV calculado pelo mod 11 (UF 35, 2026-09, CNPJ 11.222.333/0001-81, modelo 55…)
const CHAVE = "35260911222333000181550010000123451123456784";
const CNPJ_OK = "11.222.333/0001-81";
const CPF_OK = "529.982.247-25";

describe("documents/validators (DOC-07)", () => {
  it("valida a chave da NF-e e rejeita qualquer dígito trocado", () => {
    expect(isValidNfeKey(CHAVE)).toBe(true);
    expect(isValidNfeKey(`${CHAVE.slice(0, 43)}5`)).toBe(false);          // DV errado
    for (const pos of [0, 7, 20, 42]) {
      const digit = String((Number(CHAVE[pos]) + 1) % 10);
      const mutated = CHAVE.slice(0, pos) + digit + CHAVE.slice(pos + 1);
      expect(isValidNfeKey(mutated)).toBe(false);
    }
    expect(isValidNfeKey("123")).toBe(false);
    expect(nfeKeyCheckDigit(CHAVE.slice(0, 43))).toBe(Number(CHAVE[43]));
  });

  it("valida CNPJ e CPF com e sem pontuação", () => {
    expect(isValidCnpj(CNPJ_OK)).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
    expect(isValidCnpj("11.222.333/0001-82")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCpf(CPF_OK)).toBe(true);
    expect(isValidCpf("529.982.247-26")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
  });

  it("entende valores e datas do jeito brasileiro", () => {
    expect(parseAmount("R$ 1.234,56")).toBe(1234.56);
    expect(parseAmount("1234.56")).toBe(1234.56);
    expect(parseAmount("2.500")).toBe(2500);
    expect(parseAmount("abc")).toBeNull();
    expect(parseDate("10/10/2026")).toBe("2026-10-10");
    expect(parseDate("2026-10-10T12:00:00Z")).toBe("2026-10-10");
    expect(parseDate("bagunça")).toBeNull();
  });

  it("acusa soma de itens diferente do total", () => {
    const ok = runValidators(["itemsSum"], {
      valorTotal: "1.234,56",
      itens: [{ valorTotal: "1.000,00" }, { quantidade: "2", valorUnitario: "117,28" }],
    });
    expect(ok.ok).toBe(true);
    const bad = runValidators(["itemsSum"], { valorTotal: "1.000,00", itens: [{ valorTotal: "900,00" }] });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]!.code).toBe("soma_itens");
    expect(bad.issues[0]!.message).toContain("100.00");
  });

  it("roda o conjunto da NF-e e explica cada problema em português", () => {
    const r = runValidators(["nfeKey", "cnpj", "dates", "positiveAmounts", "required"], {
      chaveAcesso: CHAVE, numero: "12345", cnpjEmitente: "11.222.333/0001-99",
      dataEmissao: "10/10/2026", dataVencimento: "01/10/2026", valorTotal: "100,00",
    }, "nfe");
    expect(r.ok).toBe(false);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain("cnpj_invalido");
    expect(codes).toContain("vencimento_antes_emissao");
    expect(codes).not.toContain("nfe_key_dv");
    expect(r.issues.every((i) => /[a-zà-ú]/i.test(i.message))).toBe(true);
  });

  it("avisa quando um validador não existe, sem derrubar o resto", () => {
    const r = runValidators(["nfeKey", "nao-existe"], { chaveAcesso: CHAVE });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("validador_desconhecido");
  });

  it("cruza documentos com a planilha e lista o que diverge", () => {
    const documents = [
      { id: "a", fields: { numero: "12345", valorTotal: "1.234,56", dataEmissao: "10/10/2026", cnpjEmitente: CNPJ_OK } },
      { id: "b", fields: { numero: "999", valorTotal: "10,00", dataEmissao: "01/09/2026", cnpjEmitente: CNPJ_OK } },
      { id: "c", fields: { numero: "777", valorTotal: "5,00", dataEmissao: "01/09/2026", cnpjEmitente: CNPJ_OK } },
    ];
    const table = [
      { numero: "12345", valorTotal: "1234.56", dataEmissao: "2026-10-10", cnpjEmitente: "11222333000181" },
      { numero: "999", valorTotal: "12,00", dataEmissao: "01/09/2026", cnpjEmitente: CNPJ_OK },
      { numero: "555", valorTotal: "1,00", dataEmissao: "01/09/2026", cnpjEmitente: CNPJ_OK },
    ];
    const r = crossCheck(documents, table, { key: ["numero"], compare: ["valorTotal", "dataEmissao", "cnpjEmitente"] });
    expect(r.matched).toBe(1);                       // 12345 bate mesmo com formatos diferentes
    expect(r.different).toBe(1);                     // 999 tem valor diferente
    expect(r.missingInTable).toBe(1);                // 777 não está na planilha
    expect(r.missingInDocuments).toBe(1);            // 555 não tem documento
    const divergente = r.rows.find((x) => x.key === "999")!;
    expect(divergente.differences[0]!.column).toBe("valorTotal");
    expect(divergente.differences[0]!.document).toBe("10");
    expect(divergente.differences[0]!.table).toBe("12");
  });

  it("normaliza valores para comparar formatos diferentes", () => {
    expect(normalizeValue("R$ 1.234,56")).toBe(normalizeValue("1234.56"));
    expect(normalizeValue("10/10/2026")).toBe(normalizeValue("2026-10-10"));
    expect(normalizeValue(" Empresa  LTDA ")).toBe("empresa ltda");
    expect(normalizeValue(null)).toBe("");
  });
});
