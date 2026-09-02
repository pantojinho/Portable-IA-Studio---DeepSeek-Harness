import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Platform = "win" | "mac" | "linux";
export type Arch = "x64" | "arm64";
export type Backend = "cuda" | "rocm" | "vulkan" | "metal" | "cpu";

export interface GpuInfo {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  vramMiB: number | null;
  vramUsedMiB?: number | null;
  driver?: string;
}

export interface SystemInfo {
  platform: Platform;
  arch: Arch;
  osVersion: string;
  cpu: string;
  cores: number;
  ramMiB: number;
  ramFreeMiB: number;
  gpus: GpuInfo[];
  recommendedBackend: Backend;
  node: string;
  diskFreeMiB: number | null;
}

export function platform(): Platform {
  return process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
}
export function arch(): Arch { return process.arch === "arm64" ? "arm64" : "x64"; }
export function osArch(): string { return `${platform()}-${arch()}`; }

async function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 });
    return stdout;
  } catch { return ""; }
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,driver_version", "--format=csv,noheader,nounits"]);
  return out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name = "", total = "", used = "", driver = ""] = line.split(",").map((s) => s.trim());
    return { name, vendor: "nvidia" as const, vramMiB: Number(total) || null, vramUsedMiB: Number(used) || null, driver };
  });
}

function vendorOf(name: string): GpuInfo["vendor"] {
  const n = name.toLowerCase();
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return "nvidia";
  if (/amd|radeon|advanced micro/.test(n)) return "amd";
  if (/intel|arc|iris|uhd/.test(n)) return "intel";
  if (/apple/.test(n)) return "apple";
  return "unknown";
}

async function otherGpus(): Promise<GpuInfo[]> {
  const p = platform();
  if (p === "win") {
    const out = await run("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress"]);
    try {
      const parsed = JSON.parse(out || "[]");
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter((g) => g?.Name).map((g) => ({
        name: String(g.Name), vendor: vendorOf(String(g.Name)),
        vramMiB: g.AdapterRAM ? Math.round(Number(g.AdapterRAM) / 1048576) : null, driver: g.DriverVersion,
      }));
    } catch { return []; }
  }
  if (p === "mac") {
    const out = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
    try {
      const items = JSON.parse(out || "{}").SPDisplaysDataType ?? [];
      return items.map((g: Record<string, string>) => ({
        name: g.sppci_model ?? g._name ?? "GPU", vendor: vendorOf(g.sppci_model ?? g._name ?? ""),
        vramMiB: g.spdisplays_vram ? parseInt(g.spdisplays_vram, 10) * (/GB/i.test(g.spdisplays_vram) ? 1024 : 1) : null,
      }));
    } catch { return []; }
  }
  const out = await run("sh", ["-c", "lspci 2>/dev/null | grep -iE 'vga|3d|display'"]);
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const name = l.split(":").slice(2).join(":").trim() || l;
    return { name, vendor: vendorOf(name), vramMiB: null };
  });
}

export async function detectGpus(): Promise<GpuInfo[]> {
  const nv = await nvidiaGpus();
  const others = await otherGpus();
  // prefer nvidia-smi numbers; add non-nvidia adapters from the OS list
  const merged = [...nv, ...others.filter((g) => g.vendor !== "nvidia" || nv.length === 0)];
  if (merged.length === 0 && platform() === "mac" && arch() === "arm64") {
    merged.push({ name: "Apple Silicon GPU", vendor: "apple", vramMiB: Math.round(os.totalmem() / 1048576) });
  }
  return merged;
}

export function recommendBackend(gpus: GpuInfo[]): Backend {
  if (platform() === "mac") return arch() === "arm64" ? "metal" : "cpu";
  if (gpus.some((g) => g.vendor === "nvidia")) return "cuda";
  if (gpus.some((g) => g.vendor === "amd")) return platform() === "linux" ? "rocm" : "vulkan";
  if (gpus.some((g) => g.vendor === "intel")) return "vulkan";
  return "cpu";
}

export async function diskFreeMiB(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return Math.round((s.bavail * s.bsize) / 1048576);
  } catch { return null; }
}

export async function systemInfo(root: string): Promise<SystemInfo> {
  const gpus = await detectGpus();
  return {
    platform: platform(),
    arch: arch(),
    osVersion: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model?.trim() ?? "CPU",
    cores: os.cpus().length,
    ramMiB: Math.round(os.totalmem() / 1048576),
    ramFreeMiB: Math.round(os.freemem() / 1048576),
    gpus,
    recommendedBackend: recommendBackend(gpus),
    node: process.version,
    diskFreeMiB: await diskFreeMiB(root),
  };
}

/** Cheap live snapshot for the UI monitor (no GPU enumeration except nvidia-smi). */
export async function liveStats(): Promise<{ ramUsedMiB: number; ramMiB: number; cpuLoad: number; gpus: GpuInfo[] }> {
  const load = os.loadavg()[0] ?? 0;
  return {
    ramMiB: Math.round(os.totalmem() / 1048576),
    ramUsedMiB: Math.round((os.totalmem() - os.freemem()) / 1048576),
    cpuLoad: platform() === "win" ? await winCpuLoad() : Math.min(1, load / os.cpus().length),
    gpus: await nvidiaGpus(),
  };
}

let lastCpu = os.cpus();
async function winCpuLoad(): Promise<number> {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i];
    if (!prev) return;
    const dIdle = c.times.idle - prev.times.idle;
    const dTotal = (Object.values(c.times).reduce((a, b) => a + b, 0)) - (Object.values(prev.times).reduce((a, b) => a + b, 0));
    idle += dIdle; total += dTotal;
  });
  lastCpu = now;
  return total > 0 ? 1 - idle / total : 0;
}
