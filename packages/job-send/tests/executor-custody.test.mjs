import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";

import { CUSTODY_KEY_BYTES, CustodyError, createTokenCustody, custodyKeyFromSecret } from "../dist/index.js";

const REFRESH_TOKEN = "1//0gExampleRefreshToken-not-real_ABCdef123";
const failsWith = (code) => (error) => error instanceof CustodyError && error.code === code;

function envelopeBytes(envelope) {
  assert.match(envelope, /^v1\.[A-Za-z0-9_-]+$/);
  return Buffer.from(envelope.slice(3), "base64url");
}
const toEnvelope = (bytes) => `v1.${Buffer.from(bytes).toString("base64url")}`;

test("custody: seal then open round-trips, and the envelope hides the token", () => {
  const custody = createTokenCustody(randomBytes(32));
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  assert.equal(custody.open("con_gmail_1", envelope), REFRESH_TOKEN);
  assert.equal(envelope.includes(REFRESH_TOKEN), false);
  assert.equal(envelopeBytes(envelope).includes(Buffer.from(REFRESH_TOKEN)), false);
  // nonce (12) + ciphertext (same length as the UTF-8 plaintext) + tag (16)
  assert.equal(envelopeBytes(envelope).byteLength, 12 + Buffer.byteLength(REFRESH_TOKEN) + 16);

  for (const plaintext of ["", "é☕😀", "x".repeat(4096)]) {
    assert.equal(custody.open("con_gmail_1", custody.seal("con_gmail_1", plaintext)), plaintext);
  }
});

test("custody: a different key cannot open the record", () => {
  const key = randomBytes(32);
  const envelope = createTokenCustody(key).seal("con_gmail_1", REFRESH_TOKEN);
  const otherKey = Buffer.from(key);
  otherKey[0] ^= 0x01;
  assert.throws(() => createTokenCustody(otherKey).open("con_gmail_1", envelope), failsWith("decrypt_failed"));
  assert.throws(() => createTokenCustody(randomBytes(32)).open("con_gmail_1", envelope), failsWith("decrypt_failed"));
});

test("custody: a record moved to another connection id does not open (AAD)", () => {
  const custody = createTokenCustody(randomBytes(32));
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  for (const other of ["con_gmail_2", "con_gmail_10", "con_gmail_", "CON_GMAIL_1", "con_gmail_1 "]) {
    assert.throws(() => custody.open(other, envelope), failsWith("decrypt_failed"), other);
  }
  assert.equal(custody.open("con_gmail_1", envelope), REFRESH_TOKEN);
});

test("custody: any changed byte fails, in the nonce, the ciphertext or the tag", () => {
  const custody = createTokenCustody(randomBytes(32));
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  const bytes = envelopeBytes(envelope);
  for (let i = 0; i < bytes.byteLength; i++) {
    const tampered = Buffer.from(bytes);
    tampered[i] ^= 0x80;
    assert.throws(() => custody.open("con_gmail_1", toEnvelope(tampered)), failsWith("decrypt_failed"), `byte ${i}`);
  }
  assert.throws(() => custody.open("con_gmail_1", toEnvelope(bytes.subarray(0, bytes.byteLength - 1))), CustodyError);
  assert.throws(() => custody.open("con_gmail_1", toEnvelope(Buffer.concat([bytes, Buffer.from([0])]))), CustodyError);
});

test("custody: malformed envelopes are refused before decryption", () => {
  const custody = createTokenCustody(randomBytes(32));
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  for (const bad of [envelope.replace(/^v1\./, "v2."), envelope.slice(3), `${envelope}=`, `${envelope.slice(0, -1)}+`, "v1.", "v1.AAAA", 42, null]) {
    assert.throws(() => custody.open("con_gmail_1", bad), failsWith("malformed_envelope"), String(bad));
  }
  assert.throws(() => custody.seal("", REFRESH_TOKEN), failsWith("invalid_input"));
  assert.throws(() => custody.open("", envelope), failsWith("invalid_input"));
  assert.throws(() => custody.seal("con_gmail_1", Buffer.from("x")), failsWith("invalid_input"));
});

test("custody: nonces are unique across 1000 encryptions", () => {
  const custody = createTokenCustody(randomBytes(32));
  const nonces = new Set();
  const envelopes = new Set();
  for (let i = 0; i < 1000; i++) {
    const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
    envelopes.add(envelope);
    nonces.add(envelopeBytes(envelope).subarray(0, 12).toString("hex"));
  }
  assert.equal(nonces.size, 1000);
  assert.equal(envelopes.size, 1000);
});

test("custody: the key must be exactly 32 bytes", () => {
  assert.equal(CUSTODY_KEY_BYTES, 32);
  for (const bad of [Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(64)]) {
    assert.throws(() => createTokenCustody(bad), failsWith("invalid_key"), `${bad.byteLength} bytes`);
  }
  for (const bad of ["a".repeat(32), null, undefined, Array.from({ length: 32 }, () => 1), new ArrayBuffer(32)]) {
    assert.throws(() => createTokenCustody(bad), failsWith("invalid_key"));
  }
  assert.ok(createTokenCustody(new Uint8Array(32)));
});

test("custody: the caller's key buffer is copied, and the object shows no secret", () => {
  const key = randomBytes(32);
  const keyHex = key.toString("hex");
  const custody = createTokenCustody(key);
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  key.fill(0);
  assert.equal(custody.open("con_gmail_1", envelope), REFRESH_TOKEN);
  assert.equal(JSON.stringify({ custody }), '{"custody":"[TokenCustody]"}');
  const shown = inspect(custody, { depth: 5, showHidden: true });
  assert.equal(shown.includes(keyHex), false);
  assert.ok(Object.isFrozen(custody));
});

test("custody: errors never carry the plaintext or the envelope", () => {
  const custody = createTokenCustody(randomBytes(32));
  const envelope = custody.seal("con_gmail_1", REFRESH_TOKEN);
  try {
    custody.open("con_gmail_2", envelope);
    assert.fail("expected a failure");
  } catch (error) {
    assert.ok(error instanceof CustodyError);
    assert.equal(String(error.message).includes(REFRESH_TOKEN), false);
    assert.equal(String(error.message).includes(envelope.slice(3, 20)), false);
    assert.equal(error.cause, undefined);
  }
});

test("custody: custodyKeyFromSecret decodes a 32-byte base64 or base64url secret", () => {
  const key = randomBytes(32);
  assert.deepEqual(Buffer.from(custodyKeyFromSecret(key.toString("base64"))), key);
  assert.deepEqual(Buffer.from(custodyKeyFromSecret(key.toString("base64url"))), key);
  assert.deepEqual(Buffer.from(custodyKeyFromSecret(` ${key.toString("base64")}\n`)), key);
  for (const bad of [randomBytes(31).toString("base64"), randomBytes(33).toString("base64"), "not base64!", "", 42]) {
    assert.throws(() => custodyKeyFromSecret(bad), failsWith("invalid_key"), String(bad));
  }
});
