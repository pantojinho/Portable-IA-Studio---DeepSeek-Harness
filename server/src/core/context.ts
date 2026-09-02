import type { Paths } from "./paths.js";
import type { StudioConfig } from "./config.js";
import { JobManager } from "./jobs.js";
import type { ModelService } from "../models/service.js";

/** Everything a route, command or engine needs, passed explicitly (no globals). */
export interface StudioContext {
  paths: Paths;
  config: StudioConfig;
  jobs: JobManager;
  startedAt: number;
  version: string;
  models: ModelService;
}

export async function createContext(paths: Paths, config: StudioConfig, version: string): Promise<StudioContext> {
  const ctx = {
    paths, config, version, startedAt: Date.now(),
    jobs: new JobManager({ download: config.downloads.parallelFiles, ingest: 1, generate: 1, ocr: 1 }),
  } as StudioContext;
  const { ModelService } = await import("../models/service.js");
  ctx.models = new ModelService(ctx);
  return ctx;
}
