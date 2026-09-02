/**
 * Turn whatever the user pastes into a structured reference.
 *
 *   https://huggingface.co/org/repo                      → hf repo
 *   https://huggingface.co/org/repo/tree/main/sub        → hf repo, subpath
 *   https://huggingface.co/org/repo/blob/main/x.gguf     → hf file
 *   https://huggingface.co/org/repo/resolve/main/x.gguf  → hf file
 *   hf://org/repo[/path]   org/repo   org/repo:Q4_K_M    → hf repo (+quant hint)
 *   https://civitai.com/models/123?modelVersionId=456    → civitai
 *   https://civitai.com/api/download/models/456          → civitai version
 *   recipe:flux1-dev                                     → bundled recipe
 *   https://anything.else/file.safetensors               → direct url
 */
export type ParsedRef =
  | { provider: "huggingface"; repo: string; revision: string; path: string | null; subpath: string | null; quantHint: string | null; raw: string }
  | { provider: "civitai"; modelId: number | null; versionId: number | null; raw: string }
  | { provider: "recipe"; id: string; raw: string }
  | { provider: "url"; url: string; filename: string; raw: string };

const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co", "huggingface.com", "hf-mirror.com"]);

export function parseRef(input: string): ParsedRef {
  const raw = input.trim();
  if (!raw) throw new Error("Referência vazia.");

  if (raw.startsWith("recipe:")) return { provider: "recipe", id: raw.slice(7).trim(), raw };

  if (raw.startsWith("hf://")) {
    const rest = raw.slice(5).replace(/^\/+/, "");
    const [org, name, ...pathParts] = rest.split("/");
    if (!org || !name) throw new Error("Formato hf:// inválido. Use hf://org/repo[/arquivo].");
    return hfRef(`${org}/${name}`, "main", pathParts.length ? pathParts.join("/") : null, null, null, raw);
  }

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (HF_HOSTS.has(host)) return parseHfUrl(u, raw);
    if (host === "civitai.com" || host === "www.civitai.com") return parseCivitai(u, raw);
    const filename = decodeURIComponent(u.pathname.split("/").pop() || "") || "download";
    return { provider: "url", url: raw, filename, raw };
  }

  // bare "org/repo" or "org/repo:quant" or "org/repo/path"
  const m = raw.match(/^([\w.-]+)\/([\w.-]+)(?::([\w.-]+))?(?:\/(.+))?$/);
  if (m) return hfRef(`${m[1]}/${m[2]}`, "main", m[4] ?? null, null, m[3] ?? null, raw);

  throw new Error("Não reconheci essa referência. Cole um link do Hugging Face, do CivitAI, um id 'org/repo' ou uma URL direta para o arquivo.");
}

function hfRef(repo: string, revision: string, path: string | null, subpath: string | null, quantHint: string | null, raw: string): ParsedRef {
  return { provider: "huggingface", repo, revision, path, subpath, quantHint, raw };
}

function parseHfUrl(u: URL, raw: string): ParsedRef {
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  // strip optional "models/" prefix used by some links
  if (parts[0] === "models") parts.shift();
  if (parts.length < 2) throw new Error("Link do Hugging Face sem 'org/repo'.");
  const repo = `${parts[0]}/${parts[1]}`;
  const rest = parts.slice(2);
  if (rest.length === 0) return hfRef(repo, "main", null, null, null, raw);
  const kind = rest[0];
  if (kind === "blob" || kind === "resolve") {
    const revision = rest[1] ?? "main";
    const path = rest.slice(2).join("/") || null;
    return hfRef(repo, revision, path, null, null, raw);
  }
  if (kind === "tree") {
    const revision = rest[1] ?? "main";
    const subpath = rest.slice(2).join("/") || null;
    return hfRef(repo, revision, null, subpath, null, raw);
  }
  // e.g. /org/repo/discussions, /org/repo?not-for-all-audiences=true → treat as repo
  return hfRef(repo, "main", null, null, null, raw);
}

function parseCivitai(u: URL, raw: string): ParsedRef {
  const m1 = u.pathname.match(/\/models\/(\d+)/);
  const m2 = u.pathname.match(/\/api\/download\/models\/(\d+)/);
  const versionId = m2 ? Number(m2[1]) : u.searchParams.get("modelVersionId") ? Number(u.searchParams.get("modelVersionId")) : null;
  const modelId = m1 ? Number(m1[1]) : null;
  if (!modelId && !versionId) throw new Error("Link do CivitAI sem id de modelo.");
  return { provider: "civitai", modelId, versionId, raw };
}

/** Normalised display id for a reference ("org/repo", "civitai:123", …). */
export function refLabel(r: ParsedRef): string {
  switch (r.provider) {
    case "huggingface": return r.path ? `${r.repo}/${r.path}` : r.repo;
    case "civitai": return `civitai:${r.versionId ?? r.modelId}`;
    case "recipe": return `recipe:${r.id}`;
    case "url": return r.filename;
  }
}
