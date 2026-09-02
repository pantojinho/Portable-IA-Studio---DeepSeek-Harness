/**
 * CONTRACT — projects & documents (OCR, RAG, memory, extraction). Tasks DOC-01…DOC-10.
 * One project = one folder under projects/<id>/ with sources/, derived/, index.sqlite, memory.md, chats/.
 */
export interface Project {
  id: string;                        // slug
  name: string;
  createdAt: string;
  updatedAt: string;
  /** folders watched for new/changed files (DOC-08) */
  watch: string[];
  settings: {
    embeddingModel: string | null;   // registry id
    rerankModel: string | null;
    ocrModel: string | null;
    chunkTokens: number;             // default 400
    chunkOverlap: number;            // default 60
    language: string;                // "pt-BR"
  };
  stats: { sources: number; chunks: number; lastIngestAt: string | null };
}

export type SourceStatus = "queued" | "extracting" | "ocr" | "chunking" | "embedding" | "done" | "failed" | "skipped";

export interface SourceFile {
  id: string;
  projectId: string;
  path: string;                      // projects/<id>/sources/<file>
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  addedAt: string;
  status: SourceStatus;
  error?: string;
  pages?: number;
  /** derived artifacts: markdown text, OCR json, transcript */
  derived: { markdown?: string; ocrJson?: string; transcript?: string };
  /** classification (DOC-07): "nfe", "recibo", "contrato", … */
  docType?: string;
  /** extracted fields (DOC-07) */
  fields?: Record<string, unknown>;
  validation?: ValidationResult;
}

export interface Chunk {
  id: string;
  sourceId: string;
  ordinal: number;
  text: string;
  /** where it came from, for citations */
  locator: { page?: number; heading?: string; start?: number; end?: number; sheet?: string; timestamp?: number };
  tokens: number;
  /** stored in sqlite-vec as float32[dim] */
  embedding?: Float32Array;
}

export interface SearchQuery { projectId: string; query: string; k?: number; hybrid?: boolean; rerank?: boolean; filters?: { sourceIds?: string[]; docType?: string } }
export interface SearchHit { chunk: Chunk; score: number; source: Pick<SourceFile, "id" | "name" | "path" | "docType">; snippet: string }

export interface Answer {
  text: string;
  citations: { sourceId: string; name: string; page?: number; quote: string }[];
  model: string;
  usedChunks: number;
}

/** Document types are data (documents/doctypes/*.yaml): a JSON schema plus validators to run. */
export interface DocType {
  id: string;                        // "nfe", "nfse", "recibo", "boleto", "contrato", "fatura"
  name: string;
  description: string;
  /** keywords/regex that hint this type (used before the LLM classifier) */
  hints: string[];
  schema: Record<string, unknown>;   // JSON Schema for extraction
  validators: string[];              // ids from documents/validators.ts
  /** columns to compare with an imported table (DOC-07 cross-check) */
  crossCheck?: { key: string[]; compare: string[] };
}

export interface ValidationIssue { code: string; severity: "error" | "warning" | "info"; message: string; field?: string }
export interface ValidationResult { ok: boolean; issues: ValidationIssue[]; checkedAt: string }

export interface MemoryEntry { id: string; projectId: string; text: string; kind: "fact" | "glossary" | "summary" | "user"; sourceId?: string; createdAt: string; pinned: boolean }

/** Connectors bring files in (DOC-08). Implementations: folder (watch), imap, later sap/odata, gdrive. */
export interface Connector {
  id: string;
  type: "folder" | "imap" | "sap-odata" | "gdrive" | (string & {});
  projectId: string;
  config: Record<string, unknown>;   // secrets live in data/secrets/<connector id>
  enabled: boolean;
  lastSyncAt?: string;
}
