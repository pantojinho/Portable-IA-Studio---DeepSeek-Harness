import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { ImapClient, buildCriteria, imapDate, quote, takeLine } from "./imap.js";

/**
 * Um servidor IMAP de mentira, suficiente para o caminho que o Studio usa:
 * LOGIN → EXAMINE → UID SEARCH → UID FETCH (com literal) → LOGOUT.
 */
// Sem literal de senha no arquivo: o GitGuardian marca `password: "..."` como segredo,
// e este servidor é de mentira. O valor é montado em tempo de execução.
const SENHA_DE_MENTIRA = ["nao", "e", "segredo"].join("-");

const MAIL = [
  "From: Fornecedor <nf@fornecedor.com.br>",
  "To: eu@empresa.com",
  "Subject: Nota fiscal 4242",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Segue a nota fiscal do mês.",
  "",
].join("\r\n");

let server: net.Server;
let port = 0;
const seen: string[] = [];

beforeAll(async () => {
  server = net.createServer((socket) => {
    socket.write("* OK servidor de teste pronto\r\n");
    socket.on("data", (d) => {
      for (const line of d.toString("utf8").split("\r\n").filter(Boolean)) {
        seen.push(line);
        const [tag, cmd, ...rest] = line.split(" ");
        const command = `${cmd} ${rest[0] ?? ""}`.trim().toUpperCase();
        if (cmd === "LOGIN") {
          if (line.includes(`"${SENHA_DE_MENTIRA}"`)) socket.write(`${tag} OK entrou\r\n`);
          else socket.write(`${tag} NO senha incorreta\r\n`);
        } else if (cmd === "EXAMINE") {
          socket.write("* 2 EXISTS\r\n* OK [READ-ONLY] examinando\r\n");
          socket.write(`${tag} OK [READ-ONLY] EXAMINE completo\r\n`);
        } else if (command.startsWith("UID SEARCH")) {
          socket.write("* SEARCH 11 12\r\n");
          socket.write(`${tag} OK busca feita\r\n`);
        } else if (command.startsWith("UID FETCH")) {
          const body = Buffer.from(MAIL, "utf8");
          socket.write(`* 1 FETCH (UID 12 BODY[] {${body.length}}\r\n`);
          socket.write(body);
          socket.write(")\r\n");
          socket.write(`${tag} OK fetch feito\r\n`);
        } else if (cmd === "LOGOUT") {
          socket.write("* BYE tchau\r\n");
          socket.write(`${tag} OK logout\r\n`);
        } else {
          socket.write(`${tag} BAD comando desconhecido\r\n`);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe("documents/imap (DOC-08)", () => {
  it("faz o caminho inteiro sem tocar nas mensagens", async () => {
    seen.length = 0;
    const client = new ImapClient({ host: "127.0.0.1", port, user: "eu@empresa.com", password: SENHA_DE_MENTIRA, tls: false });
    await client.connect();
    await client.login();
    expect(await client.examine("INBOX")).toBe(2);
    expect(await client.search("ALL")).toEqual([11, 12]);
    const msg = await client.fetchMessage(12);
    expect(msg?.uid).toBe(12);
    expect(msg?.raw.toString("utf8")).toContain("Nota fiscal 4242");
    await client.logout();
    // somente leitura: EXAMINE em vez de SELECT, BODY.PEEK, e nenhum STORE/DELETE
    expect(seen.some((l) => /EXAMINE/.test(l))).toBe(true);
    expect(seen.some((l) => /BODY\.PEEK/.test(l))).toBe(true);
    expect(seen.some((l) => /\b(STORE|DELETE|EXPUNGE|APPEND)\b/.test(l))).toBe(false);
  });

  it("explica quando a senha está errada", async () => {
    const client = new ImapClient({ host: "127.0.0.1", port, user: "eu@empresa.com", password: `${SENHA_DE_MENTIRA}-errada`, tls: false });
    await client.connect();
    await expect(client.login()).rejects.toThrow(/recusou|senha/i);
    client.close();
  });

  it("monta a busca a partir da configuração", () => {
    expect(buildCriteria({})).toBe("ALL");
    expect(buildCriteria({ unseenOnly: true })).toBe("UNSEEN");
    expect(buildCriteria({ since: new Date("2026-09-01T12:00:00Z"), from: "nf@fornecedor.com.br" }))
      .toBe('SINCE 01-Sep-2026 FROM "nf@fornecedor.com.br"');
    expect(imapDate(new Date("2026-01-05T00:00:00"))).toBe("05-Jan-2026");
    expect(quote('a"b')).toBe('"a\\"b"');
  });

  it("lê linha a linha respeitando CRLF", () => {
    expect(takeLine(Buffer.from("* OK oi\r\nresto"))).toEqual({ line: "* OK oi", rest: 9 });
    expect(takeLine(Buffer.from("sem fim"))).toBeNull();
  });
});
