// Static scan of a built module graph, shared by the verify tests. Not a test file itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

const IMPORT = /(?:^|[;\s])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** Every file reachable from `entry` through relative imports, with its code and import specifiers. */
export function moduleGraph(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const code = stripComments(readFileSync(file, "utf8"));
    const specifiers = [...code.matchAll(IMPORT)].map((m) => m[1] ?? m[2]);
    seen.set(file, { code, specifiers });
    for (const specifier of specifiers) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) visit(resolve(dirname(file), specifier));
    }
  };
  visit(entry);
  return seen;
}

/** The verify files a browser loads, as paths relative to dist/. */
export const VERIFY_GRAPH = ["executor/jcs.js", "receipts/verify/base64url.js", "receipts/verify/index.js", "receipts/verify/verify.js"];

/**
 * Asserts the graph from `entry` is exactly the verify files, with no node:* or bare imports, no
 * Node globals, and none of the signing, custody, hashing or rendering modules.
 */
export function assertBrowserSafe(entry) {
  const graph = moduleGraph(entry);
  const files = [...graph.keys()].map((file) => relative(DIST, file).split("\\").join("/")).sort();
  assert.deepEqual(files, VERIFY_GRAPH);
  for (const [file, { code, specifiers }] of graph) {
    const name = relative(DIST, file);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${name} imports ${specifier}`);
      assert.ok(!specifier.startsWith("node:"), `${name} imports ${specifier}`);
    }
    assert.doesNotMatch(code, /\brequire\s*\(/, `${name} calls require`);
    assert.doesNotMatch(code, /\bBuffer\b/, `${name} uses Buffer`);
    assert.doesNotMatch(code, /\bprocess\b/, `${name} uses process`);
    assert.doesNotMatch(code, /custody|sign\.js|build\.js|hash\.js|render/, `${name} reaches a node-side module`);
  }
}
