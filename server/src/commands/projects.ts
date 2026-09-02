import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { ingestSources } from "../documents/ingest.js";
import { searchProject } from "../documents/search.js";
import { askProject } from "../documents/ask.js";
import { extractFieldsForSources } from "../documents/fields.js";
import { listMemory, addMemory } from "../documents/memory.js";

/** DOC-01…DOC-07 pela linha de comando — prova cada passo sem a interface (AGENTS.md §7). */
export async function projectsCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, ...args] = rest;
  const id = () => {
    const value = typeof flags.project === "string" ? flags.project : args[0];
    if (!value) throw new Error("informe o projeto (--project <id> ou como primeiro argumento)");
    return value;
  };

  switch (action ?? "list") {
    case "list": {
      const list = ctx.projects.list();
      if (!list.length) return void console.log("  Nenhum projeto ainda. Crie com: aistudio projects new \"Nome do projeto\"");
      for (const p of list) console.log(`  ${p.id.padEnd(24)} ${p.name.padEnd(30)} ${p.stats.sources} documento(s), ${p.stats.chunks} trecho(s)`);
      return;
    }
    case "new": {
      const name = args.join(" ").trim();
      if (!name) throw new Error('uso: aistudio projects new "Nome do projeto"');
      const p = ctx.projects.create({ name });
      console.log(`  ✔ projeto '${p.id}' criado em ${ctx.projects.dir(p.id)}`);
      return;
    }
    case "add": {
      const project = id();
      const files = args.slice(1).map((f) => path.resolve(f));
      if (!files.length) throw new Error("uso: aistudio projects add <projeto> <arquivo|pasta>…");
      const r = await ctx.projects.addSourceFiles(project, files, { ingest: false });
      console.log(`  ✔ ${r.sources.length} documento(s) copiados. Agora: aistudio projects ingest ${project}`);
      return;
    }
    case "ingest": {
      const project = id();
      const result = await ingestSources(ctx, project, { force: flags.force === true });
      console.log(`  ✔ ${result.processed} documento(s), ${result.chunks} trecho(s), ${result.failed} falha(s)`);
      for (const s of result.sources.filter((x) => x.status === "failed")) console.log(`    ✘ ${s.name}: ${s.error}`);
      return;
    }
    case "sources": {
      for (const s of ctx.projects.sources(id())) {
        console.log(`  ${s.status.padEnd(10)} ${s.name.padEnd(40)} ${s.docType ?? ""} ${s.error ? `· ${s.error}` : ""}`);
      }
      return;
    }
    case "search": {
      const project = id();
      const query = args.slice(1).join(" ");
      if (!query) throw new Error('uso: aistudio projects search <projeto> "o que procurar"');
      const hits = await searchProject(ctx, { projectId: project, query, k: Number(flags.k ?? 8) });
      if (!hits.length) return void console.log("  Nada encontrado.");
      hits.forEach((h, i) => {
        console.log(`\n  [${i + 1}] ${h.source.name}${h.chunk.locator.page ? ` · página ${h.chunk.locator.page}` : ""} (${h.score.toFixed(3)})`);
        console.log(`      ${h.snippet.replace(/\n/g, " ").slice(0, 300)}`);
      });
      return;
    }
    case "ask": {
      const project = id();
      const question = args.slice(1).join(" ");
      if (!question) throw new Error('uso: aistudio projects ask <projeto> "sua pergunta"');
      const answer = await askProject(ctx, { projectId: project, question, model: typeof flags.model === "string" ? flags.model : undefined });
      console.log(`\n${answer.text}\n`);
      answer.citations.forEach((c, i) => console.log(`  [${i + 1}] ${c.name}${c.page ? `, página ${c.page}` : ""}`));
      return;
    }
    case "extract": {
      const project = id();
      const r = await extractFieldsForSources(ctx, project, { docType: typeof flags.type === "string" ? flags.type : undefined, force: flags.force === true });
      console.log(`  ✔ ${r.ok} ok, ${r.withIssues} com problema, ${r.failed} falha(s)`);
      for (const x of r.results) {
        const issues = x.validation?.issues.filter((i) => i.severity === "error") ?? [];
        console.log(`    ${x.name} → ${x.docType ?? "?"}${issues.length ? ` · ${issues.map((i) => i.message).join("; ")}` : ""}`);
      }
      return;
    }
    case "crosscheck": {
      const project = id();
      const table = args[1];
      const type = typeof flags.type === "string" ? flags.type : args[2];
      if (!table || !type) throw new Error("uso: aistudio projects crosscheck <projeto> <planilha.csv|xlsx> --type nfe");
      const r = ctx.doctypes.crossCheckWithTable(project, path.resolve(table), type);
      console.log(`  ✔ ${r.matched} conferem · ${r.different} divergem · ${r.missingInTable} sem linha na planilha · ${r.missingInDocuments} sem documento`);
      for (const row of r.rows.filter((x) => x.differences.length || !x.found)) {
        console.log(`    ${row.key}: ${row.found ? row.differences.map((d) => `${d.column} documento=${d.document} planilha=${d.table}`).join("; ") : "não está na planilha"}`);
      }
      return;
    }
    case "report": {
      const project = id();
      const sources = ctx.projects.sources(project);
      const withFields = sources.filter((s) => s.fields);
      console.log(`  ${sources.length} documento(s) · ${sources.filter((s) => s.status === "done").length} indexados · ${withFields.length} extraídos`);
      for (const s of withFields.filter((x) => x.validation && !x.validation.ok)) {
        console.log(`    ✘ ${s.name}: ${s.validation!.issues.map((i) => i.message).join("; ")}`);
      }
      return;
    }
    case "memory": {
      const project = id();
      const text = args.slice(1).join(" ");
      if (text) { addMemory(ctx, project, { text, kind: "user" }); console.log("  ✔ anotado."); return; }
      for (const m of listMemory(ctx, project)) console.log(`  [${m.kind}] ${m.text}`);
      return;
    }
    case "delete": {
      const project = id();
      const { trash } = ctx.projects.delete(project);
      console.log(`  ✔ projeto movido para ${trash} (nada foi apagado de verdade).`);
      return;
    }
    case "ocr": {
      const file = args[0] ? path.resolve(args[0]) : "";
      if (!file || !fs.existsSync(file)) throw new Error("uso: aistudio projects ocr <arquivo.pdf|imagem>");
      const { ocrFileToMarkdown } = await import("../documents/ocr.js");
      const r = await ocrFileToMarkdown(ctx, file, { onPage: (page, total) => process.stdout.write(`\r  OCR página ${page}/${total}…`) });
      process.stdout.write("\r");
      const out = typeof flags.out === "string" ? flags.out : `${file}.md`;
      fs.writeFileSync(out, r.markdown);
      console.log(`  ✔ ${r.pages.length} página(s) lidas com ${r.model} → ${out}`);
      return;
    }
    default:
      throw new Error("uso: aistudio projects <list|new|add|ingest|sources|search|ask|extract|crosscheck|report|memory|ocr|delete>");
  }
}
