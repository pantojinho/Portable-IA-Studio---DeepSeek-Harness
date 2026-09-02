"""AUD-09 — música e efeitos num venv administrado pelo Studio.

  POST /music {"engine": "musicgen"|"acestep"|"stableaudio", "prompt": ..., "lyrics": ...,
               "durationSec": 30, "seed": 42, "output": "...wav"}

Tudo roda com offload para caber em 6 GB de VRAM; sem GPU, cai para CPU (lento, mas funciona).
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


def write_wav(path, audio, rate):
    import soundfile as sf
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sf.write(path, audio, rate)
    return path


def gen_musicgen(body):
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
    import torch
    name = body.get("model") or "facebook/musicgen-small"
    key = "musicgen:" + name
    if key not in MODELS:
        processor = AutoProcessor.from_pretrained(name)
        model = MusicgenForConditionalGeneration.from_pretrained(name).to(device())
        MODELS[key] = (processor, model)
    processor, model = MODELS[key]
    inputs = processor(text=[body.get("prompt", "")], padding=True, return_tensors="pt").to(device())
    seconds = float(body.get("durationSec") or 15)
    tokens = int(seconds * 50)  # MusicGen: ~50 tokens por segundo
    if body.get("seed") is not None:
        torch.manual_seed(int(body["seed"]))
    audio = model.generate(**inputs, max_new_tokens=tokens, do_sample=True)
    rate = model.config.audio_encoder.sampling_rate
    return write_wav(body["output"], audio[0, 0].cpu().numpy(), rate), seconds


def gen_stableaudio(body):
    from diffusers import StableAudioPipeline
    import torch
    name = body.get("model") or "stabilityai/stable-audio-open-small"
    key = "stableaudio:" + name
    if key not in MODELS:
        pipe = StableAudioPipeline.from_pretrained(name, torch_dtype=torch.float16 if device() == "cuda" else torch.float32)
        pipe = pipe.to(device())
        if device() == "cuda":
            pipe.enable_model_cpu_offload()
        MODELS[key] = pipe
    pipe = MODELS[key]
    generator = None
    if body.get("seed") is not None:
        import torch as _t
        generator = _t.Generator(device()).manual_seed(int(body["seed"]))
    seconds = float(body.get("durationSec") or 10)
    out = pipe(
        prompt=body.get("prompt", ""),
        negative_prompt=body.get("negativePrompt") or None,
        num_inference_steps=int(body.get("steps") or 100),
        audio_end_in_s=seconds,
        generator=generator,
    ).audios[0]
    return write_wav(body["output"], out.T.float().cpu().numpy(), pipe.vae.sampling_rate), seconds


def gen_acestep(body):
    """ACE-Step (letra + estilo). Requer o pacote acestep instalado no venv."""
    from acestep.pipeline_ace_step import ACEStepPipeline
    key = "acestep"
    if key not in MODELS:
        MODELS[key] = ACEStepPipeline(checkpoint_dir=os.environ.get("ACESTEP_CKPT", ""), dtype="float16" if device() == "cuda" else "float32", cpu_offload=True)
    pipe = MODELS[key]
    seconds = float(body.get("durationSec") or 30)
    pipe(
        prompt=body.get("prompt", ""),
        lyrics=body.get("lyrics", ""),
        audio_duration=seconds,
        infer_step=int(body.get("steps") or 60),
        manual_seeds=str(body.get("seed") or ""),
        save_path=body["output"],
    )
    return body["output"], seconds


ENGINES = {"musicgen": gen_musicgen, "stableaudio": gen_stableaudio, "acestep": gen_acestep}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "package": "music", "device": device(), "loaded": list(MODELS)})
        else:
            self._send(404, {"error": "rota desconhecida"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "JSON inválido"})
        if self.path != "/music":
            return self._send(404, {"error": "rota desconhecida"})
        fn = ENGINES.get((body.get("engine") or "musicgen"))
        if fn is None:
            return self._send(400, {"error": "motor desconhecido"})
        if not body.get("output"):
            return self._send(400, {"error": "informe 'output'"})
        try:
            file, seconds = fn(body)
            self._send(200, {"file": file, "durationSec": seconds})
        except Exception as exc:
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
