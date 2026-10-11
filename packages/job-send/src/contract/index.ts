// Browser-safe entry for the contract (package export "./contract"): reason codes, the allow-list
// helpers, results and receipt types. Its import graph holds no vendor or node code
// (tests/contract/import-graph.test.mjs), so the owner screens can import it.
export * from "./reasons.js";
export * from "./types.js";
