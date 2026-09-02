import fs from "node:fs";
import path from "node:path";
import type { HfModelInfo, HfTreeEntry } from "./types.js";
import { logger } from "../core/log.js";

const log = logger("hf");
const HF = "https://huggingface.co";
const UA = "AI-Studio/0.1 (+https://github.com/aistudio)";

export interface HfClientOptions {
  token?: string | null;
  mirror?: string | null;
  cacheDir?: string;
  /** seconds a cached API response stays fresh */
  ttlSec?: number;
}

export class HfError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/**
 * Thin Hugging Face Hub client: model info, file tree, search, quantized
 * derivatives. Responses are cached on disk so re-resolving a link is instant
 * and works offline for repos already seen.
 */
export class HfClient {
  private token: string | null;
  private base: string;
  private cacheDir: string | null;
  private ttl: number;

  constructor(opts: HfClientOptions = {}) {
    this.token = opts.token ?? process.env.HF_TOKEN ?? null;
    this.base = (opts.mirror ?? process.env.HF_ENDPOINT ?? HF).replace(/\/+$/, "");
    this.cacheDir = opts.cacheDir ?? null;
    this.ttl = opts.ttlSec ?? 3600;
  }

  get endpoint(): string { return this.base; }
  setToken(t: string | null): void { this.token = t; }
  hasToken(): boolean { return !!this.token; }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { "user-agent": UA, ...extra };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private cachePath(key: string): string | null {
    if (!this.cacheDir) return null;
    return path.join(this.cacheDir, "hf", key.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 180) + ".json");
  }

  private async getJson<T>(url: string, cacheKey?: string): Promise<T> {
    const cp = cacheKey ? this.cachePath(cacheKey) : null;
    if (cp && fs.existsSync(cp)) {
      try {
        const st = fs.statSync(cp);
        if (Date.now() - st.mtimeMs < this.ttl * 1000) return JSON.parse(fs.readFileSync(cp, "utf8")) as T;
      } catch { /* refetch */ }
    }
    let res: Response;
    try { res = await fetch(url, { headers: this.headers({ accept: "application/json" }) }); }
    catch (e) {
      if (cp && fs.existsSync(cp)) { log.warn(`offline: usando cache para ${cacheKey}`); return JSON.parse(fs.readFileSync(cp, "utf8")) as T; }
      throw new HfError(`Sem conexão com ${this.base}: ${(e as Error).message}`, 0, "offline");
    }
    if (!res.ok) {
      const code = res.headers.get("x-error-code") ?? undefined;
      const msg = res.headers.get("x-error-message") ?? (await res.text().catch(() => "")).slice(0, 200);
      throw new HfError(describeStatus(res.status, code, msg), res.status, code);
    }
    const data = (await res.json()) as T;
    if (cp) { try { fs.mkdirSync(path.dirname(cp), { recursive: true }); fs.writeFileSync(cp, JSON.stringify(data)); } catch { /* ignore */ } }
    return data;
  }

  async modelInfo(repo: string, revision = "main"): Promise<HfModelInfo> {
    return this.getJson<HfModelInfo>(`${this.base}/api/models/${repo}/revision/${encodeURIComponent(revision)}`, `info_${repo}_${revision}`);
  }

  /** Full recursive tree. The Hub paginates at 1000 entries (Link: rel="next"); we follow up to 25 pages. */
  async tree(repo: string, revision = "main", subpath = ""): Promise<HfTreeEntry[]> {
    const sp = subpath ? "/" + subpath.split("/").map(encodeURIComponent).join("/") : "";
    const key = `tree_${repo}_${revision}_${subpath}`;
    const cp = this.cachePath(key);
    if (cp && fs.existsSync(cp) && Date.now() - fs.statSync(cp).mtimeMs < this.ttl * 1000) {
      try { return JSON.parse(fs.readFileSync(cp, "utf8")) as HfTreeEntry[]; } catch { /* refetch */ }
    }
    let url: string | null = `${this.base}/api/models/${repo}/tree/${encodeURIComponent(revision)}${sp}?recursive=true&expand=false&limit=1000`;
    const all: HfTreeEntry[] = [];
    for (let page = 0; url && page < 25; page++) {
      let res: Response;
      try { res = await fetch(url, { headers: this.headers({ accept: "application/json" }) }); }
      catch (e) {
        if (cp && fs.existsSync(cp)) { log.warn(`offline: usando cache para ${key}`); return JSON.parse(fs.readFileSync(cp, "utf8")) as HfTreeEntry[]; }
        throw new HfError(`Sem conexão com ${this.base}: ${(e as Error).message}`, 0, "offline");
      }
      if (!res.ok) throw new HfError(describeStatus(res.status, res.headers.get("x-error-code") ?? undefined, res.headers.get("x-error-message") ?? undefined), res.status);
      const batch = (await res.json()) as HfTreeEntry[];
      if (Array.isArray(batch)) all.push(...batch);
      const link = res.headers.get("link") ?? "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1]! : null;
    }
    if (cp) { try { fs.mkdirSync(path.dirname(cp), { recursive: true }); fs.writeFileSync(cp, JSON.stringify(all)); } catch { /* ignore */ } }
    return all;
  }

  async search(q: string, opts: { filter?: string[]; limit?: number; pipeline?: string; sort?: "downloads" | "likes" | "lastModified" } = {}): Promise<HfModelInfo[]> {
    const p = new URLSearchParams({ search: q, limit: String(opts.limit ?? 20), sort: opts.sort ?? "downloads", direction: "-1", full: "false" });
    for (const f of opts.filter ?? []) p.append("filter", f);
    if (opts.pipeline) p.set("pipeline_tag", opts.pipeline);
    return this.getJson<HfModelInfo[]>(`${this.base}/api/models?${p.toString()}`);
  }

  /** Repos that quantized/converted `baseRepo` (GGUF etc.), most downloaded first. */
  async quantizedDerivatives(baseRepo: string, format: "gguf" | "onnx" | "safetensors" = "gguf"): Promise<HfModelInfo[]> {
    const p = new URLSearchParams({ filter: `base_model:quantized:${baseRepo}`, sort: "downloads", direction: "-1", limit: "30" });
    const list = await this.getJson<HfModelInfo[]>(`${this.base}/api/models?${p.toString()}`, `quant_${baseRepo}`);
    return (Array.isArray(list) ? list : []).filter((m) => (m.tags ?? []).includes(format));
  }

  fileUrl(repo: string, repoPath: string, revision = "main"): string {
    return `${this.base}/${repo}/resolve/${encodeURIComponent(revision)}/${repoPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** HEAD a file to learn its final size / redirect target without downloading. */
  async fileMeta(repo: string, repoPath: string, revision = "main"): Promise<{ size: number | null; sha256: string | null; gatedDenied: boolean }> {
    const url = this.fileUrl(repo, repoPath, revision);
    const res = await fetch(url, { method: "HEAD", headers: this.headers(), redirect: "manual" });
    if (res.status === 401 || res.status === 403) return { size: null, sha256: null, gatedDenied: true };
    const linked = Number(res.headers.get("x-linked-size") ?? "") || null;
    const etag = (res.headers.get("x-linked-etag") ?? res.headers.get("etag") ?? "").replace(/"/g, "");
    // LFS files answer with X-Linked-Size on the redirect; small non-LFS files redirect without it,
    // and the redirect body's content-length is NOT the file size — follow to the real one.
    let size = linked;
    if (!size) {
      if (res.status >= 300 && res.status < 400) {
        const fin = await fetch(url, { method: "HEAD", headers: this.headers(), redirect: "follow" });
        if (fin.status === 401 || fin.status === 403) return { size: null, sha256: null, gatedDenied: true };
        size = Number(fin.headers.get("content-length") ?? "") || null;
      } else size = Number(res.headers.get("content-length") ?? "") || null;
    }
    return { size, sha256: /^[0-9a-f]{64}$/.test(etag) ? etag : null, gatedDenied: false };
  }
}

function describeStatus(status: number, code?: string, msg?: string): string {
  if (code === "GatedRepo") return "Este repositório é 'gated': abra a página do modelo no Hugging Face, aceite a licença e informe seu token HF nas configurações.";
  if (code === "RepoNotFound" || status === 404) return "Repositório ou arquivo não encontrado no Hugging Face. Confira o link.";
  if (status === 401) return "O Hugging Face pediu autenticação. Informe um token HF nas configurações.";
  if (status === 403) return "Acesso negado pelo Hugging Face (licença não aceita ou token sem permissão).";
  if (status === 429) return "O Hugging Face limitou as requisições. Tente de novo em instantes.";
  return `Hugging Face respondeu HTTP ${status}${msg ? `: ${msg}` : ""}`;
}

/** Match a repo path against a simple glob ("*" = any chars except "/", "**" = anything). */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export function isSplitShard(p: string): { base: string; index: number; total: number } | null {
  const m = p.match(/^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i);
  return m ? { base: m[1]!, index: Number(m[2]), total: Number(m[3]) } : null;
}
