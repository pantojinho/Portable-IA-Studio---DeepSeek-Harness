import fs from "node:fs";
import type { StudioContext } from "../core/context.js";
import { fmtBytes } from "../models/resolver.js";
import { inspectFile } from "../models/inspect.js";
import { defaultMigrationSources, scanForMigration } from "../models/registry.js";
import { bus } from "../core/events.js";
import type { JobInfo } from "../core/jobs.js";

const HELP = `aistudio models
  list [--kind K]              modelos na biblioteca
  resolve <ref> [--quant Q]    mostra o plano de download sem baixar
  pull <ref> [--quant Q]       resolve e baixa (ref = link HF/CivitAI, org/repo, recipe:id, URL)
  inspect <arquivo>            diz o que um arquivo realmente é
  recipes                      receitas disponíveis
  migrate [--source DIR] [--import]   encontra modelos de uma instalação antiga (ULS) e importa
  token hf <TOKEN|clear>       guarda o token do Hugging Face (modelos gated)
  token civitai <TOKEN|clear>
`;

export async function modelsCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const svc = ctx.models;
  const sub = rest[0] ?? "list";
  const arg = rest[1];
  switch (sub) {
    case "list": {
      const list = svc.registry.list(typeof flags.kind === "string" ? (flags.kind as never) : undefined);
      if (list.length === 0) { console.log("Biblioteca vazia. Use: aistudio models pull <link>"); return; }
      for (const m of list) console.log(`${m.kind.padEnd(11)} ${fmtBytes(m.sizeBytes).padStart(9)}  ${m.id}${m.inspection.arch ? `  [${m.inspection.arch}${m.inspection.quant ? " " + m.inspection.quant : ""}]` : ""}${m.inspection.role !== "main" ? `  (${m.inspection.role})` : ""}`);
      return;
    }
    case "resolve": case "pull": {
      if (!arg) { console.log(HELP); process.exitCode = 1; return; }
      const plan = await svc.resolve(arg, { quant: typeof flags.quant === "string" ? flags.quant : null });
      printPlan(plan);
      if (sub === "resolve") return;
      const job = svc.pull(plan);
      await followJob(job);
      return;
    }
    case "inspect": {
      if (!arg || !fs.existsSync(arg)) { console.error("arquivo não encontrado"); process.exitCode = 1; return; }
      console.log(JSON.stringify({ sizeBytes: fs.statSync(arg).size, ...inspectFile(arg) }, null, 2));
      return;
    }
    case "recipes": {
      for (const r of svc.recipes.list()) console.log(`${r.id.padEnd(24)} ${r.kind.padEnd(10)} ${r.engine.padEnd(18)} ${r.status.padEnd(9)} ${r.name}`);
      return;
    }
    case "migrate": {
      const sources = typeof flags.source === "string" ? [flags.source] : defaultMigrationSources(ctx.paths);
      if (sources.length === 0) { console.log("Nenhuma instalação antiga encontrada ao lado desta pasta. Use --source DIR."); return; }
      const cands = sources.flatMap((s) => scanForMigration(s));
      for (const cnd of cands) {
        const flag = cnd.problem === "html" ? "✘ HTML (página, não modelo)" : cnd.problem === "partial" ? "✘ download incompleto" : cnd.problem ? `? ${cnd.problem}` : `✔ ${cnd.suggestedKind}${cnd.inspection.arch ? " · " + cnd.inspection.arch : ""}`;
        console.log(`${fmtBytes(cnd.sizeBytes).padStart(9)}  ${flag.padEnd(34)} ${cnd.path}`);
      }
      if (flags.import) {
        const ok = cands.filter((cnd) => !cnd.problem && cnd.suggestedKind);
        for (const cnd of ok) {
          try { const m = svc.registry.importFile(cnd.path, { kind: cnd.suggestedKind! }); console.log(`  importado → ${m.id}`); }
          catch (e) { console.log(`  falhou ${cnd.path}: ${(e as Error).message}`); }
        }
        console.log("Originais não foram apagados. Arquivos marcados com ✘ ficaram de fora — apague-os manualmente se quiser.");
      } else console.log("\nUse --import para trazer os arquivos ✔ para a biblioteca (hardlink/cópia; nada é apagado).");
      return;
    }
    case "token": {
      const which = arg === "hf" ? "hf_token" : arg === "civitai" ? "civitai_token" : null;
      const val = rest[2];
      if (!which || !val) { console.log(HELP); process.exitCode = 1; return; }
      svc.writeSecret(which, val === "clear" ? null : val);
      console.log(val === "clear" ? "token removido" : "token guardado em data/secrets");
      return;
    }
    default: console.log(HELP); process.exitCode = 1;
  }
}

function printPlan(plan: import("../models/types.js").DownloadPlan): void {
  console.log(`\n${plan.title}  (${plan.provider}${plan.recipeId ? ` · receita ${plan.recipeId}` : ""})`);
  if (plan.license) console.log(`licença: ${plan.license}${plan.gated ? " · gated" : ""}`);
  for (const f of plan.files) console.log(`  ${fmtBytes(f.sizeBytes).padStart(9)}  ${f.kind.padEnd(10)} ${f.role.padEnd(12)} ${f.repoPath ?? f.url}${(f as { present?: boolean }).present ? "  (já existe)" : ""}`);
  console.log(`  total: ${fmtBytes(plan.totalBytes)}`);
  for (const w of plan.warnings) console.log(`  ! ${w}`);
  if (plan.alternatives?.length) console.log(`  alternativas: ${plan.alternatives.slice(0, 6).map((a) => a.label).join(" · ")}`);
}

function followJob(job: JobInfo): Promise<void> {
  return new Promise((resolve) => {
    let last = "";
    const off = bus.subscribe("job", (ev) => {
      const j = ev.data as JobInfo;
      if (j.id !== job.id) return;
      if (j.message !== last) { process.stdout.write(`\r  ${j.message.padEnd(100)}`); last = j.message; }
      if (j.status === "done" || j.status === "failed" || j.status === "cancelled") {
        process.stdout.write("\n");
        if (j.status === "failed") { console.error(`  ✘ ${j.error}`); process.exitCode = 1; }
        else console.log(`  ✔ ${j.status === "done" ? "concluído" : "cancelado"}`);
        off(); resolve();
      }
    });
  });
}
