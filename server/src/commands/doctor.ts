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
  // um motor "instalado" é o que tem install.json em engines/<motor>/<os-arch>/<backend>/
  const engines: string[] = [];
  for (const dir of fs.existsSync(p.engines) ? fs.readdirSync(p.engines) : []) {
    const full = path.join(p.engines, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const backends = [...walkInstalls(full)];
    if (backends.length) engines.push(`${dir} (${backends.join(", ")})`);
  }
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

  // Cada recurso diz, em uma linha, se está pronto e o que fazer quando não está.
  console.log("Recursos");
  const { Ffmpeg } = await import("../audio/ffmpeg.js");
  const ffmpeg = new Ffmpeg(ctx).binary();
  line("ffmpeg", Boolean(ffmpeg), ffmpeg ?? "aistudio engines install ffmpeg (áudio, reuniões e vídeo dependem dele)");

  const text = ctx.models.registry.list("text").filter((m) => m.inspection.role === "main");
  line("chat", text.length > 0, text.length ? `${text.length} modelo(s) de texto` : "aistudio models pull recipe:qwen3-4b");

  const image = ctx.models.registry.list("image").filter((m) => ["main", "diffusion"].includes(m.inspection.role));
  line("imagens", image.length > 0, image.length ? `${image.length} modelo(s)` : "aistudio models pull recipe:sdxl-base (ou cole um link na aba Modelos)");

  const speech = ctx.models.registry.list("speech");
  line("transcrição", speech.length > 0, speech.length ? `${speech.length} modelo(s) whisper` : "aistudio models pull recipe:whisper-large-v3-turbo");

  const voices = safe(() => ctx.voices.list(true), []);
  line("vozes", voices.length > 0, voices.length ? `${voices.length} voz(es): ${voices.slice(0, 3).map((v) => v.id).join(", ")}` : "aistudio models pull recipe:piper-pt-br-faber");

  const ocr = ctx.models.registry.list("ocr").filter((m) => m.inspection.role === "main");
  line("OCR", ocr.length > 0, ocr.length ? `${ocr.length} modelo(s) de visão` : "aistudio models pull recipe:glm-ocr");

  const emb = ctx.models.registry.list("embeddings");
  line("busca por significado", emb.length > 0, emb.length ? `${emb.length} modelo(s)` : "aistudio models pull recipe:qwen3-embedding-0.6b (sem ele a busca é só textual)");

  const python = safe(() => ctx.python.systemPython(), null);
  line("Python (clonagem/música)", Boolean(python), python ?? "opcional: aistudio engines install uv");

  const projects = safe(() => ctx.projects.list(), []);
  line("projetos", true, projects.length ? `${projects.length}: ${projects.slice(0, 3).map((x) => x.id).join(", ")}` : "nenhum ainda (aistudio projects new \"Meus documentos\")");

  const keys = (await import("../core/auth.js")).readApiKeys(p, ctx.config);
  line("chaves de API", true, keys.length ? `${keys.length} chave(s) — a API exige Authorization` : "nenhuma (só esta máquina acessa)");
  console.log("");
}

function line(name: string, good: boolean, detail: string): void {
  console.log(`  ${good ? "✔" : "·"} ${name.padEnd(24)} ${detail}`);
}

function safe<T>(fn: () => T, fallback: T): T { try { return fn(); } catch { return fallback; } }

function* walkInstalls(dir: string, depth = 0): Generator<string> {
  if (depth > 3) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "install.json") { yield path.basename(dir); continue; }
    try { if (fs.statSync(full).isDirectory()) yield* walkInstalls(full, depth + 1); } catch { /* sumiu no meio */ }
  }
}
