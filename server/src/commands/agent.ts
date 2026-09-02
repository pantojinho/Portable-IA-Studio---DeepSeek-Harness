import type { StudioContext } from "../core/context.js";
import { bus } from "../core/events.js";
import type { JobInfo } from "../core/jobs.js";

const HELP = `aistudio agent
  status                 estado do DeepSeek Harness embutido
  install                instala @deepseek-ai/dsh (fixado) em agent/
  start                  sobe 'dsh web' apontando para o /v1 do Studio (o Studio precisa estar rodando: aistudio serve)
  stop
  run "<tarefa>" [--workspace DIR]   execução única (headless) e imprime a resposta
`;

export async function agentCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  switch (rest[0] ?? "status") {
    case "status": console.log(JSON.stringify(ctx.agent.status(), null, 2)); return;
    case "install": {
      const job = ctx.jobs.create("download", "Instalar dsh", (j) => ctx.agent.install(j));
      await new Promise<void>((resolve) => { const off = bus.subscribe("job", (ev) => { const j = ev.data as JobInfo; if (j.id !== job.id) return; process.stdout.write(`\r  ${j.message.padEnd(90)}`); if (["done", "failed", "cancelled"].includes(j.status)) { process.stdout.write("\n"); if (j.error) { console.error("  ✘ " + j.error); process.exitCode = 1; } off(); resolve(); } }); });
      return;
    }
    case "start": { const s = await ctx.agent.start(); console.log(`✔ dsh em ${s.url} (versão ${s.version}). Ctrl+C para parar.`); await new Promise(() => {}); return; }
    case "stop": await ctx.agent.stop(); return;
    case "run": {
      const task = rest.slice(1).join(" ").trim(); if (!task) { console.log(HELP); process.exitCode = 1; return; }
      const r = await ctx.agent.run({ task, workspace: typeof flags.workspace === "string" ? flags.workspace : undefined });
      console.log(r.output); if (!r.ok) process.exitCode = 1; return;
    }
    default: console.log(HELP); process.exitCode = 1;
  }
}
