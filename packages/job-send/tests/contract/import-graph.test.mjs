import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLAGS } from "../../dist/ai-review/flags.js";
import { QUESTIONS } from "../../dist/ai-review/provider.js";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

// Every module a built file loads, following relative static imports and re-exports.
function importGraph(entry) {
  const seen = new Set();
  const queue = [path.join(DIST, entry)];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return [...seen].map((file) => path.relative(DIST, file).replace(/\\/g, "/")).sort();
}

for (const entry of ["contract/index.js", "contract/reasons.js", "contract/types.js"]) {
  test(`${entry} never loads the review adapter, so a browser can import the contract`, () => {
    const graph = importGraph(entry);
    assert.ok(graph.includes(entry), graph.join(", "));
    assert.ok(!graph.includes("ai-review/provider.js"), `the contract loads the adapter: ${graph.join(", ")}`);
  });
}

test("the vendor-free flag list is exactly the review questions", () => {
  assert.deepEqual([...FLAGS].sort(), Object.keys(QUESTIONS).sort());
});
