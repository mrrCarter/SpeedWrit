import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

// The public pin independently observed in the deployed owner app.
const KEY_ID = "8d7fe1becc5eff89";
const PUBLIC_KEY = "6W0fJX_idGEHGl01LJqp8V6_3kVHXKrZ8-yQWzLvx3s";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(Buffer.from(PUBLIC_KEY, "base64url")).slice(0, 16), KEY_ID);
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: PUBLIC_KEY }, format: "jwk" });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);

for (const entry of manifest.files) {
  assert.match(entry.file, /^receipts\/rcp_[A-Za-z0-9_-]+\.json$/);
  const bytes = readFileSync(new URL(entry.file, import.meta.url));
  assert.equal(sha256(bytes), entry.sha256, `${entry.file}: file hash differs`);
  const envelope = JSON.parse(bytes);
  assert.equal(envelope.key_id, KEY_ID);
  const payload = Buffer.from(envelope.payload, "utf8");
  const receipt = JSON.parse(envelope.payload);
  assert.equal(receipt.id, entry.receipt_id);
  assert.equal(receipt.type, entry.type);
  const signature = Buffer.from(envelope.signature, "base64url");
  assert.ok(verify(null, payload, key, signature), `${entry.receipt_id}: invalid signature`);

  // Change one ASCII byte in the receipt ID, preserving JSON and the signature.
  // This is an in-memory negative control; the exported receipt stays untouched.
  const needle = Buffer.from(JSON.stringify(receipt.id));
  const start = payload.indexOf(needle);
  assert.ok(start >= 0);
  const altered = Buffer.from(payload);
  const index = start + needle.length - 2;
  altered[index] = altered[index] === 88 ? 89 : 88;
  JSON.parse(altered.toString("utf8"));
  assert.equal(verify(null, altered, key, signature), false, `${entry.receipt_id}: altered control accepted`);
  console.log(`${entry.receipt_id} ${receipt.type}: signature verified; one-byte control rejected`);
}

console.log(`${manifest.files.length} original signatures verified. No network requests were made.`);
