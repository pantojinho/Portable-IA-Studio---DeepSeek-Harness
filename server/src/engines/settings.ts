import fs from "node:fs";
import path from "node:path";
import type { Paths } from "../core/paths.js";
import { logger } from "../core/log.js";

const log = logger("engines");

/**
 * ENG-12. Per-model launch settings (context, GPU layers, threads, KV cache…), kept in
 * data/model-settings.json — the same idea as the ULS `llm-model-settings.json`, so a model the user
 * tuned once keeps its knobs across restarts. Unknown keys are preserved: adapters read what they know.
 */
export type ModelSettings = Record<string, unknown>;

export class ModelSettingsStore {
  private cache: Record<string, ModelSettings> | null = null;

  constructor(private paths: Paths) {}

  private file(): string { return path.join(this.paths.data, "model-settings.json"); }

  all(): Record<string, ModelSettings> {
    if (!this.cache) {
      try { this.cache = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Record<string, ModelSettings>; }
      catch { this.cache = {}; }
    }
    return this.cache;
  }

  get(modelId: string): ModelSettings { return this.all()[modelId] ?? {}; }

  /** Merge (so the UI can send one field) and drop nulls, which mean "back to the default". */
  set(modelId: string, patch: ModelSettings): ModelSettings {
    const merged = { ...this.get(modelId), ...patch };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    const all = this.all();
    if (Object.keys(merged).length) all[modelId] = merged; else delete all[modelId];
    this.save();
    log.info(`configurações de ${modelId}: ${Object.keys(patch).join(", ") || "limpas"}`);
    return merged;
  }

  clear(modelId: string): void {
    const all = this.all();
    delete all[modelId];
    this.save();
  }

  private save(): void {
    fs.mkdirSync(this.paths.data, { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(this.all(), null, 2));
  }
}
