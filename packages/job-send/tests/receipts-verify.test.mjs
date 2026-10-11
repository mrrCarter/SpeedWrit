import assert from "node:assert/strict";
import { sign as nodeSign } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { generateReceiptKeyPair, receiptKeyId, signReceipt } from "../dist/index.js";
// The browser entry point, imported on its own.
import {
  decodeBase64Url,
  keyIdOf,
  receiptEnvelopeText,
  verifyReceipt,
  verifyReceiptText,
} from "../dist/receipts/verify/index.js";
import { DIST, assertBrowserSafe, moduleGraph } from "./receipts-support/module-graph.mjs";

const A = generateReceiptKeyPair();
const B = generateReceiptKeyPair();
const pinnedA = { keyId: A.keyId, publicKeyRaw: A.publicKeyRaw };
const pinnedB = { keyId: B.keyId, publicKeyRaw: B.publicKeyRaw };

const fields = {
  id: "rcp_01JQ7",
  seq: 17,
  type: "PROVIDER_ACCEPTED",
  ts: "2026-10-11T19:04:11Z",
  owner: "own_carter",
  job: "job_tuesday_recap",
  policy_version: 1,
  agent_connection: "ac_chatgpt_1",
  client_label: "ChatGPT (declared)",
  proposal: "prp_1",
  version: 2,
  version_sha256: "f6f73d21d67352a54c8ee029105e21ac839e1f168947e81f785df34e0bf0a525",
  detail: { provider: "gmail", provider_message_id: "18c2f0a1b2c3d4e5", note: "café ☕" },
  prev_sha256: null,
};
const signed = signReceipt(A.privateKey, fields);

/** Signs arbitrary text with key A, bypassing signReceipt's canonicalization. */
const signText = (payload) => ({
  payload,
  signature: nodeSign(null, Buffer.from(payload, "utf8"), A.privateKey).toString("base64url"),
  key_id: A.keyId,
});

const results = [];
async function check(promise, reason, label) {
  const outcome = await promise;
  results.push(outcome);
  assert.deepEqual(outcome, { ok: reason === "verified", reason }, label);
}

test("verify: a signed receipt verifies against the pinned key", async () => {
  await check(verifyReceipt(signed, pinnedA), "verified");
  await check(verifyReceipt({ ...signed }, { ...pinnedA, publicKeyRaw: Uint8Array.from(A.publicKeyRaw) }), "verified");
});

test("verify: changing any one byte of the payload gives invalid_signature", async () => {
  for (let i = 0; i < signed.payload.length; i++) {
    const code = signed.payload.charCodeAt(i);
    const replacement = String.fromCharCode(code < 0x80 ? code ^ 0x01 : 0x41);
    const payload = signed.payload.slice(0, i) + replacement + signed.payload.slice(i + 1);
    await check(verifyReceipt({ ...signed, payload }, pinnedA), "invalid_signature", `payload char ${i}`);
  }
  await check(verifyReceipt({ ...signed, payload: `${signed.payload} ` }, pinnedA), "invalid_signature");
  await check(verifyReceipt({ ...signed, payload: signed.payload.replace('"seq":17', '"seq":18') }, pinnedA), "invalid_signature");
});

test("verify: a damaged signature gives invalid_signature", async () => {
  const sig = signed.signature;
  const swap = (s, i) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  for (const i of [0, 10, 42, 84, 85]) await check(verifyReceipt({ ...signed, signature: swap(sig, i) }, pinnedA), "invalid_signature", `sig char ${i}`);
  for (const bad of ["", sig.slice(0, -2), `${sig}AA`, `${sig}=`, sig.replace(/[A-Za-z0-9]/, "+"), "!".repeat(86)]) {
    await check(verifyReceipt({ ...signed, signature: bad }, pinnedA), "invalid_signature", JSON.stringify(bad));
  }
  const other = signReceipt(A.privateKey, { ...fields, seq: 18 });
  await check(verifyReceipt({ ...signed, signature: other.signature }, pinnedA), "invalid_signature");
});

test("verify: a different key gives unknown_key, never invalid_signature", async () => {
  await check(verifyReceipt(signed, pinnedB), "unknown_key");
  await check(verifyReceipt({ ...signed, key_id: "0000000000000000" }, pinnedA), "unknown_key");
  await check(verifyReceipt({ ...signed, key_id: signed.key_id.toUpperCase() }, pinnedA), "unknown_key");
  // Claiming the pinned key's id does not help a signature made by another key.
  const byB = signReceipt(B.privateKey, fields);
  await check(verifyReceipt({ ...byB, key_id: A.keyId }, pinnedA), "invalid_signature");
  await check(verifyReceipt(byB, pinnedB), "verified");
});

test("verify: a validly signed payload that is not canonical gives not_canonical", async () => {
  const parsed = JSON.parse(signed.payload);
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
  assert.notEqual(reordered, signed.payload);
  assert.deepEqual(JSON.parse(reordered), parsed);
  await check(verifyReceipt(signText(reordered), pinnedA), "not_canonical", "reordered keys");
  await check(verifyReceipt(signText(JSON.stringify(parsed, null, 2)), pinnedA), "not_canonical", "whitespace");
  await check(verifyReceipt(signText(`{"v":1,${signed.payload.slice(1)}`), pinnedA), "not_canonical", "duplicate key");
  await check(verifyReceipt(signText(signed.payload.replace('"seq":17', '"seq":17.0')), pinnedA), "not_canonical", "17.0");
  await check(verifyReceipt(signText(signed.payload.replace('"seq":17', '"seq":0.5')), pinnedA), "not_canonical", "float");
  await check(verifyReceipt(signText(signed.payload.replace("café", "caf\\u00e9")), pinnedA), "not_canonical", "escaped é");
  await check(verifyReceipt(signText("not json"), pinnedA), "not_canonical", "not JSON");
  // The control: the same route with canonical text verifies.
  await check(verifyReceipt(signText(signed.payload), pinnedA), "verified");
});

test("verify: an envelope without three strings gives malformed", async () => {
  for (const bad of [null, undefined, 42, "x", {}, { payload: signed.payload, signature: signed.signature }, { ...signed, payload: 1 }, { ...signed, signature: null }, { ...signed, key_id: 7 }]) {
    await check(verifyReceipt(bad, pinnedA), "malformed", JSON.stringify(bad));
  }
});

test("verify: receiptEnvelopeText is the canonical three-key envelope", () => {
  const text = receiptEnvelopeText(signed);
  assert.equal(text, `{"key_id":${JSON.stringify(signed.key_id)},"payload":${JSON.stringify(signed.payload)},"signature":${JSON.stringify(signed.signature)}}`);
  assert.equal(receiptEnvelopeText({ signature: signed.signature, key_id: signed.key_id, payload: signed.payload }), text);
  assert.throws(() => receiptEnvelopeText({ ...signed, key_id: 7 }), TypeError);
  assert.throws(() => receiptEnvelopeText({ payload: signed.payload, signature: signed.signature }), TypeError);
});

test("verify: verifyReceiptText accepts exactly the canonical envelope", async () => {
  const text = receiptEnvelopeText(signed);
  await check(verifyReceiptText(text, pinnedA), "verified");
  await check(verifyReceiptText(`\n  ${text}\r\n\t`, pinnedA), "verified", "surrounding ASCII whitespace");
  await check(verifyReceiptText(text, pinnedB), "unknown_key");
  await check(verifyReceiptText(receiptEnvelopeText(signText(JSON.stringify(JSON.parse(signed.payload), null, 1))), pinnedA), "not_canonical");
  // A one-byte change to the payload inside a canonical envelope never verifies.
  for (const i of [2, 20, 60, signed.payload.length - 3]) {
    const code = signed.payload.charCodeAt(i);
    const payload = signed.payload.slice(0, i) + String.fromCharCode(code < 0x80 ? code ^ 0x01 : 0x41) + signed.payload.slice(i + 1);
    const outcome = await verifyReceiptText(receiptEnvelopeText({ ...signed, payload }), pinnedA);
    results.push(outcome);
    assert.equal(outcome.ok, false, `payload char ${i}`);
    assert.ok(["invalid_signature", "not_canonical"].includes(outcome.reason), `payload char ${i}: ${outcome.reason}`);
  }
});

test("verify: verifyReceiptText refuses duplicate, extra, reordered or re-spaced envelopes", async () => {
  const text = receiptEnvelopeText(signed);
  const forged = JSON.stringify({ ...JSON.parse(signed.payload), type: "DELIVERY_WITNESSED" });
  const cp = (...points) => String.fromCodePoint(...points);
  const refused = {
    // JSON.parse keeps the LAST duplicate, so a forged first "payload" would ride along unseen.
    "forged payload key prepended": `{"payload":${JSON.stringify(forged)},${text.slice(1)}`,
    "forged payload key appended": `${text.slice(0, -1)},"payload":${JSON.stringify(forged)}}`,
    "duplicate key_id": `{"key_id":"0000000000000000",${text.slice(1)}`,
    "extra key appended": `${text.slice(0, -1)},"status":"Delivered"}`,
    "extra key prepended": `{"a":1,${text.slice(1)}`,
    "pretty-printed": JSON.stringify(JSON.parse(text), null, 2),
    "reordered keys": JSON.stringify({ payload: signed.payload, signature: signed.signature, key_id: signed.key_id }),
    "space after a colon": text.replace('"key_id":', '"key_id": '),
    // The same string value, spelled with a JSON escape the canonical form does not use.
    "escaped character": text.replace(
      `"signature":"${signed.signature[0]}`,
      `"signature":"${cp(0x5c)}u${signed.signature.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
    "leading BOM": `${cp(0xfeff)}${text}`,
    "trailing NBSP": `${text}${cp(0xa0)}`,
    "trailing U+2028": `${text}${cp(0x2028)}`,
  };
  for (const [label, candidate] of Object.entries(refused)) {
    assert.notEqual(candidate, text, label);
    await check(verifyReceiptText(candidate, pinnedA), "malformed", label);
  }
  // The same forged duplicate through JSON.parse alone would have carried the real payload.
  assert.equal(JSON.parse(refused["forged payload key prepended"]).payload, signed.payload);
});

test("verify: verifyReceiptText gives malformed for anything that is not an envelope", async () => {
  const garbage = [
    "",
    "not json",
    "{",
    "null",
    "42",
    '"text"',
    "[]",
    JSON.stringify([signed]),
    "{}",
    JSON.stringify({ payload: signed.payload }),
    JSON.stringify({ payload: signed.payload, signature: signed.signature }),
    JSON.stringify({ signature: signed.signature, key_id: signed.key_id }),
    JSON.stringify({ ...signed, payload: JSON.parse(signed.payload) }),
    JSON.stringify({ ...signed, key_id: null }),
  ];
  for (const text of garbage) await check(verifyReceiptText(text, pinnedA), "malformed", text.slice(0, 40));
  await check(verifyReceiptText(undefined, pinnedA), "malformed");
  await check(verifyReceiptText(42, pinnedA), "malformed");
});

test("verify: an inconsistent pinned pair throws, even behind malformed input", async () => {
  const mismatched = { keyId: B.keyId, publicKeyRaw: A.publicKeyRaw };
  await assert.rejects(verifyReceipt(signed, mismatched), TypeError);
  await assert.rejects(verifyReceiptText("garbage", mismatched), TypeError);
  await assert.rejects(verifyReceipt(signed, { keyId: A.keyId.toUpperCase(), publicKeyRaw: A.publicKeyRaw }), TypeError);
  await assert.rejects(verifyReceipt(signed, { keyId: A.keyId, publicKeyRaw: A.publicKeyRaw.subarray(1) }), TypeError);
  await assert.rejects(verifyReceipt(signed, { keyId: A.keyId, publicKeyRaw: Array.from(A.publicKeyRaw) }), TypeError);
  await assert.rejects(verifyReceipt(signed, null), TypeError);
});

test("verify: ok is true only for verified", () => {
  assert.ok(results.length > 50);
  for (const outcome of results) assert.equal(outcome.ok, outcome.reason === "verified");
  const reasons = new Set(results.map((outcome) => outcome.reason));
  assert.deepEqual([...reasons].sort(), ["invalid_signature", "malformed", "not_canonical", "unknown_key", "verified"]);
});

test("verify: keyIdOf agrees with the signer's key id", async () => {
  assert.equal(await keyIdOf(A.publicKeyRaw), A.keyId);
  assert.equal(await keyIdOf(B.publicKeyRaw), receiptKeyId(B.publicKeyRaw));
  await assert.rejects(keyIdOf(new Uint8Array(33)), TypeError);
});

test("verify: decodeBase64Url accepts only the one canonical unpadded encoding", () => {
  for (let length = 0; length <= 70; length++) {
    const bytes = Buffer.alloc(length, 0).map((_, i) => (i * 37 + length * 11) & 0xff);
    const encoded = bytes.toString("base64url");
    assert.deepEqual(decodeBase64Url(encoded), new Uint8Array(bytes), `length ${length}`);
  }
  assert.deepEqual(decodeBase64Url("-_8"), new Uint8Array([0xfb, 0xff]));
  for (const bad of ["A", "AAAAA", "AA==", "AA=", "+/8", "ab c", "AB", "AAB", "-_9"]) {
    assert.equal(decodeBase64Url(bad), null, bad);
  }
  assert.equal(decodeBase64Url(42), null);
});

// The verify library must load in a browser: see tests/receipts-support/module-graph.mjs.
test("verify: the built module graph is browser-safe", () => {
  assertBrowserSafe(join(DIST, "receipts", "verify", "index.js"));
});

test("verify: the scan would catch a node import (control)", () => {
  // The scanner itself must see the imports it is meant to forbid.
  const sign = moduleGraph(join(DIST, "receipts", "sign.js"));
  const specifiers = [...sign.values()].flatMap((entry) => entry.specifiers);
  assert.ok(specifiers.includes("node:crypto"), "sign.js imports node:crypto and the scan sees it");
  const custody = moduleGraph(join(DIST, "executor", "custody", "index.js"));
  assert.ok([...custody.values()].some((entry) => entry.specifiers.includes("node:crypto")));
  assert.throws(() => assertBrowserSafe(join(DIST, "receipts", "index.js")));
});
