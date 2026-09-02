import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StudioContext } from "../core/context.js";
import type { JobContext } from "../core/jobs.js";
import { logger } from "../core/log.js";
import type { Connector } from "./types.js";
import { ImapClient, buildCriteria } from "./imap.js";
import { parseEml } from "./extract/text.js";

const log = logger("connectors");

/**
 * DOC-08. Connectors bring documents in. Two are real: `folder` (watch a directory) and `imap`
 * (read-only mailbox). `sap-odata` is a contract plus a mock, so the shape is agreed before anyone
 * builds it. Secrets never touch the connector file — they live in data/secrets/connector_<id>.
 */
export interface ConnectorRun { fetched: number; skipped: number; sources: string[]; note?: string }

export class ConnectorStore {
  constructor(private ctx: StudioContext) {}

  private file(projectId: string): string { return path.join(this.ctx.projects.dir(projectId), "connectors.json"); }

  list(projectId: string): Connector[] {
    try { return JSON.parse(fs.readFileSync(this.file(projectId), "utf8")) as Connector[]; } catch { return []; }
  }

  get(projectId: string, id: string): Connector | undefined { return this.list(projectId).find((c) => c.id === id); }

  save(projectId: string, input: Partial<Connector> & { type: Connector["type"]; config: Record<string, unknown> }): Connector {
    this.ctx.projects.require(projectId);
    const all = this.list(projectId);
    const { password, ...config } = input.config as { password?: string } & Record<string, unknown>;
    const connector: Connector = {
      id: input.id ?? randomUUID().slice(0, 8),
      type: input.type,
      projectId,
      config,
      enabled: input.enabled ?? true,
      lastSyncAt: input.lastSyncAt,
    };
    if (typeof password === "string" && password) this.setSecret(connector.id, password);
    const i = all.findIndex((c) => c.id === connector.id);
    if (i >= 0) all[i] = connector; else all.push(connector);
    fs.writeFileSync(this.file(projectId), JSON.stringify(all, null, 2));
    if (connector.type === "folder" && connector.enabled) {
      const folders = [...new Set([...(this.ctx.projects.require(projectId).watch ?? []), String(connector.config.path ?? "")].filter(Boolean))];
      this.ctx.projects.update(projectId, { watch: folders });
      this.ctx.projects.watch(projectId);
    }
    return connector;
  }

  delete(projectId: string, id: string): boolean {
    const all = this.list(projectId);
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    fs.writeFileSync(this.file(projectId), JSON.stringify(next, null, 2));
    try { fs.unlinkSync(this.secretPath(id)); } catch { /* sem segredo guardado */ }
    return true;
  }

  private secretPath(id: string): string { return path.join(this.ctx.paths.secrets, `connector_${id}`); }
  private setSecret(id: string, value: string): void {
    fs.mkdirSync(this.ctx.paths.secrets, { recursive: true });
    fs.writeFileSync(this.secretPath(id), value, { mode: 0o600 });
  }
  secret(id: string): string | null {
    try { return fs.readFileSync(this.secretPath(id), "utf8").trim() || null; } catch { return null; }
  }

  /** Fetch what is new and hand it to the ingester. */
  async sync(projectId: string, id: string, job?: JobContext): Promise<ConnectorRun> {
    const connector = this.get(projectId, id);
    if (!connector) throw new Error(`conector '${id}' não existe neste projeto`);
    if (connector.type === "folder") return this.syncFolder(projectId, connector, job);
    if (connector.type === "imap") return this.syncImap(projectId, connector, job);
    if (connector.type === "sap-odata") {
      throw new Error("o conector SAP/OData ainda é só contrato (DOC-08): use a pasta monitorada exportando os arquivos do SAP.");
    }
    throw new Error(`tipo de conector '${connector.type}' não implementado`);
  }

  private async syncFolder(projectId: string, connector: Connector, job?: JobContext): Promise<ConnectorRun> {
    const folder = String(connector.config.path ?? "");
    if (!folder || !fs.existsSync(folder)) throw new Error(`a pasta '${folder}' não existe`);
    const pattern = connector.config.pattern ? new RegExp(String(connector.config.pattern), "i") : null;
    const files = fs.readdirSync(folder)
      .map((n) => path.join(folder, n))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
      .filter((p) => !pattern || pattern.test(path.basename(p)));
    job?.setMessage(`${files.length} arquivo(s) na pasta`);
    const before = this.ctx.projects.sources(projectId).length;
    const r = await this.ctx.projects.addSourceFiles(projectId, files, { ingest: true });
    this.touch(projectId, connector.id);
    return { fetched: r.sources.length, skipped: Math.max(0, files.length - (this.ctx.projects.sources(projectId).length - before)), sources: r.sources.map((s) => s.name) };
  }

  private async syncImap(projectId: string, connector: Connector, job?: JobContext): Promise<ConnectorRun> {
    const cfg = connector.config as { host?: string; port?: number; user?: string; mailbox?: string; since?: string; from?: string; subject?: string; unseenOnly?: boolean; limit?: number; attachmentsOnly?: boolean; tls?: boolean };
    const password = this.secret(connector.id);
    if (!cfg.host || !cfg.user || !password) throw new Error("faltam host, user ou senha no conector IMAP");
    const client = new ImapClient({ host: cfg.host, port: cfg.port, user: cfg.user, password, mailbox: cfg.mailbox, tls: cfg.tls });
    const dir = this.ctx.projects.sourcesDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    let skipped = 0;
    try {
      job?.setMessage(`conectando em ${cfg.host}`);
      await client.connect();
      await client.login();
      await client.examine(cfg.mailbox ?? "INBOX");
      const criteria = buildCriteria({ since: cfg.since ?? connector.lastSyncAt ?? null, from: cfg.from ?? null, subject: cfg.subject ?? null, unseenOnly: cfg.unseenOnly });
      const uids = await client.search(criteria);
      const limit = Math.min(uids.length, cfg.limit ?? 50);
      job?.setMessage(`${uids.length} mensagem(ns); trazendo ${limit}`);
      for (let i = 0; i < limit; i++) {
        if (job?.signal.aborted) throw new Error("cancelled");
        const uid = uids[uids.length - limit + i]!;      // as mais recentes primeiro
        const msg = await client.fetchMessage(uid);
        if (!msg) { skipped++; continue; }
        const mail = parseEml(msg.raw);
        const stem = `${cfg.user.replace(/[^\w.-]/g, "_")}-${uid}`;
        const eml = path.join(dir, `${stem}.eml`);
        if (!cfg.attachmentsOnly) { fs.writeFileSync(eml, msg.raw); written.push(eml); }
        for (const att of mail.attachments) {
          const safe = path.basename(att.filename).replace(/[^\w.\- ]/g, "_") || "anexo";
          const file = path.join(dir, `${stem}-${safe}`);
          fs.writeFileSync(file, att.content);
          written.push(file);
        }
        job?.setProgress((i + 1) / limit, `${i + 1}/${limit} ${mail.subject.slice(0, 40)}`);
      }
      await client.logout();
    } finally { client.close(); }

    const registered = written.map((f) => this.ctx.projects.register(projectId, f));
    const ids = [...new Set(registered.map((s) => s.id))];
    if (ids.length) this.ctx.projects.ingest(projectId, { sourceIds: ids });
    this.touch(projectId, connector.id);
    log.info(`imap ${cfg.user}: ${written.length} arquivo(s) novos`);
    return { fetched: written.length, skipped, sources: written.map((f) => path.basename(f)), note: "a leitura roda como trabalho; acompanhe em Trabalhos" };
  }

  private touch(projectId: string, id: string): void {
    const connector = this.get(projectId, id);
    if (!connector) return;
    this.save(projectId, { ...connector, lastSyncAt: new Date().toISOString(), config: connector.config });
  }
}
