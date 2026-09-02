import { EventEmitter } from "node:events";

/** One process-wide bus. Topics are dotted strings ("job.progress", "download.state", "engine.status"). */
export interface StudioEvent<T = unknown> {
  topic: string;
  at: number;
  data: T;
}

class Bus extends EventEmitter {
  publish<T>(topic: string, data: T): void {
    const ev: StudioEvent<T> = { topic, at: Date.now(), data };
    this.emit(topic, ev);
    this.emit("*", ev);
  }
  subscribe(topic: string, fn: (ev: StudioEvent) => void): () => void {
    this.on(topic, fn);
    return () => this.off(topic, fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(200);
