import type { Paths } from "./paths.js";
import type { StudioConfig } from "./config.js";
import { JobManager } from "./jobs.js";

/** Everything a route or engine needs, passed explicitly (no globals). */
export interface StudioContext {
  paths: Paths;
  config: StudioConfig;
  jobs: JobManager;
  startedAt: number;
  version: string;
}

export function createContext(paths: Paths, config: StudioConfig, version: string): StudioContext {
  return {
    paths,
    config,
    version,
    startedAt: Date.now(),
    jobs: new JobManager({ download: config.downloads.parallelFiles, ingest: 1, generate: 1, ocr: 1 }),
  };
}
