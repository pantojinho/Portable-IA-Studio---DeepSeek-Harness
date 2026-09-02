import type { StudioContext } from "../core/context.js";
import { applyConfigPatch, EDITABLE, saveConfig } from "../core/config.js";
import { addApiKey, fingerprint, readApiKeys, removeApiKey } from "../core/auth.js";

/** CORE-02 + API-01 from the terminal: `aistudio config show|set|keys`. */
export async function configCmd(ctx: StudioContext, rest: string[]): Promise<void> {
  const sub = rest[0] ?? "show";
  if (sub === "show") {
    const c = structuredClone(ctx.config);
    c.server.apiKey = c.server.apiKey ? "•••" : null;
    console.log(JSON.stringify(c, null, 2));
    console.log(`\n  Arquivo: ${ctx.paths.config}\n  Editáveis: ${Object.keys(EDITABLE).join(", ")}`);
    return;
  }
  if (sub === "set") {
    const key = rest[1]; const raw = rest.slice(2).join(" ");
    if (!key || raw === "") throw new Error("uso: aistudio config set <chave> <valor>   (ex.: engines.idleUnloadMinutes 15)");
    const value = parseValue(raw);
    const patch: Record<string, unknown> = {};
    let node = patch; const parts = key.split(".");
    for (const p of parts.slice(0, -1)) { node[p] = {}; node = node[p] as Record<string, unknown>; }
    node[parts.at(-1)!] = value;
    const r = applyConfigPatch(ctx.config, patch);
    if (r.errors.length) throw new Error(r.errors.join("; "));
    Object.assign(ctx.config, r.config);
    saveConfig(ctx.paths, ctx.config);
    console.log(r.changed.length ? `  ✔ ${r.changed.join(", ")} atualizado.` : "  (nada mudou)");
    if (r.needsRestart.length) console.log(`  ⚠ reinicie o Studio para valer: ${r.needsRestart.join(", ")}`);
    return;
  }
  if (sub === "keys" || sub === "key") {
    const action = rest[1] ?? "list";
    if (action === "list") {
      const keys = readApiKeys(ctx.paths, ctx.config);
      if (!keys.length) return void console.log("  Nenhuma chave. Sem chave, a API só aceita conexões de 127.0.0.1.");
      for (const k of keys) { const f = fingerprint(k); console.log(`  ${f.prefix}… (sha256 ${f.sha256})`); }
      return;
    }
    if (action === "new") {
      const key = addApiKey(ctx.paths, rest[2]);
      console.log(`  ✔ chave criada (guarde agora, não aparece de novo):\n\n    ${key}\n`);
      return;
    }
    if (action === "remove") {
      if (!rest[2]) throw new Error("uso: aistudio config keys remove <chave>");
      console.log(removeApiKey(ctx.paths, rest[2]) ? "  ✔ chave removida." : "  chave não encontrada.");
      return;
    }
  }
  throw new Error("uso: aistudio config <show|set <chave> <valor>|keys [list|new|remove <chave>]>");
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  if (t.startsWith("[")) { try { return JSON.parse(t); } catch { /* texto mesmo */ } }
  if (t.includes(",")) return t.split(",").map((s) => s.trim()).filter(Boolean);
  return t;
}
