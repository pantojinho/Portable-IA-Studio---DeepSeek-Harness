import path from "node:path";
import type { ModelKind } from "../core/paths.js";
import { HfClient, HfError, globToRegExp, isSplitShard } from "./hf.js";
import { parseRef, refLabel, type ParsedRef } from "./refs.js";
import { guessFromName, quantFromName } from "./inspect.js";
import type { Recipe, RecipeFile, RecipeFileFrom, RecipeStore } from "./recipes.js";
import type { DownloadPlan, FileRole, HfModelInfo, HfTreeEntry, PlannedFile } from "./types.js";

/**
 * From "whatever the user pasted" to a concrete, verified list of files.
 * Every file in the plan exists in the repository tree (or answered a HEAD),
 * has a size, and knows where it will live. Nothing is downloaded here.
 */
export interface ResolveContext {
  hf: HfClient;
  recipes: RecipeStore;
  vramMiB: number | null;
  ramMiB: number;
  /** override automatic quant choice ("Q8_0") */
  quant?: string | null;
}

const MiB = 1024 * 1024;
const WEIGHT_EXT = /\.(gguf|safetensors|ckpt|pt|pth|bin|onnx)$/i;
const IGNORE_DIRS = /^(images?|assets|examples|samples|docs?|wheel|figures?)\//i;

export async function resolvePlan(input: string, ctx: ResolveContext): Promise<DownloadPlan> {
  const ref = parseRef(input);
  switch (ref.provider) {
    case "recipe": {
      const r = ctx.recipes.get(ref.id);
      if (!r) throw new Error(`Receita '${ref.id}' não existe.`);
      return planFromRecipe(r, ctx, input);
    }
    case "url": return planFromUrl(ref, ctx);
    case "civitai": return planFromCivitai(ref, ctx);
    case "huggingface": return planFromHf(ref, ctx);
  }
}

// ------------------------------------------------------------- budgets ---

function budgetBytes(ctx: ResolveContext, kind: ModelKind): number {
  // What we are willing to put on the accelerator. llama.cpp/sd.cpp can offload,
  // so this is a preference, not a hard limit; the plan warns when exceeded.
  const vram = ctx.vramMiB ? ctx.vramMiB * MiB : 0;
  const ram = ctx.ramMiB * MiB;
  if (kind === "text" || kind === "ocr" || kind === "vision") return vram ? Math.max(vram * 0.85, Math.min(ram * 0.5, 24 * 1024 * MiB)) : ram * 0.5;
  if (kind === "image" || kind === "video") return vram ? Math.max(vram * 0.9, ram * 0.35) : ram * 0.35;
  return ram * 0.5;
}

/** Pick a quantised file: first `prefer` entry that exists and fits; otherwise the smallest match. */
export function pickByPreference(
  entries: { path: string; size: number }[], prefer: string[], budget: number, quantOverride?: string | null,
): { path: string; size: number; quant: string | null; fits: boolean } | null {
  if (entries.length === 0) return null;
  const q = (e: { path: string }) => quantFromName(path.posix.basename(e.path));
  if (quantOverride) {
    const hit = entries.find((e) => (q(e) ?? "").toLowerCase() === quantOverride.toLowerCase());
    if (hit) return { ...hit, quant: q(hit), fits: hit.size <= budget };
  }
  const order = prefer.map((p) => p.toLowerCase());
  const ranked = entries.map((e) => ({ e, rank: order.indexOf((q(e) ?? "").toLowerCase()) })).filter((x) => x.rank >= 0).sort((a, b) => a.rank - b.rank);
  const fitting = ranked.find((x) => x.e.size <= budget);
  if (fitting) return { ...fitting.e, quant: q(fitting.e), fits: true };
  const smallest = [...entries].sort((a, b) => a.size - b.size)[0]!;
  return { ...smallest, quant: q(smallest), fits: smallest.size <= budget };
}

// -------------------------------------------------------------- recipe ---

interface TreeCache { [key: string]: Promise<{ entries: HfTreeEntry[]; info: HfModelInfo | null; error: string | null }> }

function repoTree(ctx: ResolveContext, cache: TreeCache, repo: string, revision = "main") {
  const key = `${repo}@${revision}`;
  cache[key] ??= (async () => {
    try {
      const [info, entries] = await Promise.all([ctx.hf.modelInfo(repo, revision).catch(() => null), ctx.hf.tree(repo, revision)]);
      return { entries: entries.filter((e) => e.type === "file"), info, error: null };
    } catch (e) { return { entries: [], info: null, error: (e as Error).message }; }
  })();
  return cache[key]!;
}

function sizeOf(e: HfTreeEntry): number { return e.lfs?.size ?? e.size ?? 0; }
function shaOf(e: HfTreeEntry): string | null { return e.lfs?.oid && /^[0-9a-f]{64}$/.test(e.lfs.oid) ? e.lfs.oid : null; }

async function resolveFrom(
  ctx: ResolveContext, cache: TreeCache, from: RecipeFileFrom, kind: ModelKind, warnings: string[], multi: boolean,
): Promise<{ repo: string; revision: string; entries: HfTreeEntry[]; quant: string | null; fits: boolean } | null> {
  const revision = from.revision ?? "main";
  const { entries, info, error } = await repoTree(ctx, cache, from.repo, revision);
  const gated = !!info?.gated && !ctx.hf.hasToken();
  const tryAlt = async (why: string) => {
    warnings.push(`${from.repo}: ${why}`);
    for (const alt of from.alternatives ?? []) { const r = await resolveFrom(ctx, cache, alt, kind, warnings, multi); if (r) return r; }
    return null;
  };
  if (error) return tryAlt(error);
  if (entries.length === 0) return tryAlt("árvore vazia ou inacessível");
  if (gated) {
    // prefer a non-gated alternative; if there is none, keep the gated file and say so —
    // the UI asks for the token instead of hiding the whole plan
    const alt = (from.alternatives ?? []).length ? await tryAlt("repositório gated e nenhum token HF configurado — tentando alternativa") : null;
    if (alt) return alt;
    warnings.push(`${from.repo} é gated: aceite a licença na página do Hugging Face e informe seu token (aistudio models token hf <TOKEN>) antes de baixar.`);
  }

  if (from.path) {
    const e = entries.find((x) => x.path === from.path);
    if (e) return { repo: from.repo, revision, entries: [e], quant: quantFromName(e.path), fits: true };
    // huge repos (piper-voices) can exceed what we page through: confirm the exact path with a HEAD
    const meta = await ctx.hf.fileMeta(from.repo, from.path, revision).catch(() => null);
    if (meta && !meta.gatedDenied && meta.size) {
      return { repo: from.repo, revision, entries: [{ type: "file", path: from.path, size: meta.size, lfs: meta.sha256 ? { oid: meta.sha256, size: meta.size } : undefined }], quant: quantFromName(from.path), fits: true };
    }
    return tryAlt(`arquivo '${from.path}' não encontrado`);
  }
  if (from.glob) {
    const re = globToRegExp(from.glob);
    const hits = entries.filter((x) => re.test(x.path)).sort((a, b) => a.path.localeCompare(b.path));
    if (hits.length === 0) return tryAlt(`nenhum arquivo bate com '${from.glob}'`);
    return { repo: from.repo, revision, entries: multi ? hits : [hits[0]!], quant: quantFromName(hits[0]!.path), fits: true };
  }
  if (from.pattern) {
    const cands = entries.filter((x) => WEIGHT_EXT.test(x.path) && !/mmproj/i.test(x.path)).map((x) => ({ path: x.path, size: sizeOf(x), entry: x }));
    const matchesPattern = (p: string, quant: string) => globToRegExp(from.pattern!.replace("{quant}", quant)).test(p);
    const prefer = from.prefer ?? ["Q4_K_M", "Q8_0"];
    const pool = cands.filter((c) => prefer.some((q) => matchesPattern(c.path, q)) || (ctx.quant && matchesPattern(c.path, ctx.quant)));
    const picked = pickByPreference(pool.length ? pool : cands.filter((c) => /\.gguf$/i.test(c.path)), prefer, budgetBytes(ctx, kind), ctx.quant);
    if (!picked) return tryAlt(`nenhum arquivo bate com o padrão '${from.pattern}'`);
    // split shards travel together
    const shard = isSplitShard(picked.path);
    const group = shard ? entries.filter((x) => isSplitShard(x.path)?.base === shard.base) : [entries.find((x) => x.path === picked.path)!];
    if (!picked.fits) warnings.push(`${path.posix.basename(picked.path)} (${fmtBytes(picked.size)}) passa do orçamento de VRAM; vai rodar com offload para RAM/CPU.`);
    return { repo: from.repo, revision, entries: group, quant: picked.quant, fits: picked.fits };
  }
  return tryAlt("origem sem path/glob/pattern");
}

export async function planFromRecipe(recipe: Recipe, ctx: ResolveContext, ref = `recipe:${recipe.id}`): Promise<DownloadPlan> {
  const cache: TreeCache = {};
  const warnings: string[] = [];
  const files: PlannedFile[] = [];
  if (recipe.status === "planned") warnings.push(`Motor '${recipe.engine}' ainda não existe no Studio: os arquivos podem ser baixados, mas não rodam ainda.`);
  if (recipe.nonCommercial) warnings.push(`Licença não comercial (${recipe.license}).`);

  for (const f of recipe.files) {
    const kind = f.kind ?? recipe.kind;
    const multi = f.role === "voice" || f.role === "config";
    const r = await resolveFrom(ctx, cache, f.from, kind, warnings, multi);
    if (!r) {
      if (f.optional) { warnings.push(`arquivo opcional '${f.slot}' não resolvido`); continue; }
      throw new Error(`Receita ${recipe.id}: não consegui resolver '${f.slot}' (${f.role}). ${warnings.slice(-3).join(" | ")}`);
    }
    for (const e of r.entries) {
      files.push({
        url: ctx.hf.fileUrl(r.repo, e.path, r.revision), repo: r.repo, repoPath: e.path, revision: r.revision,
        filename: f.filename && r.entries.length === 1 ? f.filename : path.posix.basename(e.path),
        kind, subdir: f.subdir, role: f.role, sizeBytes: sizeOf(e) || null, sha256: shaOf(e), tentative: false,
      });
    }
  }
  const total = files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0);
  if (recipe.minVramMiB && ctx.vramMiB && ctx.vramMiB < recipe.minVramMiB) warnings.push(`Recomenda ${Math.round(recipe.minVramMiB / 1024)} GB de VRAM; esta máquina tem ${Math.round(ctx.vramMiB / 1024)} GB. Vai funcionar com offload, mais devagar.`);
  return { ref, title: recipe.name, provider: "recipe", recipeId: recipe.id, files, totalBytes: total || null, warnings: [...new Set(warnings)], license: recipe.license, gated: recipe.gated };
}

// --------------------------------------------------------- hugging face ---

async function planFromHf(ref: Extract<ParsedRef, { provider: "huggingface" }>, ctx: ResolveContext): Promise<DownloadPlan> {
  const cache: TreeCache = {};
  const warnings: string[] = [];

  // 1) a specific file
  if (ref.path && WEIGHT_EXT.test(ref.path) || ref.path && /\.(json|txt)$/i.test(ref.path)) {
    const { entries, info } = await repoTree(ctx, cache, ref.repo, ref.revision);
    const e = entries.find((x) => x.path === ref.path);
    if (!e) throw new Error(`'${ref.path}' não existe em ${ref.repo}.`);
    const g = guessFromName(e.path);
    const files: PlannedFile[] = [{ url: ctx.hf.fileUrl(ref.repo, e.path, ref.revision), repo: ref.repo, repoPath: e.path, revision: ref.revision, filename: path.posix.basename(e.path), kind: g.kind ?? "text", role: g.role, sizeBytes: sizeOf(e) || null, sha256: shaOf(e), tentative: true }];
    // vision model? bring its projector along
    if (g.kind === "text" && /\.gguf$/i.test(e.path)) {
      const mm = entries.find((x) => /mmproj/i.test(x.path) && /\.gguf$/i.test(x.path));
      if (mm) files.push({ url: ctx.hf.fileUrl(ref.repo, mm.path, ref.revision), repo: ref.repo, repoPath: mm.path, revision: ref.revision, filename: path.posix.basename(mm.path), kind: "vision", role: "mmproj", sizeBytes: sizeOf(mm) || null, sha256: shaOf(mm), tentative: false });
    }
    return finish(ref.raw, `${ref.repo}/${path.posix.basename(e.path)}`, "huggingface", ref.repo, ref.revision, files, warnings, info);
  }

  // 2) a recipe knows this repo
  const recipes = ctx.recipes.forRepo(ref.repo).sort((a, b) => statusRank(a) - statusRank(b));
  if (recipes.length > 0) {
    const plan = await planFromRecipe(recipes[0]!, ctx, ref.raw);
    if (recipes.length > 1) plan.warnings.push(`Outras receitas para este repositório: ${recipes.slice(1).map((r) => r.id).join(", ")}`);
    return plan;
  }

  // 3) generic repository
  const { entries, info, error } = await repoTree(ctx, cache, ref.repo, ref.revision);
  if (error) throw new Error(error);
  if (info?.gated && !ctx.hf.hasToken()) warnings.push("Repositório gated: aceite a licença no Hugging Face e informe o token, ou o download vai falhar.");
  const scoped = ref.subpath ? entries.filter((e) => e.path.startsWith(ref.subpath + "/")) : entries;
  const weights = scoped.filter((e) => WEIGHT_EXT.test(e.path) && !IGNORE_DIRS.test(e.path));
  const ggufs = weights.filter((e) => /\.gguf$/i.test(e.path));
  const kindHint = kindFromInfo(info, ref.repo);

  if (ggufs.length > 0) return planGgufRepo(ref, ctx, entries, info, kindHint, warnings);

  // single-file checkpoints at the root of an image repo (SDXL, SD1.5 finetunes…)
  const roots = weights.filter((e) => !e.path.includes("/") && /\.(safetensors|ckpt)$/i.test(e.path) && sizeOf(e) > 500 * MiB);
  if ((kindHint === "image" || kindHint === null) && roots.length > 0) {
    const preferred = [...roots].sort((a, b) => scoreCheckpointName(b.path) - scoreCheckpointName(a.path) || sizeOf(a) - sizeOf(b))[0]!;
    const files: PlannedFile[] = [{ url: ctx.hf.fileUrl(ref.repo, preferred.path, ref.revision), repo: ref.repo, repoPath: preferred.path, revision: ref.revision, filename: preferred.path, kind: "image", role: "main", sizeBytes: sizeOf(preferred) || null, sha256: shaOf(preferred), tentative: true }];
    const plan = finish(ref.raw, ref.repo, "huggingface", ref.repo, ref.revision, files, warnings, info);
    plan.alternatives = roots.filter((r) => r !== preferred).map((r) => ({ label: r.path, repoPath: r.path, sizeBytes: sizeOf(r) || null }));
    return plan;
  }

  // onnx voices / ocr packs: take everything under the scope
  const onnx = scoped.filter((e) => /\.onnx$/i.test(e.path));
  if (onnx.length > 0 && (ref.subpath || onnx.length <= 6)) {
    const kind: ModelKind = kindHint === "ocr" ? "ocr" : "tts";
    const picks = scoped.filter((e) => /\.(onnx|json|bin|txt)$/i.test(e.path) && !/\.onnx_data$/i.test(e.path) && sizeOf(e) < 2 * 1024 * MiB);
    const files = picks.map<PlannedFile>((e) => { const g = guessFromName(e.path); return { url: ctx.hf.fileUrl(ref.repo, e.path, ref.revision), repo: ref.repo, repoPath: e.path, revision: ref.revision, filename: path.posix.basename(e.path), kind, subdir: ref.repo.split("/")[1], role: g.role === "unknown" ? "voice" : g.role, sizeBytes: sizeOf(e) || null, sha256: shaOf(e), tentative: true }; });
    return finish(ref.raw, ref.repo, "huggingface", ref.repo, ref.revision, files, warnings, info);
  }

  // diffusers / transformers layout: look for a GGUF conversion of this repo
  const derivs = await ctx.hf.quantizedDerivatives(ref.repo, "gguf").catch(() => [] as HfModelInfo[]);
  const ranked = derivs.sort((a, b) => trustRank(a.id) - trustRank(b.id) || (b.downloads ?? 0) - (a.downloads ?? 0));
  for (const d of ranked.slice(0, 4)) {
    const known = ctx.recipes.forRepo(d.id);
    if (known.length) { const plan = await planFromRecipe(known[0]!, ctx, ref.raw); plan.warnings.unshift(`${ref.repo} são pesos originais; usando a conversão GGUF ${d.id} pela receita ${known[0]!.id}.`); return plan; }
    const t = await repoTree(ctx, cache, d.id, "main");
    if (t.entries.some((e) => /\.gguf$/i.test(e.path))) {
      const sub = { ...ref, repo: d.id, revision: "main", raw: ref.raw };
      const plan = await planGgufRepo(sub, ctx, t.entries, t.info, kindHint, warnings);
      plan.warnings.unshift(`${ref.repo} são pesos originais (transformers/diffusers); usando a conversão GGUF mais popular: ${d.id}.`);
      if (kindHint === "image" || kindHint === "video") plan.warnings.push("Modelo de difusão sem receita: VAE e text encoders precisam ser adicionados manualmente ou por uma receita (ver models/recipes/builtin.yaml).");
      return plan;
    }
  }

  // nothing runnable natively
  const files = weights.filter((e) => sizeOf(e) > 0).slice(0, 40).map<PlannedFile>((e) => { const g = guessFromName(e.path); return { url: ctx.hf.fileUrl(ref.repo, e.path, ref.revision), repo: ref.repo, repoPath: e.path, revision: ref.revision, filename: path.posix.basename(e.path), kind: kindHint ?? g.kind ?? "text", subdir: ref.repo.split("/")[1], role: g.role, sizeBytes: sizeOf(e) || null, sha256: shaOf(e), tentative: true }; });
  warnings.push("Este repositório está em formato transformers/diffusers e não tem conversão GGUF conhecida. Os arquivos podem ser baixados, mas só rodam pelo motor Python (ainda não disponível) ou após conversão.");
  return finish(ref.raw, ref.repo, "huggingface", ref.repo, ref.revision, files, warnings, info);
}

async function planGgufRepo(ref: Extract<ParsedRef, { provider: "huggingface" }>, ctx: ResolveContext, entries: HfTreeEntry[], info: HfModelInfo | null, kindHint: ModelKind | null, warnings: string[]): Promise<DownloadPlan> {
  const ggufs = entries.filter((e) => /\.gguf$/i.test(e.path));
  const mmprojs = ggufs.filter((e) => /mmproj/i.test(e.path));
  const mains = ggufs.filter((e) => !/mmproj/i.test(e.path));
  const name = ref.repo.split("/")[1] ?? ref.repo;
  const kind: ModelKind = kindHint && kindHint !== "vision" ? kindHint : /ocr/i.test(name) ? "ocr" : /embed/i.test(name) ? "embeddings" : /rerank/i.test(name) ? "rerank" : /whisper/i.test(name) ? "speech" : "text";
  const isDiffusion = kind === "image" || kind === "video";
  const prefer = kind === "ocr" || kind === "embeddings" || kind === "rerank" ? ["Q8_0", "f16", "Q6_K", "Q4_K_M", "bf16"]
    : isDiffusion ? ["Q4_K_S", "Q4_K_M", "Q4_0", "Q5_K_S", "Q5_0", "Q6_K", "Q8_0", "Q3_K_S", "Q3_K_M", "F16", "BF16"]
    : ["Q4_K_M", "Q5_K_M", "Q4_K_S", "Q6_K", "Q8_0", "Q3_K_M", "IQ4_XS", "Q4_0", "F16", "BF16"];
  const cands = mains.filter((e) => !isSplitShard(e.path) || isSplitShard(e.path)!.index === 1).map((e) => ({ path: e.path, size: isSplitShard(e.path) ? mains.filter((x) => isSplitShard(x.path)?.base === isSplitShard(e.path)!.base).reduce((a, x) => a + sizeOf(x), 0) : sizeOf(e) }));
  const picked = pickByPreference(cands, prefer, budgetBytes(ctx, kind), ref.quantHint ?? ctx.quant);
  if (!picked) throw new Error(`${ref.repo}: nenhum GGUF utilizável.`);
  if (!picked.fits) warnings.push(`${path.posix.basename(picked.path)} (${fmtBytes(picked.size)}) passa do orçamento de VRAM; vai rodar com offload para RAM/CPU.`);
  const shard = isSplitShard(picked.path);
  const group = shard ? mains.filter((x) => isSplitShard(x.path)?.base === shard.base) : [mains.find((x) => x.path === picked.path)!];
  const files = group.map<PlannedFile>((e) => ({ url: ctx.hf.fileUrl(ref.repo, e.path, ref.revision), repo: ref.repo, repoPath: e.path, revision: ref.revision, filename: path.posix.basename(e.path), kind, role: isDiffusion ? "diffusion" : "main", sizeBytes: sizeOf(e) || null, sha256: shaOf(e), tentative: false }));
  if (mmprojs.length > 0) {
    const mm = [...mmprojs].sort((a, b) => scoreMmproj(b.path) - scoreMmproj(a.path))[0]!;
    files.push({ url: ctx.hf.fileUrl(ref.repo, mm.path, ref.revision), repo: ref.repo, repoPath: mm.path, revision: ref.revision, filename: path.posix.basename(mm.path), kind: kind === "ocr" ? "ocr" : "vision", role: "mmproj", sizeBytes: sizeOf(mm) || null, sha256: shaOf(mm), tentative: false });
  }
  const plan = finish(ref.raw, `${name} ${picked.quant ?? ""}`.trim(), "huggingface", ref.repo, ref.revision, files, warnings, info);
  plan.alternatives = cands.filter((c) => c.path !== picked.path).map((c) => ({ label: `${quantFromName(c.path) ?? path.posix.basename(c.path)} · ${fmtBytes(c.size)}`, repoPath: c.path, sizeBytes: c.size }));
  return plan;
}

// ------------------------------------------------------- url / civitai ---

async function planFromUrl(ref: Extract<ParsedRef, { provider: "url" }>, _ctx: ResolveContext): Promise<DownloadPlan> {
  const g = guessFromName(ref.filename);
  let size: number | null = null;
  try { const h = await fetch(ref.url, { method: "HEAD", redirect: "follow" }); size = Number(h.headers.get("content-length")) || null; } catch { /* unknown */ }
  const warnings = g.kind ? [] : ["Tipo não reconhecido pelo nome; será classificado pelo conteúdo após o download."];
  return { ref: ref.raw, title: ref.filename, provider: "url", files: [{ url: ref.url, filename: ref.filename, kind: g.kind ?? "text", role: g.role, sizeBytes: size, sha256: null, tentative: true }], totalBytes: size, warnings };
}

async function planFromCivitai(ref: Extract<ParsedRef, { provider: "civitai" }>, _ctx: ResolveContext): Promise<DownloadPlan> {
  const token = process.env.CIVITAI_TOKEN;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  let versionId = ref.versionId;
  let modelName = "";
  let modelType = "";
  if (!versionId && ref.modelId) {
    const m = (await fetch(`https://civitai.com/api/v1/models/${ref.modelId}`, { headers }).then((r) => r.json())) as { name?: string; type?: string; modelVersions?: { id: number }[] };
    versionId = m.modelVersions?.[0]?.id ?? null; modelName = m.name ?? ""; modelType = m.type ?? "";
  }
  if (!versionId) throw new Error("CivitAI: versão do modelo não encontrada.");
  const v = (await fetch(`https://civitai.com/api/v1/model-versions/${versionId}`, { headers }).then((r) => r.json())) as { name?: string; model?: { name?: string; type?: string }; files?: { name: string; sizeKB: number; primary?: boolean; downloadUrl: string; hashes?: { SHA256?: string }; metadata?: { format?: string } }[] };
  modelName ||= v.model?.name ?? "civitai"; modelType ||= v.model?.type ?? "";
  const file = (v.files ?? []).find((f) => f.primary) ?? (v.files ?? [])[0];
  if (!file) throw new Error("CivitAI: versão sem arquivos.");
  const role: FileRole = /lora|lycoris|dora/i.test(modelType) ? "lora" : /vae/i.test(modelType) ? "vae" : /controlnet/i.test(modelType) ? "controlnet" : /upscaler/i.test(modelType) ? "upscaler" : "main";
  const warnings = token ? [] : ["Muitos downloads do CivitAI exigem login: defina CIVITAI_TOKEN nas configurações se falhar."];
  return { ref: ref.raw, title: `${modelName} · ${v.name ?? ""}`.trim(), provider: "civitai", files: [{ url: file.downloadUrl, filename: file.name, kind: "image", role, sizeBytes: Math.round(file.sizeKB * 1024) || null, sha256: file.hashes?.SHA256?.toLowerCase() ?? null, tentative: true }], totalBytes: Math.round(file.sizeKB * 1024) || null, warnings };
}

// ------------------------------------------------------------- helpers ---

function finish(ref: string, title: string, provider: DownloadPlan["provider"], repo: string, revision: string, files: PlannedFile[], warnings: string[], info: HfModelInfo | null): DownloadPlan {
  const total = files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0);
  return { ref, title, provider, repo, revision, files, totalBytes: total || null, warnings, license: info?.cardData?.license, gated: !!info?.gated };
}

function statusRank(r: Recipe): number { return { verified: 0, community: 1, draft: 2, planned: 3 }[r.status] ?? 4; }

const TRUSTED = ["ggml-org", "leejet", "city96", "unsloth", "bartowski", "qwen", "microsoft", "google", "mradermacher", "lmstudio-community", "second-state", "gpustack"];
function trustRank(repoId: string): number { const org = repoId.split("/")[0]!.toLowerCase(); const i = TRUSTED.indexOf(org); return i < 0 ? TRUSTED.length : i; }

function kindFromInfo(info: HfModelInfo | null, repo: string): ModelKind | null {
  const p = info?.pipeline_tag ?? "";
  const name = repo.toLowerCase();
  if (/ocr/.test(name)) return "ocr";
  if (p === "text-to-image" || p === "image-to-image") return "image";
  if (p === "text-to-video" || p === "image-to-video") return "video";
  if (p === "automatic-speech-recognition") return "speech";
  if (p === "text-to-speech" || p === "text-to-audio") return /music|audio/.test(name) && !/tts/.test(name) ? "music" : "tts";
  if (p === "feature-extraction" || p === "sentence-similarity") return /rerank/.test(name) ? "rerank" : "embeddings";
  if (p === "image-text-to-text") return "text";
  if (p === "text-generation") return "text";
  if ((info?.tags ?? []).includes("diffusers")) return "image";
  return null;
}

function scoreCheckpointName(p: string): number {
  const n = p.toLowerCase();
  let s = 0;
  if (/-opt\b|opt\.safetensors/.test(n)) s += 3;
  if (/fp16|pruned/.test(n)) s += 1;
  if (/inpaint|refiner|vae\b|lora|0\.9vae|controlnet/.test(n)) s -= 5;
  if (/\.ckpt$/.test(n)) s -= 1;
  return s;
}
function scoreMmproj(p: string): number { const n = p.toLowerCase(); return /q8_0/.test(n) ? 3 : /f16/.test(n) ? 2 : /bf16/.test(n) ? 1 : 0; }

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "?";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export { refLabel, HfError };
