// Builds the owner app into dist/owner-app/: app.js (one ES module, minified) and index.html. The receipt key is
// compiled in from RECEIPT_KEY_ID (16 lowercase hex) and RECEIPT_PUBLIC_KEY_B64URL (the raw 32-byte Ed25519 public
// key, base64url). Serve both files under /owner-app/, plus /owner-app/config.json, with
//   Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
// (the app posts no forms; sign-out is the one, and it stays on this site).
// It also writes receipt-key.json (never served): the key compiled in, so serveOwnerApp can refuse to start
// beside a service that signs with another key.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/owner-app");
const keyId = process.env.RECEIPT_KEY_ID ?? "";
const publicKey = process.env.RECEIPT_PUBLIC_KEY_B64URL ?? "";
if (!/^[0-9a-f]{16}$/.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) {
  console.error("Set RECEIPT_KEY_ID (16 lowercase hex) and RECEIPT_PUBLIC_KEY_B64URL (43 base64url characters).");
  process.exit(1);
}
// The id is the first 16 hex of sha256(raw public key), as the receipts compute it: an id that names another key
// would match the service's id while the page checks against the wrong key.
const idOfKey = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
if (idOfKey !== keyId) {
  console.error(`RECEIPT_KEY_ID ${keyId} is not the id of RECEIPT_PUBLIC_KEY_B64URL (whose id is ${idOfKey}).`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: [resolve(root, "src/app/main.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  metafile: true,
  outfile: resolve(out, "app.js"),
  define: {
    __RECEIPT_KEY_ID__: JSON.stringify(keyId),
    __RECEIPT_PUBLIC_KEY_B64URL__: JSON.stringify(publicKey),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
const inputs = Object.keys(result.metafile.inputs);
const offending = inputs.filter((input) => /react-dom[\\/]server|job-send[\\/](dist[\\/])?(server|owner|oauth|executor[\\/]custody|receipts[\\/]sign)/.test(input));
if (offending.length > 0) {
  console.error(`the browser bundle reached server-side modules:\n${offending.join("\n")}`);
  process.exit(1);
}
const stylesheet = Object.keys(result.metafile.outputs).some((name) => resolve(name) === resolve(out, "app.css"))
  ? '<link rel="stylesheet" href="/owner-app/app.css">' : "";
writeFileSync(
  resolve(out, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>SpeedWrit</title>' + stylesheet + '<script type="module" src="/owner-app/app.js"></script></head><body><div id="root"></div></body></html>\n',
);
writeFileSync(resolve(out, "receipt-key.json"), `${JSON.stringify({ key_id: keyId, public_key_b64url: publicKey })}\n`);
console.log(`built ${out}: ${inputs.length} inputs, key ${keyId}`);
