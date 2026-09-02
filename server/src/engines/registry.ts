import type { EngineAdapter, EngineId, EngineInstance, LaunchOptions } from "./types.js";
import type { ModelKind } from "../core/paths.js";

/**
 * SKELETON — ENG-02 (supervisor) fills the launch/idle/VRAM logic; adapters register themselves here.
 * Keep this file tiny: it is the seam every other module imports.
 */
export class EngineRegistry {
  private adapters = new Map<EngineId, EngineAdapter>();
  private instances = new Map<string, EngineInstance>();

  register(a: EngineAdapter): void { this.adapters.set(a.id, a); }
  get(id: EngineId): EngineAdapter | undefined { return this.adapters.get(id); }
  list(): EngineAdapter[] { return [...this.adapters.values()]; }
  forKind(kind: ModelKind): EngineAdapter[] { return this.list().filter((a) => a.capabilities.kinds.includes(kind)); }

  running(): EngineInstance[] { return [...this.instances.values()]; }
  instance(id: string): EngineInstance | undefined { return this.instances.get(id); }

  /**
   * ENG-02: ensure an instance exists for (engine, model). Responsibilities:
   *  - ask the VRAM planner (ENG-03) whether it fits; stop idle/least-recent instances if not
   *  - call adapter.launch(); publish "engine.status" on the bus at every transition
   *  - idle unload after config.engines.idleUnloadMinutes
   */
  async ensure(_engine: EngineId, _opts: LaunchOptions): Promise<EngineInstance> {
    throw new Error("ENG-02 (supervisor) ainda não implementado. Veja docs/SPRINTS.md.");
  }

  async stopAll(): Promise<void> {
    for (const inst of this.instances.values()) { await this.adapters.get(inst.engine)?.stop(inst).catch(() => {}); }
    this.instances.clear();
  }
}
