import type { StudioContext } from "../core/context.js";

/** CLI surface for the model manager. Filled in during phase 1. */
export async function modelsCmd(ctx: StudioContext, rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0] ?? "list";
  switch (sub) {
    case "list":
      console.log(`Modelos em ${ctx.paths.models} — gerenciador chega na fase 1.`);
      return;
    default:
      console.error(`Subcomando desconhecido: models ${sub}`);
      process.exitCode = 1;
  }
}
