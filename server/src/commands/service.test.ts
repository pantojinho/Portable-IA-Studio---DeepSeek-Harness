import { describe, it, expect } from "vitest";
import { systemdCommand } from "./service.js";

describe("commands/service (SVC-01)", () => {
  it("põe aspas no caminho com espaço — a pasta do dono se chama \"Portable IA Studio\"", () => {
    const cmd = systemdCommand("/home/eu/AI Studio/Portable IA Studio/aistudio", ["serve", "--headless", "--no-open"]);
    expect(cmd).toBe('"/home/eu/AI Studio/Portable IA Studio/aistudio" serve --headless --no-open');
  });

  it("escapa aspas dentro do caminho e não mexe no que não precisa", () => {
    expect(systemdCommand('/tmp/a"b/aistudio', ["serve"])).toBe('"/tmp/a\\"b/aistudio" serve');
    expect(systemdCommand("/opt/aistudio", ["serve", "--port", "1420"])).toBe("/opt/aistudio serve --port 1420");
  });
});
