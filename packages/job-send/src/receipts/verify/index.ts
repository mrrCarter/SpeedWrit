// Browser-safe entry point. Keep this graph free of node:* and of the signing and custody modules;
// tests/receipts-verify.test.mjs scans the built JavaScript to hold that line.
export { decodeBase64Url } from "./base64url.js";
export {
  keyIdOf,
  receiptEnvelopeText,
  verifyReceipt,
  verifyReceiptText,
  type Pinned,
  type VerifyReason,
  type VerifyResult,
} from "./verify.js";
