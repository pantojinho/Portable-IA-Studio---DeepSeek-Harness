import { describe, it, expect } from "vitest";
import { buildCaptureArgs, parseDshow, parseAvfoundation, parsePactl, parseDuration } from "./ffmpeg.js";

describe("audio/ffmpeg", () => {
  it("monta a captura de mic + sistema em um WAV 16 kHz mono", () => {
    const a = buildCaptureArgs("linux", { mic: "alsa_input.pci-0000_00_1f.3.analog-stereo", system: "alsa_output.pci.monitor", output: "/tmp/m.wav" });
    expect(a.filter((x) => x === "-f")).toHaveLength(2);
    expect(a.join(" ")).toContain("amix=inputs=2");
    expect(a.slice(-7).join(" ")).toBe("-ac 1 -ar 16000 -c:a pcm_s16le /tmp/m.wav");
  });

  it("usa dshow no Windows e avfoundation no macOS", () => {
    expect(buildCaptureArgs("win", { mic: "Microfone (Realtek)", system: null, output: "o.wav" }).join(" "))
      .toContain('-f dshow -i audio=Microfone (Realtek)');
    expect(buildCaptureArgs("mac", { mic: "0", system: null, output: "o.wav" }).join(" ")).toContain("-f avfoundation -i :0");
  });

  it("recusa gravação sem fonte", () => {
    expect(() => buildCaptureArgs("linux", { mic: null, system: null, output: "o.wav" })).toThrow(/ao menos uma fonte/);
  });

  it("não mistura quando há uma fonte só", () => {
    expect(buildCaptureArgs("linux", { mic: "default", system: null, output: "o.wav" }).join(" ")).not.toContain("amix");
  });

  it("lê dispositivos do dshow e marca o loopback como som do sistema", () => {
    const err = `[dshow @ 1] "Microfone (Realtek(R) Audio)" (audio)\n[dshow @ 1] "virtual-audio-capturer" (audio)\n[dshow @ 1] "Webcam" (video)`;
    const d = parseDshow(err);
    expect(d.map((x) => x.kind)).toEqual(["mic", "system"]);
  });

  it("lê dispositivos do avfoundation só na seção de áudio", () => {
    const err = `[AVFoundation indev @ 1] AVFoundation video devices:\n[AVFoundation indev @ 1] [0] FaceTime HD\n[AVFoundation indev @ 1] AVFoundation audio devices:\n[AVFoundation indev @ 1] [0] MacBook Pro Microphone\n[AVFoundation indev @ 1] [1] BlackHole 2ch`;
    const d = parseAvfoundation(err);
    expect(d).toEqual([
      { id: "0", name: "MacBook Pro Microphone", kind: "mic" },
      { id: "1", name: "BlackHole 2ch", kind: "system" },
    ]);
  });

  it("lê fontes do pactl e marca .monitor como sistema", () => {
    const d = parsePactl("0\talsa_output.pci-0000.analog-stereo.monitor\tPipeWire\ts16le 2ch 48000Hz\tIDLE\n1\talsa_input.pci-0000\tPipeWire\ts16le\tRUNNING\n");
    expect(d).toEqual([
      { id: "alsa_output.pci-0000.analog-stereo.monitor", name: "alsa_output.pci-0000.analog-stereo.monitor", kind: "system" },
      { id: "alsa_input.pci-0000", name: "alsa_input.pci-0000", kind: "mic" },
    ]);
  });

  it("extrai a duração do relatório do ffmpeg", () => {
    expect(parseDuration("  Duration: 00:01:03.52, start: 0.000000, bitrate: 256 kb/s")).toBeCloseTo(63.52, 2);
    expect(parseDuration("sem duração")).toBeNull();
  });
});
