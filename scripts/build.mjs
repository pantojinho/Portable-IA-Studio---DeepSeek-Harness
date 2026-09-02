// Bundles the whole server into ONE file (dist/server.cjs) so the portable
// package never needs `npm install` on the user's machine.
import { build, context } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

mkdirSync(path.join(root, "dist"), { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, "server/src/cli.ts")],
  outfile: path.join(root, "dist/server.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  // node:sqlite and other builtins stay external automatically.
  banner: { js: "#!/usr/bin/env node" },
  define: { "process.env.AISTUDIO_BUILD": JSON.stringify(new Date().toISOString()) },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching server/src …");
} else {
  await build(options);
}
