import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIST, assertBrowserSafe } from "./receipts-support/module-graph.mjs";

// These resolve through package.json "exports" by package self-reference, the same map a consumer
// such as the /verify page resolves through its workspace link.

test("exports: @writ/job-send/verify resolves to the browser-safe verify build", async () => {
  const entry = fileURLToPath(import.meta.resolve("@writ/job-send/verify"));
  assert.equal(entry, join(DIST, "receipts", "verify", "index.js"));
  const verify = await import("@writ/job-send/verify");
  assert.equal(typeof verify.verifyReceipt, "function");
  assert.equal(typeof verify.verifyReceiptText, "function");
  assert.deepEqual(Object.keys(verify).sort(), ["decodeBase64Url", "keyIdOf", "receiptEnvelopeText", "verifyReceipt", "verifyReceiptText"]);
  assertBrowserSafe(entry);
});

test("exports: the root entry resolves to the main build", async () => {
  assert.equal(fileURLToPath(import.meta.resolve("@writ/job-send")), join(DIST, "index.js"));
  const main = await import("@writ/job-send");
  assert.equal(main.PACKAGE_NAME, "@writ/job-send");
  assert.equal(typeof main.signReceipt, "function");
});

test("exports: a receipt signed through the root entry verifies through ./verify", async () => {
  const { generateReceiptKeyPair, signReceipt } = await import("@writ/job-send");
  const { receiptEnvelopeText, verifyReceipt, verifyReceiptText } = await import("@writ/job-send/verify");
  const pair = generateReceiptKeyPair();
  const pinned = { keyId: pair.keyId, publicKeyRaw: pair.publicKeyRaw };
  const signed = signReceipt(pair.privateKey, { id: "rcp_1", seq: 1, type: "STOP_ENGAGED", ts: "2026-10-11T19:04:11Z", owner: "own_1" });
  assert.deepEqual(await verifyReceipt(signed, pinned), { ok: true, reason: "verified" });
  assert.deepEqual(await verifyReceiptText(receiptEnvelopeText(signed), pinned), { ok: true, reason: "verified" });
});

test("exports: every export target and its types file exist after the build", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./contract", "./server", "./verify"]);
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.types, "dist/index.d.ts");
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    assert.deepEqual(Object.keys(target), ["types", "default"], `${subpath}: "types" must come first`);
    for (const file of Object.values(target)) {
      assert.ok(existsSync(fileURLToPath(new URL(`../${file}`, import.meta.url))), `${subpath} -> ${file}`);
    }
  }
});

test("exports: files outside the map are not importable by package name", () => {
  for (const subpath of ["dist/receipts/sign.js", "dist/index.js", "receipts/verify", "package.json"]) {
    assert.throws(() => import.meta.resolve(`@writ/job-send/${subpath}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, subpath);
  }
});

test("exports: @writ/job-send/contract resolves to the contract barrel, with the fail-closed allow-list", async () => {
  assert.equal(fileURLToPath(import.meta.resolve("@writ/job-send/contract")), join(DIST, "contract", "index.js"));
  const contract = await import("@writ/job-send/contract");
  assert.equal(contract.reasonClass("custom_content"), "ask_me");
  assert.equal(contract.reasonClass("superseded"), "never");
  assert.equal(contract.RECEIPT_TYPES.length, 21);
  assert.equal(typeof contract.isAskMeReason, "function");
});
