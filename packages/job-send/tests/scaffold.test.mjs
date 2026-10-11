import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PACKAGE_NAME } from "../dist/index.js";

test("the package builds and exports its name", () => {
  assert.equal(PACKAGE_NAME, "@writ/job-send");
});

// npm runs scripts with sh, where an unquoted ** matches one directory level only, so
// `node --test tests/**/*.test.mjs` would skip flat files like this one, and any file two levels
// down. Quoted, the pattern reaches node, which matches every depth.
test("the test script passes node a quoted glob", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /node --test "tests\/\*\*\/\*\.test\.mjs"/);
});
