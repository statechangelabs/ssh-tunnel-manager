import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// CLI entry point — ESM, bundles core + commander, externals: node builtins + chokidar + tree-kill
await build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/cli.mjs",
  external: ["chokidar", "tree-kill"],
  define: { PKG_VERSION: JSON.stringify(pkg.version) },
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
});

// Electron main process — ESM, bundles core, external: electron + chokidar + tree-kill
await build({
  entryPoints: ["src/app/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/app.mjs",
  external: ["electron", "chokidar", "tree-kill"],
  banner: {
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
});

// Electron preload — CJS (Electron requires preload to be CommonJS)
await build({
  entryPoints: ["src/app/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.js",
  external: ["electron"],
});

console.log("Built dist/cli.mjs + dist/app.mjs + dist/preload.js");
