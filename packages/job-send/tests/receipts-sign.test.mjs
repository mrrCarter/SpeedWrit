import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import test from "node:test";

import {
  JcsError,
  RECEIPT_TYPES,
  ReceiptError,
  buildReceipt,
  canonicalize,
  exportRawPublicKey,
  generateReceiptKeyPair,
  receiptEnvelopeText,
  receiptKeyId,
  receiptTimestamp,
  signReceipt,
  verifyReceiptText,
} from "../dist/index.js";
import { RECEIPT_TYPES as CONTRACT_RECEIPT_TYPES } from "../dist/contract/types.js";
import { RECEIPT_TYPES as RECEIPTS_RECEIPT_TYPES } from "../dist/receipts/types.js";

const SPEC_TYPES = [
  "CONNECTION_CREATED",
  "AGENT_CONNECTED",
  "JOB_CONFIRMED",
  "ATTEMPT_DENIED",
  "PROPOSAL_CREATED",
  "PROPOSAL_REVISED",
  "AI_REVIEW",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "APPROVAL_REFUSED",
  "DISPATCH_RESERVED",
  "DISPATCH_REFUSED",
  "PROVIDER_ACCEPTED",
  "NOT_SENT",
  "OUTCOME_UNKNOWN",
  "OUTCOME_RESOLVED",
  "DELIVERY_WITNESSED",
  "STOP_ENGAGED",
  "PROVIDER_REVOKE_REQUESTED",
  "PROVIDER_REVOKE_RESULT",
  // Not in the spec's receipt table yet: the owner API's revoke route needs a receipt (migration 0004).
  "AGENT_REVOKED",
];

const VERSION_SHA = "f6f73d21d67352a54c8ee029105e21ac839e1f168947e81f785df34e0bf0a525";

function accepted(overrides = {}) {
  return {
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
    version_sha256: VERSION_SHA,
    detail: { provider: "gmail", provider_message_id: "18c2f0a1b2c3d4e5" },
    prev_sha256: null,
    ...overrides,
  };
}

const independentKeyId = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 16);

test("receipts: the type list is the spec's, and it is the contract's one list", () => {
  assert.deepEqual([...RECEIPT_TYPES], SPEC_TYPES);
  // One list: the receipts module re-exports the contract's array itself, not a copy.
  assert.equal(RECEIPTS_RECEIPT_TYPES, CONTRACT_RECEIPT_TYPES);
  assert.equal(RECEIPT_TYPES, CONTRACT_RECEIPT_TYPES);
});

test("receipts: buildReceipt fills every key and keeps the spec's shape", () => {
  const receipt = buildReceipt({ id: "rcp_1", seq: 1, type: "STOP_ENGAGED", ts: "2026-10-11T19:04:11Z", owner: "own_1" });
  assert.deepEqual(receipt, {
    v: 1,
    id: "rcp_1",
    seq: 1,
    type: "STOP_ENGAGED",
    ts: "2026-10-11T19:04:11Z",
    owner: "own_1",
    job: null,
    policy_version: null,
    agent_connection: null,
    client_label: null,
    proposal: null,
    version: null,
    version_sha256: null,
    detail: {},
    prev_sha256: null,
  });
  const full = buildReceipt(accepted());
  assert.equal(full.v, 1);
  assert.deepEqual(buildReceipt(full), full, "a built receipt builds to itself");
  assert.equal(buildReceipt(accepted({ ts: "2026-10-11T19:04:11.123Z" })).ts, "2026-10-11T19:04:11.123Z");
  for (const type of SPEC_TYPES) assert.equal(buildReceipt(accepted({ type })).type, type);
});

test("receipts: detail is copied, so later changes to the caller's object do not leak in", () => {
  const detail = { flags: ["commitment"], probs_bp: { commitment: 4100 } };
  const receipt = buildReceipt(accepted({ type: "AI_REVIEW", detail }));
  detail.flags.push("hostile_tone");
  detail.probs_bp.commitment = 1;
  assert.deepEqual(receipt.detail, { flags: ["commitment"], probs_bp: { commitment: 4100 } });
});

test("receipts: a float anywhere in detail throws at build", () => {
  for (const detail of [{ p: 0.41 }, { probs_bp: { commitment: 4100.5 } }, { list: [1, 2.5] }, { n: Number.NaN }, { n: Infinity }, { n: 2 ** 53 }]) {
    assert.throws(() => buildReceipt(accepted({ detail })), JcsError, JSON.stringify(detail));
    assert.throws(() => signReceipt(generateReceiptKeyPair().privateKey, accepted({ detail })), JcsError);
  }
  for (const detail of [{ d: new Date(0) }, { u: undefined }, { b: 1n }]) {
    assert.throws(() => buildReceipt(accepted({ detail })), JcsError);
  }
  assert.deepEqual(buildReceipt(accepted({ detail: { probs_bp: { commitment: 4100 } } })).detail, { probs_bp: { commitment: 4100 } });
});

test("receipts: buildReceipt rejects malformed fields", () => {
  const bad = {
    id: ["", "rcp_", "rcp_has space", "receipt_1", 7],
    seq: [-1, 1.5, Number.NaN, "17", 2 ** 53],
    type: ["SENT", "provider_accepted", undefined],
    ts: ["2026-10-11T19:04:11+00:00", "2026-10-11 19:04:11Z", "2026-02-30T00:00:00Z", "2026-10-11T24:00:00Z", "2026-10-11T19:04Z", 0],
    owner: ["", null, undefined],
    job: ["", 5],
    policy_version: [0, -1, 1.5, "1"],
    version: [0, 2.5],
    version_sha256: [VERSION_SHA.toUpperCase(), VERSION_SHA.slice(1), "x".repeat(64)],
    prev_sha256: ["abc"],
    client_label: [42],
    detail: [[], "x", null],
    v: [2, "1"],
  };
  for (const [field, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.throws(() => buildReceipt(accepted({ [field]: value })), ReceiptError, `${field}=${String(value)}`);
    }
  }
  assert.throws(() => buildReceipt(accepted({ extra: "x" })), ReceiptError);
  assert.throws(() => buildReceipt(null), ReceiptError);
});

test("receipts: receiptTimestamp is UTC to the second", () => {
  assert.equal(receiptTimestamp(new Date(Date.UTC(2026, 9, 11, 19, 4, 11, 789))), "2026-10-11T19:04:11Z");
  assert.match(receiptTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("receipts: sign produces the JCS payload, an Ed25519 signature and the key id", () => {
  const pair = generateReceiptKeyPair();
  const signed = signReceipt(pair.privateKey, accepted());
  assert.deepEqual(Object.keys(signed).sort(), ["key_id", "payload", "signature"]);
  assert.equal(signed.payload, canonicalize(buildReceipt(accepted())));
  assert.ok(signed.payload.startsWith('{"agent_connection":"ac_chatgpt_1","client_label":"ChatGPT (declared)","detail":{'));
  assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(Buffer.from(signed.signature, "base64url").byteLength, 64);
  assert.ok(nodeVerify(null, Buffer.from(signed.payload, "utf8"), pair.publicKey, Buffer.from(signed.signature, "base64url")));
  // Ed25519 is deterministic: the same receipt and key give the same signature.
  assert.equal(signReceipt(pair.privateKey, accepted()).signature, signed.signature);
  // A PEM private key signs identically.
  assert.deepEqual(signReceipt(pair.privateKeyPem, accepted()), signed);
});

test("receipts: a signed receipt is shared as its envelope text, which verifies as is", async () => {
  const pair = generateReceiptKeyPair();
  const signed = signReceipt(pair.privateKey, accepted());
  const text = receiptEnvelopeText(signed);
  assert.equal(text, canonicalize({ key_id: signed.key_id, payload: signed.payload, signature: signed.signature }));
  assert.deepEqual(JSON.parse(text), signed);
  const pinned = { keyId: pair.keyId, publicKeyRaw: pair.publicKeyRaw };
  assert.deepEqual(await verifyReceiptText(text, pinned), { ok: true, reason: "verified" });
  assert.deepEqual(await verifyReceiptText(JSON.stringify(signed), pinned), { ok: false, reason: "malformed" });
});

test("receipts: key_id is the first 16 hex of sha256(raw 32-byte public key)", () => {
  const pair = generateReceiptKeyPair();
  assert.equal(pair.publicKeyRaw.byteLength, 32);
  // Independent derivation: the raw key is the last 32 bytes of the SPKI DER encoding.
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  assert.deepEqual(Buffer.from(pair.publicKeyRaw), spki.subarray(spki.byteLength - 32));
  assert.match(pair.keyId, /^[0-9a-f]{16}$/);
  assert.equal(pair.keyId, independentKeyId(pair.publicKeyRaw));
  assert.equal(receiptKeyId(pair.publicKeyRaw), pair.keyId);
  assert.equal(signReceipt(pair.privateKey, accepted()).key_id, pair.keyId);
  for (const source of [pair.publicKey, pair.privateKey, pair.publicKeyPem, pair.privateKeyPem, createPrivateKey(pair.privateKeyPem)]) {
    assert.deepEqual(exportRawPublicKey(source), pair.publicKeyRaw);
  }
  assert.throws(() => receiptKeyId(new Uint8Array(31)), TypeError);
  assert.notEqual(generateReceiptKeyPair().keyId, pair.keyId);
});

test("receipts: only an Ed25519 private key signs", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const x25519 = generateKeyPairSync("x25519");
  const ed = generateReceiptKeyPair();
  for (const key of [ec.privateKey, x25519.privateKey, ed.publicKey]) {
    assert.throws(() => signReceipt(key, accepted()), TypeError);
  }
  assert.throws(() => exportRawPublicKey(ec.publicKey), TypeError);
});
