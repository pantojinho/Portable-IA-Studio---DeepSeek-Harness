import net from "node:net";

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Returns `preferred` if free, otherwise the first free port in [from, to]. */
export async function findFreePort(preferred: number, from: number, to: number, host = "127.0.0.1"): Promise<number> {
  if (await isPortFree(preferred, host)) return preferred;
  for (let p = from; p <= to; p++) {
    if (p !== preferred && (await isPortFree(p, host))) return p;
  }
  throw new Error(`Nenhuma porta livre entre ${from} e ${to} (preferida: ${preferred}).`);
}
