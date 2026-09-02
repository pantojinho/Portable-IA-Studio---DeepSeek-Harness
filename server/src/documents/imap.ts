import net from "node:net";
import tls from "node:tls";
import { logger } from "../core/log.js";

const log = logger("imap");

/**
 * DOC-08. A small, read-only IMAP client: connect, log in, select a mailbox, search and fetch whole
 * messages. Written here instead of pulling `imapflow` because the bundle must stay dependency-free
 * (AGENTS.md §2.3) and because "read-only" is easier to guarantee when we own every command sent —
 * the Studio never marks, moves or deletes anything (BODY.PEEK, never STORE).
 */
export interface ImapOptions {
  host: string;
  port?: number;
  user: string;
  password: string;
  /** false only for tests against a local fake server */
  tls?: boolean;
  mailbox?: string;
  timeoutMs?: number;
}

export interface ImapMessage { uid: number; raw: Buffer }

export class ImapClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private waiting: { tag: string; resolve: (lines: ImapResponse) => void; reject: (e: Error) => void } | null = null;
  private counter = 0;
  private greeting: Promise<void>;
  private greeted!: () => void;

  constructor(private o: ImapOptions) {
    this.greeting = new Promise((r) => { this.greeted = r; });
  }

  async connect(): Promise<void> {
    const port = this.o.port ?? (this.o.tls === false ? 143 : 993);
    this.socket = this.o.tls === false
      ? net.connect({ host: this.o.host, port })
      : tls.connect({ host: this.o.host, port, servername: this.o.host });
    this.socket.setTimeout(this.o.timeoutMs ?? 30_000);
    this.socket.on("data", (d) => this.onData(d));
    this.socket.on("error", (e) => this.fail(e));
    this.socket.on("timeout", () => this.fail(new Error("o servidor não respondeu a tempo")));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once(this.o.tls === false ? "connect" : "secureConnect", () => resolve());
      this.socket!.once("error", reject);
    });
    await this.greeting;
  }

  async login(): Promise<void> {
    await this.command(`LOGIN ${quote(this.o.user)} ${quote(this.o.password)}`);
  }

  /** EXAMINE = SELECT read-only: the server may not change \\Seen flags. */
  async examine(mailbox = this.o.mailbox ?? "INBOX"): Promise<number> {
    const r = await this.command(`EXAMINE ${quote(mailbox)}`);
    const exists = r.untagged.map((l) => /^\*\s+(\d+)\s+EXISTS/i.exec(l)?.[1]).find(Boolean);
    return Number(exists ?? 0);
  }

  /** `criteria` examples: "ALL", "UNSEEN", "SINCE 01-Sep-2026", "FROM fornecedor@x.com". */
  async search(criteria = "ALL"): Promise<number[]> {
    const r = await this.command(`UID SEARCH ${criteria}`);
    const line = r.untagged.find((l) => /^\*\s+SEARCH/i.test(l)) ?? "";
    return line.replace(/^\*\s+SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  }

  async fetchMessage(uid: number): Promise<ImapMessage | null> {
    const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    return r.literals.length ? { uid, raw: r.literals[0]! } : null;
  }

  async logout(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* o servidor pode fechar antes de responder */ }
    this.close();
  }

  close(): void {
    try { this.socket?.destroy(); } catch { /* já fechado */ }
    this.socket = null;
  }

  private command(text: string): Promise<ImapResponse> {
    if (!this.socket) throw new Error("não conectado");
    const tag = `A${String(++this.counter).padStart(3, "0")}`;
    return new Promise<ImapResponse>((resolve, reject) => {
      this.waiting = { tag, resolve, reject };
      this.pending = { tag, untagged: [], literals: [] };
      this.socket!.write(`${tag} ${text}\r\n`);
    });
  }

  private pending: ImapResponse = { tag: "", untagged: [], literals: [] };

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = takeLine(this.buffer);
      if (!parsed) return;
      // a line ending in {n} announces exactly n bytes of raw content
      const literal = /\{(\d+)\}\s*$/.exec(parsed.line);
      if (literal) {
        const size = Number(literal[1]);
        if (this.buffer.length < parsed.rest + size) return;   // espera o corpo inteiro
        const body = this.buffer.subarray(parsed.rest, parsed.rest + size);
        this.pending.literals.push(Buffer.from(body));
        this.pending.untagged.push(parsed.line);
        this.buffer = this.buffer.subarray(parsed.rest + size);
        continue;
      }
      this.buffer = this.buffer.subarray(parsed.rest);
      const line = parsed.line;
      if (/^\*\s+(OK|PREAUTH)/i.test(line) && !this.waiting) { this.greeted(); continue; }
      if (this.waiting && line.startsWith(this.waiting.tag)) {
        const { resolve, reject } = this.waiting;
        this.waiting = null;
        const status = /^\S+\s+(OK|NO|BAD)/i.exec(line)?.[1]?.toUpperCase();
        if (status === "OK") resolve({ ...this.pending, tag: line });
        else reject(new Error(`o servidor recusou: ${line.replace(/^\S+\s+/, "")}`));
        continue;
      }
      this.pending.untagged.push(line);
    }
  }

  private fail(e: Error): void {
    log.warn(`imap: ${e.message}`);
    const w = this.waiting;
    this.waiting = null;
    this.greeted();
    w?.reject(e);
  }
}

export interface ImapResponse { tag: string; untagged: string[]; literals: Buffer[] }

/** Splits the first CRLF-terminated line; returns the offset where the rest starts. */
export function takeLine(buf: Buffer): { line: string; rest: number } | null {
  const idx = buf.indexOf("\r\n");
  if (idx < 0) return null;
  return { line: buf.subarray(0, idx).toString("utf8"), rest: idx + 2 };
}

export function quote(s: string): string { return `"${s.replace(/([\\"])/g, "\\$1")}"`; }

/** "01-Sep-2026" — the only date format IMAP SEARCH accepts. */
export function imapDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

/** Builds the SEARCH criteria from what the connector was configured with. */
export function buildCriteria(o: { since?: string | Date | null; from?: string | null; unseenOnly?: boolean; subject?: string | null }): string {
  const parts: string[] = [];
  if (o.unseenOnly) parts.push("UNSEEN");
  if (o.since) parts.push(`SINCE ${imapDate(typeof o.since === "string" ? new Date(o.since) : o.since)}`);
  if (o.from) parts.push(`FROM ${quote(o.from)}`);
  if (o.subject) parts.push(`SUBJECT ${quote(o.subject)}`);
  return parts.length ? parts.join(" ") : "ALL";
}
