import fs from "node:fs";
import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import { logger } from "../core/log.js";
import type { SourceFile, ValidationResult } from "./types.js";

const log = logger("fields");

export interface FieldsResult {
  sourceId: string;
  name: string;
  docType: string | null;
  fields: Record<string, unknown>;
  validation: ValidationResult | null;
  error?: string;
}

/**
 * DOC-07 applied to a project: classify each document, pull the fields its type asks for, validate,
 * and store both on the source so the report and the cross-check can use them later.
 */
export async function extractFieldsForSources(
  ctx: StudioContext, projectId: string,
  o: { sourceIds?: string[]; docType?: string; model?: string; force?: boolean; job?: JobContext } = {},
): Promise<{ results: FieldsResult[]; ok: number; withIssues: number; failed: number }> {
  ctx.projects.require(projectId);
  const all = ctx.projects.sources(projectId).filter((s) => s.status === "done");
  const targets = o.sourceIds?.length ? all.filter((s) => o.sourceIds!.includes(s.id)) : (o.force ? all : all.filter((s) => !s.fields));
  const results: FieldsResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    const source = targets[i]!;
    if (o.job?.signal.aborted) throw new Error("cancelled");
    o.job?.setProgress(i / Math.max(1, targets.length), `${i + 1}/${targets.length} ${source.name}`);
    try {
      const text = readMarkdown(source);
      if (!text.trim()) { results.push({ sourceId: source.id, name: source.name, docType: null, fields: {}, validation: null, error: "documento sem texto extraído" }); continue; }
      const typeId = o.docType ?? source.docType ?? await ctx.doctypes.classify(text, { model: o.model, signal: o.job?.signal });
      const docType = typeId ? ctx.doctypes.get(typeId) : undefined;
      if (!docType) {
        results.push({ sourceId: source.id, name: source.name, docType: null, fields: {}, validation: null, error: "não consegui identificar o tipo do documento" });
        continue;
      }
      const { fields, validation } = await ctx.doctypes.extract(text, docType, { model: o.model, signal: o.job?.signal });
      ctx.projects.updateSource(projectId, source.id, { docType: docType.id, fields, validation });
      results.push({ sourceId: source.id, name: source.name, docType: docType.id, fields, validation });
    } catch (e) {
      const message = (e as Error).message;
      if (message === "cancelled") throw e;
      log.warn(`${source.name}: ${message}`);
      results.push({ sourceId: source.id, name: source.name, docType: null, fields: {}, validation: null, error: message });
    }
  }
  return {
    results,
    ok: results.filter((r) => r.validation?.ok).length,
    withIssues: results.filter((r) => r.validation && !r.validation.ok).length,
    failed: results.filter((r) => r.error).length,
  };
}

/** Re-run only the checks (cheap, no model) over what is already extracted. */
export function validateSources(ctx: StudioContext, projectId: string, sourceIds?: string[]): FieldsResult[] {
  const sources = ctx.projects.sources(projectId).filter((s) => s.fields && (!sourceIds?.length || sourceIds.includes(s.id)));
  return sources.map((s) => {
    const docType = s.docType ? ctx.doctypes.get(s.docType) : undefined;
    if (!docType) return { sourceId: s.id, name: s.name, docType: s.docType ?? null, fields: s.fields!, validation: null, error: "sem tipo de documento" };
    const validation = ctx.doctypes.validate(s.fields!, docType);
    ctx.projects.updateSource(projectId, s.id, { validation });
    return { sourceId: s.id, name: s.name, docType: docType.id, fields: s.fields!, validation };
  });
}

function readMarkdown(source: SourceFile): string {
  if (source.derived.markdown && fs.existsSync(source.derived.markdown)) return fs.readFileSync(source.derived.markdown, "utf8");
  return "";
}
