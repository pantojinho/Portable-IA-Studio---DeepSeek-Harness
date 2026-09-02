import type { EngineAdapter, EngineId, EngineInstance } from "./types.js";
import type { ModelKind } from "../core/paths.js";

/** Adapters + live instances. Tiny on purpose: it is the seam every module imports. Launch logic lives in supervisor.ts. */
export class EngineRegistry {
  private adapters = new Map<EngineId, EngineAdapter>();
  private instances = new Map<string, EngineInstance>();

  register(a: EngineAdapter): void { this.adapters.set(a.id, a); }
  get(id: EngineId): EngineAdapter | undefined { return this.adapters.get(id); }
  list(): EngineAdapter[] { return [...this.adapters.values()]; }
  forKind(kind: ModelKind): EngineAdapter[] { return this.list().filter((a) => a.capabilities.kinds.includes(kind)); }

  running(): EngineInstance[] { return [...this.instances.values()]; }
  instance(id: string): EngineInstance | undefined { return this.instances.get(id); }
  track(inst: EngineInstance): void { this.instances.set(inst.id, inst); }
  forget(id: string): void { this.instances.delete(id); }
}
