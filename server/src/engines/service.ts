import type { StudioContext } from "../core/context.js";
import type { ModelKind } from "../core/paths.js";
import { recommendBackend, type Backend } from "../core/system.js";
import type { ModelRecord } from "../models/types.js";
import { defaultMigrationSources } from "../models/registry.js";
import { EngineInstaller } from "./installer.js";
import { EngineRegistry } from "./registry.js";
import { Supervisor } from "./supervisor.js";
import { LlamaCppAdapter } from "./llamacpp.js";
import { SdCppAdapter } from "./sdcpp.js";
import { WhisperCppAdapter } from "./whispercpp.js";
import type { EngineId, EngineInstance, EngineInstall } from "./types.js";
import { logger } from "../core/log.js";

const log = logger("engines");
const ENGINE_IDS: EngineId[] = ["llamacpp", "sdcpp", "whispercpp"];

/** Facade: which engines exist, which are installed, start a model, list instances. */
export class EngineService {
  readonly installer: EngineInstaller;
  readonly registry = new EngineRegistry();
  readonly supervisor: Supervisor;
  private backend: Backend | null = null;

  constructor(private ctx: StudioContext) {
    this.installer = new EngineInstaller(ctx.paths);
    this.supervisor = new Supervisor(ctx, this.registry);
    this.registry.register(new LlamaCppAdapter(ctx, this.installer, () => this.supervisor));
    this.registry.register(new SdCppAdapter(ctx, this.installer));
    this.registry.register(new WhisperCppAdapter(ctx, this.installer));
  }

  async preferredBackend(): Promise<Backend> {
    const cfg = this.ctx.config.engines.preferredBackend;
    if (cfg !== "auto") return cfg;
    if (!this.backend) { const { detectGpus } = await import("../core/system.js"); this.backend = recommendBackend(await detectGpus()); }
    return this.backend;
  }

  status(): { engines: { id: EngineId; installed: EngineInstall[]; registered: boolean }[]; instances: EngineInstance[] } {
    const backends: Backend[] = ["cuda", "rocm", "metal", "vulkan", "cpu"];
    return {
      engines: ENGINE_IDS.map((id) => ({ id, registered: !!this.registry.get(id), installed: backends.map((b) => this.installer.installed(id, b)).filter((x): x is EngineInstall => !!x) })),
      instances: this.registry.running(),
    };
  }

  /** Adopt every ULS binary we can find (free), then report what is still missing. */
  adoptAll(): { adopted: EngineInstall[]; missing: string[] } {
    const roots = defaultMigrationSources(this.ctx.paths);
    const adopted: EngineInstall[] = []; const missing: string[] = [];
    for (const id of ENGINE_IDS) for (const b of ["cuda", "rocm", "vulkan", "metal", "cpu"] as Backend[]) {
      if (this.installer.installed(id, b)) continue;
      const r = this.installer.adoptFromUls(id, b, roots);
      if (r) adopted.push(r); else missing.push(`${id}/${b}`);
    }
    return { adopted, missing };
  }

  /** Ensure an engine exists for `backend` (adopt → install job) and return the install. */
  async ensureInstalled(engine: EngineId, backend?: Backend): Promise<EngineInstall> {
    const b = backend ?? (await this.preferredBackend());
    const have = this.installer.installed(engine, b) ?? this.installer.installedAny(engine, b);
    if (have) return have;
    const adopted = this.installer.adoptFromUls(engine, b, defaultMigrationSources(this.ctx.paths)) ?? (b !== "cpu" ? this.installer.adoptFromUls(engine, "cpu", defaultMigrationSources(this.ctx.paths)) : null);
    if (adopted) return adopted;
    const job = this.ctx.jobs.create("download", `Instalar ${engine} (${b})`, (j) => this.installer.install(engine, b, j).catch(async (e) => {
      if (b === "cpu") throw e;
      log.warn(`${engine}/${b} falhou (${(e as Error).message}); tentando cpu`);
      return this.installer.install(engine, "cpu", j);
    }));
    return new Promise<EngineInstall>((resolve, reject) => {
      const { bus } = require("../core/events.js") as typeof import("../core/events.js");
      const off = bus.subscribe("job", (ev) => {
        const j = ev.data as import("../core/jobs.js").JobInfo;
        if (j.id !== job.id) return;
        if (j.status === "done") { off(); resolve(j.result as EngineInstall); }
        else if (j.status === "failed" || j.status === "cancelled") { off(); reject(new Error(j.error ?? "instalação cancelada")); }
      });
    });
  }

  /** Resolve a model id/filename/recipe id from the library to a record (+ companions). */
  findModel(ref: string, kinds?: ModelKind[]): { model: ModelRecord; companions: ModelRecord[]; recipeArgs?: string[] } | null {
    const reg = this.ctx.models.registry;
    const all = reg.list().filter((m) => !kinds || kinds.includes(m.kind));
    let model = all.find((m) => m.id === ref) ?? all.find((m) => m.filename === ref) ?? all.find((m) => m.filename.toLowerCase().startsWith(ref.toLowerCase()) && m.inspection.role === "main");
    let recipeArgs: string[] | undefined;
    if (!model) {
      const recipe = this.ctx.models.recipes.get(ref);
      if (recipe) {
        model = all.find((m) => m.recipe?.id === recipe.id && (m.inspection.role === "main" || m.inspection.role === "diffusion"));
        if (model) recipeArgs = recipe.engineArgs?.llamacpp;
      }
    }
    if (!model) return null;
    const companions = (model.companions ?? []).map((rel) => reg.list().find((m) => m.path.replace(/\\/g, "/").endsWith(rel))).filter((m): m is ModelRecord => !!m);
    // a vision/OCR model without recorded companions: pick an mmproj sitting next to it
    if (model.inspection.vision && !companions.some((c) => c.inspection.role === "mmproj")) {
      const near = reg.list().find((m) => m.inspection.role === "mmproj" && m.path.startsWith(model!.path.slice(0, model!.path.lastIndexOf(model!.filename))));
      if (near) companions.push(near);
    }
    return { model, companions, recipeArgs };
  }

  /** Start (or reuse) the right engine for a library model. */
  async start(ref: string, settings?: Record<string, unknown>, signal?: AbortSignal): Promise<EngineInstance> {
    const found = this.findModel(ref);
    if (!found) throw new Error(`modelo '${ref}' não está na biblioteca. Baixe com: aistudio models pull <link>`);
    const engine = this.engineFor(found.model.kind);
    const inst = await this.ensureInstalled(engine);
    return this.supervisor.ensure(engine, { model: found.model, companions: found.companions, backend: inst.backend, settings, recipeArgs: found.recipeArgs, signal });
  }

  engineFor(kind: ModelKind): EngineId {
    if (kind === "image" || kind === "video") return "sdcpp";
    if (kind === "speech") return "whispercpp";
    return "llamacpp";
  }
}
