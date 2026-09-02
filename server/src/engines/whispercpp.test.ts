import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWhisperArgs, parseWhisperJson, isWav16kMono, toSrt, toVtt, srtTime } from "./whispercpp.js";

const sample = JSON.stringify({
  result: { language: "pt" },
  transcription: [
    { offsets: { from: 0, to: 1500 }, text: " Bom dia a todos. [SPEAKER_TURN]", tokens: [{ text: "Bom", offsets: { from: 0, to: 400 }, p: 0.9 }, { text: " dia", offsets: { from: 400, to: 900 }, p: 0.8 }] },
    { offsets: { from: 1500, to: 3000 }, text: " Bom dia, vamos começar.", speaker_turn_next: true },
    { offsets: { from: 3000, to: 3100 }, text: "   " },
  ],
});

function wavHeader(sampleRate: number, channels: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0, "latin1"); b.write("WAVE", 8, "latin1"); b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  return b;
}

describe("engines/whispercpp", () => {
  it("monta os argumentos: -oj para segmentos, -ojf para palavras, -tdrz para falantes", () => {
    const base = { model: "m.bin", wav: "a.wav", outBase: "/tmp/out" };
    expect(buildWhisperArgs({ ...base }).join(" ")).toContain("-oj");
    expect(buildWhisperArgs({ ...base, words: true }).join(" ")).toContain("-ojf");
    expect(buildWhisperArgs({ ...base, diarize: true, translate: true, language: "pt" }).join(" ")).toContain("-tdrz");
    expect(buildWhisperArgs({ ...base, translate: true }).join(" ")).toContain("-tr");
    expect(buildWhisperArgs({ ...base }).join(" ")).toContain("-l auto");
  });

  it("converte o JSON em Transcript, com falantes e palavras", () => {
    const t = parseWhisperJson(sample, { diarize: true });
    expect(t.language).toBe("pt");
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0]!.text).toBe("Bom dia a todos.");
    expect(t.segments[0]!.speaker).toBe("Falante 1");
    expect(t.segments[1]!.speaker).toBe("Falante 2");
    expect(t.segments[0]!.words?.map((w) => w.word)).toEqual(["Bom", "dia"]);
    expect(t.segments[0]!.confidence).toBeCloseTo(0.85, 3);
    expect(t.text).toBe("Bom dia a todos. Bom dia, vamos começar.");
    expect(t.duration).toBe(3);
  });

  it("desloca os tempos (janelas de reunião) e omite falantes quando não há diarização", () => {
    const t = parseWhisperJson(sample, { offsetSec: 60 });
    expect(t.segments[0]!.start).toBe(60);
    expect(t.segments[0]!.speaker).toBeUndefined();
  });

  it("reconhece só WAV PCM 16 kHz mono", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-"));
    const ok = path.join(dir, "ok.wav"); fs.writeFileSync(ok, wavHeader(16000, 1));
    const stereo = path.join(dir, "s.wav"); fs.writeFileSync(stereo, wavHeader(16000, 2));
    const hz = path.join(dir, "hz.wav"); fs.writeFileSync(hz, wavHeader(44100, 1));
    const mp3 = path.join(dir, "a.mp3"); fs.writeFileSync(mp3, Buffer.from("ID3"));
    expect(isWav16kMono(ok)).toBe(true);
    expect(isWav16kMono(stereo)).toBe(false);
    expect(isWav16kMono(hz)).toBe(false);
    expect(isWav16kMono(mp3)).toBe(false);
    expect(isWav16kMono(path.join(dir, "nao-existe.wav"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exporta SRT e VTT com falante", () => {
    const t = parseWhisperJson(sample, { diarize: true });
    expect(toSrt(t)).toContain("Falante 1: Bom dia a todos.");
    expect(toSrt(t)).toContain("00:00:00,000 --> 00:00:01,500");
    expect(toVtt(t).startsWith("WEBVTT")).toBe(true);
    expect(srtTime(3661.25)).toBe("01:01:01,250");
  });
});
