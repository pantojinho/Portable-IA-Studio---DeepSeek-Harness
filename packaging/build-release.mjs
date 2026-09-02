// REL-01. Monta o pacote portátil por sistema: um .zip que a pessoa descompacta e roda.
// O que entra: dist/server.cjs, web/dist, os lançadores, as receitas, os tipos de documento,
// os servidores Python e o catálogo de motores. O que NÃO entra: modelos, motores, node_modules
// e qualquer estado do usuário — tudo isso é baixado sob demanda (AGENTS.md §2.2).
//
//   node packaging/build-release.mjs [--platform win|mac|linux|all] [--node] [--out dist/release]
//
// --node baixa o Node portátil correspondente e o inclui (pacote "sem pré-requisito nenhum").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const outDir = path.resolve(root, String(flag("out", "dist/release")));
const platforms = String(flag("platform", "all")) === "all" ? ["win", "mac", "linux"] : [String(flag("platform"))];
const withNode = args.includes("--node");

const NODE_VERSION = "24.19.0";
const NODE_URL = {
  win: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  mac: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  linux: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
};

/** Arquivos comuns a todos os pacotes (origem → destino dentro do zip). */
const COMMON = [
  "dist/server.cjs",
  "web/dist",
  "models/recipes",
  "documents/doctypes",
  "engines/catalog.yaml",
  "engines/python",
  "agent/package.json",
  "README.md",
  "LICENSE",
  "docs/API.md",
  "docs/ARCHITECTURE.md",
];

const LAUNCHERS = { win: ["start.bat", "aistudio.cmd"], mac: ["start.command", "aistudio"], linux: ["start.sh", "aistudio"] };

function run(exe, argv, opts = {}) {
  const r = spawnSync(exe, argv, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${exe} ${argv.join(" ")} falhou (código ${r.status})`);
}

function copy(from, to) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) { console.warn(`  (pulei ${from}: não existe)`); return; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(src, to, { recursive: true });
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

console.log(`AI Studio ${version} — empacotando para: ${platforms.join(", ")}`);
run("npm", ["run", "build"]);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const platform of platforms) {
  const name = `aistudio-${version}-${platform}-x64`;
  const stage = path.join(outDir, name);
  console.log(`\n▸ ${name}`);
  fs.mkdirSync(stage, { recursive: true });

  for (const item of COMMON) copy(item, path.join(stage, item));
  for (const launcher of LAUNCHERS[platform] ?? []) copy(launcher, path.join(stage, launcher));
  // pastas de estado vazias, para o primeiro arranque não precisar criar nada em disco lento
  for (const dir of ["models", "engines", "projects", "voices", "data", "runtime"]) fs.mkdirSync(path.join(stage, dir), { recursive: true });

  if (platform !== "win") {
    for (const launcher of LAUNCHERS[platform] ?? []) {
      const file = path.join(stage, launcher);
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
    }
  }

  if (withNode) {
    const url = NODE_URL[platform];
    const archive = path.join(outDir, path.basename(new URL(url).pathname));
    if (!fs.existsSync(archive)) { console.log(`  baixando ${path.basename(archive)}…`); await download(url, archive); }
    const nodeDir = path.join(stage, "runtime", "node");
    fs.mkdirSync(nodeDir, { recursive: true });
    run("tar", ["-xf", archive, "-C", nodeDir]);
    console.log("  Node portátil incluído");
  }

  fs.writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(stage, "LEIA-ME.txt"), leiaMe(platform, version));

  const archive = pack(outDir, name);
  const size = (fs.statSync(archive).size / 1048576).toFixed(1);
  console.log(`  ✔ ${path.relative(root, archive)} (${size} MB)`);
  fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`\nPronto. Os pacotes estão em ${path.relative(root, outDir)}/`);

/**
 * Compacta a pasta preparada. O `tar -a` só escreve ZIP de verdade quando o tar é o bsdtar
 * (Windows 10+, macOS); o GNU tar do Linux ignora a extensão e gera um .tar com nome .zip, que
 * ninguém consegue abrir. Então: `zip` quando existir, senão bsdtar, senão .tar.gz honesto.
 */
function pack(outDir, name) {
  const zip = path.join(outDir, `${name}.zip`);
  fs.rmSync(zip, { force: true });
  if (has("zip")) {
    run("zip", ["-r", "-q", zip, name], { cwd: outDir });
    return zip;
  }
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "";
  if (/bsdtar/i.test(version)) {
    run("tar", ["-a", "-c", "-f", zip, name], { cwd: outDir });
    return zip;
  }
  const tgz = path.join(outDir, `${name}.tar.gz`);
  fs.rmSync(tgz, { force: true });
  console.log("  (sem zip nem bsdtar nesta máquina: gerando .tar.gz)");
  run("tar", ["-czf", tgz, name], { cwd: outDir });
  return tgz;
}

function has(exe) {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [exe], { encoding: "utf8" });
  return probe.status === 0;
}

function leiaMe(platform, version) {
  const start = platform === "win" ? "start.bat (duplo clique)" : platform === "mac" ? "start.command (duplo clique)" : "./start.sh";
  return `AI Studio ${version}

Como usar
---------
1. Descompacte esta pasta onde quiser (pendrive serve).
2. Rode: ${start}
3. A interface abre em http://127.0.0.1:1420

O primeiro arranque baixa o Node portátil (se não vier junto) e constrói o servidor.
Modelos e motores são baixados sob demanda, pela aba Modelos ou pela linha de comando:

  aistudio models pull recipe:qwen3-4b
  aistudio engines adopt          (aproveita binários de uma instalação antiga)
  aistudio doctor                 (diagnóstico da máquina)

Tudo fica dentro desta pasta. Copiar a pasta = mover a instalação inteira.
Nada é instalado no sistema e nada sai para a internet sem você pedir.
`;
}
