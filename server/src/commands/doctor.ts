import fs from "node:fs";
import path from "node:path";
import type { StudioContext } from "../core/context.js";
import { systemInfo } from "../core/system.js";

function gb(mib: number | null | undefined): string { return mib == null ? "?" : `${(mib / 1024).toFixed(1)} GB`; }
function ok(b: boolean): string { return b ? "✔" : "✘"; }

export async function runDoctor(ctx: StudioContext): Promise<void> {
  const s = await systemInfo(ctx.paths.root);
  const p = ctx.paths;
  console.log(`\nAI Studio ${ctx.version} — doctor\n`);
  console.log(`Sistema     ${s.platform}-${s.arch} · ${s.osVersion}`);
  console.log(`CPU         ${s.cpu} (${s.cores} threads)`);
  console.log(`RAM         ${gb(s.ramMiB)} total, ${gb(s.ramFreeMiB)} livre`);
  console.log(`Disco       ${gb(s.diskFreeMiB)} livres em ${p.root}`);
  if (s.gpus.length === 0) console.log("GPU         nenhuma detectada (modo CPU)");
  for (const g of s.gpus) console.log(`GPU         ${g.name} · ${g.vendor} · VRAM ${gb(g.vramMiB)}${g.driver ? ` · driver ${g.driver}` : ""}`);
  console.log(`Backend     recomendado: ${s.recommendedBackend} (config: ${ctx.config.engines.preferredBackend})`);
  console.log(`Node        ${s.node} (${process.execPath})`);
  console.log("");
  console.log("Pastas");
  for (const [k, v] of Object.entries({ root: p.root, data: p.data, models: p.models, engines: p.engines, projects: p.projects, agent: p.agent, web: p.web })) {
    console.log(`  ${ok(fs.existsSync(v))} ${k.padEnd(9)} ${v}`);
  }
  console.log("");
  console.log("Motores instalados");
  const engines = fs.existsSync(p.engines) ? fs.readdirSync(p.engines).filter((d) => fs.statSync(path.join(p.engines, d)).isDirectory()) : [];
  if (engines.length === 0) console.log("  (nenhum ainda — serão baixados sob demanda)");
  for (const e of engines) console.log(`  ✔ ${e}`);
  console.log("");
  console.log("Modelos");
  let total = 0;
  for (const kind of fs.existsSync(p.models) ? fs.readdirSync(p.models) : []) {
    const dir = path.join(p.models, kind);
    if (kind === "recipes" || !fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
    total += files.length;
    if (files.length) console.log(`  ${kind.padEnd(11)} ${files.length} arquivo(s)`);
  }
  if (total === 0) console.log("  (nenhum ainda)");
  console.log("");
}
