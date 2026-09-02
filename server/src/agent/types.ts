/**
 * CONTRACT — embedded DeepSeek Harness (dsh). Tasks AGT-01…AGT-05.
 * The Studio never re-implements the agent; it installs a pinned dsh under agent/, writes its
 * settings.yaml (provider "local" → the Studio's own /v1), supervises `dsh web`, and exposes the
 * Studio's capabilities to it through the MCP server at /mcp.
 */
export interface AgentConfig {
  dshVersion: string;                // pinned, e.g. "0.1.1-rc.2"
  home: string;                      // agent/ (DSH_HOME)
  port: number;                      // 3080 default
  workspace: string | null;          // default workspace folder for sessions
  providers: {
    local: { baseURL: string; model: string };          // Studio /v1
    cloud?: Record<string, { api: string; baseURL?: string; apiKeyRef: string; models: string[] }>;
  };
  mcpServers: Record<string, { url: string } | { command: string; args: string[] }>;
}

export type AgentStatus = "not-installed" | "installing" | "stopped" | "starting" | "ready" | "error";

export interface AgentState {
  status: AgentStatus;
  pid: number | null;
  url: string | null;                // http://127.0.0.1:3080
  version: string | null;
  error?: string;
}

/** One-shot automation (AGT-05): `dsh --profile headless "<task>"`. */
export interface AgentRunRequest { task: string; workspace?: string; model?: string; timeoutSec?: number }
export interface AgentRunResult { ok: boolean; output: string; sessionId?: string; durationMs: number }
