import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";

/** Lowercase hex SHA-256 of `data`. A string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

/** sha256(JCS(value)): the spec's hash for job authority and proposal versions. */
export function canonicalSha256Hex(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
