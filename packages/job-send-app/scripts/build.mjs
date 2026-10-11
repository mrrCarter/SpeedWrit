// Builds the service into dist/: one Node ES module per entry, with job-send-ui's TSX compiled in.
// @writ/job-send stays external: it finds its migration files relative to its own module URL, so
// bundling it would point that URL at this package and break migrate() at boot. pg stays external
// too. Run with the workspace's node_modules (npm ci, then build job-send).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["config", "service", "main"].filter((name) => existsSync(resolve(root, `src/${name}.ts`)));
await build({
  entryPoints: Object.fromEntries(entries.map((name) => [name, resolve(root, `src/${name}.ts`)])),
  outdir: resolve(root, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  jsx: "automatic",
  external: ["pg", "pg-native", "@writ/job-send", "@writ/job-send/*"],
  // Bundled CommonJS dependencies may call require(); give them one.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`built ${entries.map((name) => `dist/${name}.mjs`).join(", ")}`);
