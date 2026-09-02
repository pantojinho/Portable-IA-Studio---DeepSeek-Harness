"""Eco: prova que o runner Python (AUD-10) sobe um servidor e conversa por JSON.
Só biblioteca padrão — não precisa de venv."""
import argparse, json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "package": "demo"})
        else:
            self._send(404, {"error": "rota desconhecida"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "JSON inválido"})
        if self.path == "/echo":
            self._send(200, {"echo": body})
        else:
            self._send(404, {"error": "rota desconhecida"})

    def log_message(self, *args):  # o Studio já registra em data/logs/python-demo.log
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
