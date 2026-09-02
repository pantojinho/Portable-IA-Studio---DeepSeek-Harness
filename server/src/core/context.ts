import type { Paths } from "./paths.js";
import type { StudioConfig } from "./config.js";
import { JobManager } from "./jobs.js";
import type { ModelService } from "../models/service.js";
import type { EngineService } from "../engines/service.js";
import type { Providers } from "./providers.js";

/** Everything a route, command or engine needs, passed explicitly (no globals). */
export interface StudioContext {
  paths: Paths;
  config: StudioConfig;
  jobs: JobManager;
  startedAt: number;
  version: string;
  models: ModelService;
  engines: EngineService;
  providers: Providers;
}

export async function createContext(paths: Paths, config: StudioConfig, version: string): Promise<StudioContext> {
  const ctx = {
    paths, config, version, startedAt: Date.now(),
    jobs: new JobManager({ download: config.downloads.parallelFiles, ingest: 1, generate: 1, ocr: 1 }),
  } as StudioContext;
  const [{ ModelService }, { EngineService }, { Providers }] = await Promise.all([import("../models/service.js"), import("../engines/service.js"), import("./providers.js")]);
  ctx.models = new ModelService(ctx);
  ctx.providers = new Providers(ctx);
  ctx.engines = new EngineService(ctx);
  return ctx;
}
