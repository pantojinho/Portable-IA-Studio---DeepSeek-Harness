import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, packVector, unpackVector, cosineSimilarity, ftsQuery } from "./db.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-db-"));

describe("core/db", () => {
  it("aplica migrações uma vez e guarda a versão", () => {
    const dir = tmp();
    const file = path.join(dir, "t.sqlite");
    const migs = [
      { id: 1, sql: "CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT)" },
      { id: 2, sql: "ALTER TABLE a ADD COLUMN n INTEGER DEFAULT 0" },
    ];
    const db = openDatabase(file, migs);
    db.prepare("INSERT INTO a(v) VALUES(?)").run("x");
    db.close();
    const db2 = openDatabase(file, migs); // reabrir não deve refazer nada
    expect((db2.prepare("SELECT count(*) c FROM a").get() as { c: number }).c).toBe(1);
    expect(Number((db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(2);
    db2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("faz busca textual com FTS5", () => {
    const db = openDatabase(path.join(tmp(), "f.sqlite"), [
      { id: 1, sql: "CREATE VIRTUAL TABLE docs USING fts5(body)" },
    ]);
    db.prepare("INSERT INTO docs(body) VALUES(?)").run("nota fiscal eletrônica de serviço");
    db.prepare("INSERT INTO docs(body) VALUES(?)").run("contrato de aluguel");
    const rows = db.prepare("SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank").all(ftsQuery("nota fiscal")) as { body: string }[];
    expect(rows[0]!.body).toContain("nota fiscal");
    db.close();
  });

  it("guarda e relê vetores como blob", () => {
    const db = openDatabase(path.join(tmp(), "v.sqlite"), [{ id: 1, sql: "CREATE TABLE v(id INTEGER PRIMARY KEY, e BLOB)" }]);
    const vec = Float32Array.from([0.1, -0.2, 0.3, 0.4]);
    db.prepare("INSERT INTO v(e) VALUES(?)").run(packVector(vec));
    const back = unpackVector((db.prepare("SELECT e FROM v").get() as { e: Uint8Array }).e);
    expect(Array.from(back).map((x) => Math.round(x * 1000))).toEqual([100, -200, 300, 400]);
    expect(cosineSimilarity(vec, back)).toBeCloseTo(1, 5);
    db.close();
  });

  it("escapa a consulta FTS (aspas e operadores não viram sintaxe)", () => {
    expect(ftsQuery('nota "fiscal" OR (x)')).toBe('"nota" OR "fiscal" OR "or"');
    expect(ftsQuery("!!")).toBe('""');
  });
});
