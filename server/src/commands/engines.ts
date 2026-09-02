import type { StudioContext } from "../core/context.js";
import type { Backend } from "../core/system.js";
import type { EngineId } from "../engines/types.js";

const HELP = `aistudio engines
  list                         motores instalados e instâncias
  adopt                        adota binários de uma instalação Uncensored-Local-Studio ao lado (hardlink, sem download)
  install <motor> [--backend B] baixa do catálogo (llamacpp | sdcpp | whispercpp; B = cuda|vulkan|rocm|metal|cpu)
  start <modelo>               sobe o motor para um modelo da biblioteca
  stop-all
aistudio providers
  list                         provedores remotos (via API) e se têm chave
  key <id> <CHAVE|clear>       guarda a chave (data/secrets/provider_<id>)
aistudio run "<pergunta>" [--model id]   chat rápido pelo /v1 local
`;

export async function enginesCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const svc = ctx.engines;
  switch (rest[0] ?? "list") {
    case "list": {
      const s = svc.status();
      console.log(`backend preferido: ${await svc.preferredBackend()}`);
      for (const e of s.engines) console.log(`${e.id.padEnd(12)} ${e.installed.length ? e.installed.map((i) => `${i.backend} (${i.version})`).join(", ") : "não instalado"}`);
      if (s.instances.length) { console.log("\ninstâncias:"); for (const i of s.instances) console.log(`  ${i.id}  ${i.status}  porta ${i.port}  ~${i.vramMiB} MiB`); }
      return;
    }
    case "adopt": {
      const r = svc.adoptAll();
      for (const a of r.adopted) console.log(`✔ ${a.engine}/${a.backend} ← ${a.dir}`);
      if (r.adopted.length === 0) console.log("nada para adotar (instalação antiga não encontrada ou já adotada)");
      return;
    }
    case "install": {
      const id = rest[1] as EngineId | undefined;
      if (!id) { console.log(HELP); process.exitCode = 1; return; }
      const backend = (typeof flags.backend === "string" ? flags.backend : await svc.preferredBackend()) as Backend;
      const job = ctx.jobs.create("download", `Instalar ${id} (${backend})`, (j) => svc.installer.install(id, backend, j));
      await waitJob(job.id);
      return;
    }
    case "start": {
      if (!rest[1]) { console.log(HELP); process.exitCode = 1; return; }
      const inst = await svc.start(rest[1]);
      console.log(`✔ ${inst.id} pronto em ${inst.baseUrl} (~${inst.vramMiB} MiB)`);
      await svc.supervisor.stopAll();
      return;
    }
    case "stop-all": await svc.supervisor.stopAll(); return;
    default: console.log(HELP); process.exitCode = 1;
  }
}

export async function providersCmd(ctx: StudioContext, rest: string[]): Promise<void> {
  switch (rest[0] ?? "list") {
    case "list": for (const [id, p] of Object.entries(ctx.providers.all())) console.log(`${id.padEnd(12)} ${ctx.providers.key(id) ? "chave ✔" : "sem chave"}  ${p.baseURL}  ${p.models.join(", ")}`); return;
    case "key": { if (!rest[1] || !rest[2]) { console.log(HELP); process.exitCode = 1; return; } ctx.providers.setKey(rest[1], rest[2] === "clear" ? null : rest[2]); console.log("ok"); return; }
    default: console.log(HELP); process.exitCode = 1;
  }
}

/** `aistudio run "pergunta"`: starts the model, streams the answer, stops the engine. */
export async function runCmd(ctx: StudioContext, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const prompt = rest.join(" ").trim();
  if (!prompt) { console.log(HELP); process.exitCode = 1; return; }
  const modelRef = typeof flags.model === "string" ? flags.model : ctx.models.registry.list("text").find((m) => m.inspection.role === "main")?.id;
  if (!modelRef) { console.error("nenhum modelo de texto na biblioteca. Ex.: aistudio models pull unsloth/Qwen3-4B-GGUF"); process.exitCode = 1; return; }
  const remote = ctx.providers.split(modelRef);
  let up: Response;
  if (remote) up = await ctx.providers.forward(remote.id, remote.cfg, "/chat/completions", { model: remote.model, messages: [{ role: "user", content: prompt }], stream: true });
  else {
    const inst = await ctx.engines.start(modelRef);
    process.stderr.write(`[${inst.model?.id} em ${inst.baseUrl}]\n`);
    up = await fetch(`${inst.baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: inst.model?.id, messages: [{ role: "user", content: prompt }], stream: true }) });
  }
  if (!up.ok || !up.body) { console.error(`HTTP ${up.status}: ${(await up.text()).slice(0, 400)}`); process.exitCode = 1; }
  else {
    const reader = up.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue; const d = line.slice(5).trim(); if (d === "[DONE]") continue;
        try { const j = JSON.parse(d); const t = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.delta?.reasoning_content ?? ""; process.stdout.write(t); } catch { /* */ }
      }
    }
    process.stdout.write("\n");
  }
  await ctx.engines.supervisor.stopAll();
}

function waitJob(id: string): Promise<void> {
  return new Promise((resolve) => {
    const { bus } = require("../core/events.js") as typeof import("../core/events.js");
    let last = "";
    const off = bus.subscribe("job", (ev) => {
      const j = ev.data as import("../core/jobs.js").JobInfo; if (j.id !== id) return;
      if (j.message !== last) { process.stdout.write(`\r  ${j.message.padEnd(90)}`); last = j.message; }
      if (["done", "failed", "cancelled"].includes(j.status)) { process.stdout.write("\n"); if (j.status === "failed") { console.error(`  ✘ ${j.error}`); process.exitCode = 1; } off(); resolve(); }
    });
  });
}
