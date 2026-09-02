"""AUD-06 — clonagem de voz num venv administrado pelo Studio.

Um servidor para três motores; o Studio escolhe por chamada:
  POST /tts {"engine": "chatterbox"|"xtts"|"f5tts", "text": ..., "output": ..., "ref_wav": ..., "language": "pt"}
O modelo fica carregado entre chamadas (a primeira paga o carregamento).
Licenças: XTTS-v2 e F5-TTS são não comerciais; o Studio avisa na receita.
"""
import argparse
import json
import os
import traceback
import socketserver
from http.server import BaseHTTPRequestHandler, HTTPServer

MODELS = {}


def device():
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def synth_chatterbox(text, output, ref_wav, language, params):
    from chatterbox.tts import ChatterboxTTS
    import torchaudio
    model = MODELS.get("chatterbox")
    if model is None:
        model = ChatterboxTTS.from_pretrained(device=device())
        MODELS["chatterbox"] = model
    kwargs = {}
    if ref_wav:
        kwargs["audio_prompt_path"] = ref_wav
    for key in ("exaggeration", "cfg_weight", "temperature"):
        if key in params:
            kwargs[key] = params[key]
    wav = model.generate(text, **kwargs)
    torchaudio.save(output, wav, model.sr)
    return output


def synth_xtts(text, output, ref_wav, language, params):
    from TTS.api import TTS
    model = MODELS.get("xtts")
    if model is None:
        model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device())
        MODELS["xtts"] = model
    if not ref_wav:
        raise ValueError("XTTS-v2 precisa de uma amostra de voz (ref_wav)")
    model.tts_to_file(
        text=text,
        speaker_wav=ref_wav,
        language=(language or "pt")[:2],
        file_path=output,
        speed=params.get("speed", 1.0),
    )
    return output


def synth_f5(text, output, ref_wav, language, params):
    from f5_tts.api import F5TTS
    model = MODELS.get("f5tts")
    if model is None:
        model = F5TTS(model=params.get("model_name", "F5TTS_v1_Base"), ckpt_file=params.get("ckpt", ""), device=device())
        MODELS["f5tts"] = model
    if not ref_wav:
        raise ValueError("F5-TTS precisa de uma amostra de voz (ref_wav)")
    model.infer(
        ref_file=ref_wav,
        ref_text=params.get("ref_text", ""),
        gen_text=text,
        file_wave=output,
        speed=params.get("speed", 1.0),
        remove_silence=True,
    )
    return output


ENGINES = {"chatterbox": synth_chatterbox, "xtts": synth_xtts, "f5tts": synth_f5}


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
            self._send(200, {"ok": True, "package": "tts-clone", "device": device(), "loaded": list(MODELS)})
        else:
            self._send(404, {"error": "rota desconhecida"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "JSON inválido"})
        if self.path != "/tts":
            return self._send(404, {"error": "rota desconhecida"})
        engine = (body.get("engine") or "chatterbox").replace("python:", "")
        fn = ENGINES.get(engine)
        if fn is None:
            return self._send(400, {"error": "motor desconhecido: %s" % engine})
        text = (body.get("text") or "").strip()
        output = body.get("output")
        if not text or not output:
            return self._send(400, {"error": "informe 'text' e 'output'"})
        os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
        try:
            file = fn(text, output, body.get("ref_wav"), body.get("language"), body.get("params") or {})
            self._send(200, {"file": file, "engine": engine})
        except Exception as exc:  # devolve a causa para o Studio mostrar em português
            traceback.print_exc()
            self._send(500, {"error": "%s: %s" % (type(exc).__name__, exc)})

    def log_message(self, *args):
        pass


class Studio(socketserver.ThreadingMixIn, HTTPServer):
    """Sem lookup reverso de DNS: HTTPServer.server_bind chama socket.getfqdn(), que
    trava por dezenas de segundos em algumas máquinas (macOS com mDNS). O Studio só
    escuta em 127.0.0.1, então o nome não serve para nada."""

    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()
    Studio(("127.0.0.1", args.port), Handler).serve_forever()
