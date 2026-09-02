import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ModelKind } from "../core/paths.js";
import type { FileRole } from "./types.js";

/**
 * A recipe describes everything needed to run one model end-to-end:
 * which files (possibly from several repos), where they go, and how the
 * engine is invoked. Recipes are data (YAML), so adding a model family never
 * requires code. `models/recipes/builtin.yaml` ships with the app; users can
 * drop extra `*.yaml` files next to it.
 */
export type RecipeStatus = "verified" | "community" | "draft" | "planned";

export interface RecipeFileFrom {
  /** direct download (voice packs on GitHub releases); mutually exclusive with `repo` */
  url?: string;
  sizeBytes?: number;
  sha256?: string;
  repo?: string;
  revision?: string;
  /** exact path in the repo */
  path?: string;
  /** glob over repo paths ("split_files/vae/*.safetensors") */
  glob?: string;
  /** pattern with {quant}; combined with `prefer` list, first existing + fitting wins */
  pattern?: string;
  prefer?: string[];
  /** alternative sources tried in order if the first is gated/missing */
  alternatives?: RecipeFileFrom[];
}

export interface RecipeFile {
  role: FileRole;
  /** logical name used in engineArgs placeholders, e.g. "diffusion", "vae", "clip_l" */
  slot: string;
  from: RecipeFileFrom;
  /** models/<kind>/<subdir>; defaults to the recipe kind */
  kind?: ModelKind;
  subdir?: string;
  optional?: boolean;
  /** rename on disk (default: basename of repo path) */
  filename?: string;
  /** MOD-08: the download is an archive; unpack it into models/<kind>/<subdir>/<name>/ */
  extract?: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  kind: ModelKind;
  engine: string;              // "llamacpp" | "sdcpp" | "whispercpp" | "onnx-tts" | "python:<pkg>"
  family?: string;             // "flux1" | "flux2" | "z-image" | "sd3" | "sdxl" | …
  status: RecipeStatus;
  description?: string;
  tags?: string[];
  license?: string;
  gated?: boolean;
  nonCommercial?: boolean;
  minVramMiB?: number;
  minRamMiB?: number;
  match?: { repos?: string[]; archs?: string[] };
  files: RecipeFile[];
  engineArgs?: Record<string, string[]>;
  defaults?: Record<string, unknown>;
  notes?: string[];
  /** upstream references (issue links, docs) so the next person knows where this came from */
  sources?: string[];
}

export class RecipeStore {
  private recipes = new Map<string, Recipe>();
  private byRepo = new Map<string, string[]>();

  constructor(private dirs: string[]) { this.reload(); }

  reload(): void {
    this.recipes.clear(); this.byRepo.clear();
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
        const doc = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { recipes?: Recipe[] } | Recipe[] | null;
        const list = Array.isArray(doc) ? doc : doc?.recipes ?? [];
        for (const r of list) this.add(r);
      }
    }
  }

  private add(r: Recipe): void {
    if (!r.id || !r.files) return;
    r.status ??= "draft";
    this.recipes.set(r.id, r);
    for (const repo of r.match?.repos ?? []) {
      const key = repo.toLowerCase();
      this.byRepo.set(key, [...(this.byRepo.get(key) ?? []), r.id]);
    }
  }

  list(): Recipe[] { return [...this.recipes.values()]; }
  get(id: string): Recipe | undefined { return this.recipes.get(id); }
  forRepo(repo: string): Recipe[] { return (this.byRepo.get(repo.toLowerCase()) ?? []).map((id) => this.recipes.get(id)!).filter(Boolean); }
  forArch(arch: string): Recipe[] { return this.list().filter((r) => r.match?.archs?.includes(arch)); }
}

/** Where a recipe file lands on disk. */
export function recipeFileDest(recipe: Recipe, file: RecipeFile, repoPath: string): { kind: ModelKind; subdir: string | undefined; filename: string } {
  const kind = file.kind ?? recipe.kind;
  const filename = file.filename ?? path.posix.basename(repoPath);
  return { kind, subdir: file.subdir, filename };
}
