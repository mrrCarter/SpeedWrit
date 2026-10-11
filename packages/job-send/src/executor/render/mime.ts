import { isWellFormed } from "../jcs.js";
import { isAddrSpec } from "./address.js";
import { RenderError } from "./errors.js";

// The executor writes every header. A message is plain text only:
//
//   From: <addr-spec>
//   To: <addr-spec>
//   Subject: <printable ASCII, or RFC 2047 B-encoded UTF-8 folded onto continuation lines>
//   MIME-Version: 1.0
//   Content-Type: text/plain; charset=UTF-8
//   Content-Transfer-Encoding: base64
//   X-Writ-Version: <16 lowercase hex>      (only when versionTag is given)
//
// followed by an empty line and the base64 of the CRLF-normalized UTF-8 body, 76 characters per
// line. Every line ends in CRLF and the output is pure ASCII. Gmail adds Date and Message-ID.

export const BODY_LINE_LENGTH = 76;

/** Longest raw subject: "Subject: " plus the value stays within the 78-character line advice. */
const MAX_RAW_SUBJECT = 78 - "Subject: ".length;
/** Printable ASCII with no leading or trailing space, which unstructured header parsing would drop. */
const RAW_SUBJECT = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
/**
 * UTF-8 bytes per encoded-word. 39 bytes is 52 base64 characters, so "Subject: " (9) plus
 * "=?UTF-8?B?" (10) plus 52 plus "?=" (2) is 73, inside RFC 2047's 76-character limit for a line
 * that carries an encoded-word, and each word stays under its 75-character cap.
 */
const MAX_WORD_BYTES = 39;
const VERSION_TAG = /^[0-9a-f]{16}$/;

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** First 16 lowercase hex characters of a version hash, written as X-Writ-Version. */
  versionTag?: string;
}

/** Rewrites every CRLF, lone CR and lone LF as CRLF. */
export function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n");
}

/** Throws header_injection when a header value holds CR, LF or NUL. */
export function assertHeaderValue(header: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new RenderError("header_injection", `${header} contains CR, LF or NUL`, header);
  }
}

/**
 * The Subject header value. Short printable ASCII without "=?" is written as is. Anything else is
 * written as RFC 2047 B-encoded UTF-8 words joined by CRLF + space, and no word splits a code point.
 */
export function encodeSubject(subject: string): string {
  if (subject === "") return "";
  if (subject.length <= MAX_RAW_SUBJECT && RAW_SUBJECT.test(subject) && !subject.includes("=?")) {
    return subject;
  }
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
    chunk = [];
  };
  for (const char of subject) {
    const bytes = Buffer.from(char, "utf8");
    if (chunk.length + bytes.length > MAX_WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  if (chunk.length > 0) flush();
  return words.join("\r\n ");
}

/** Builds the message bytes. Throws RenderError on any header or address problem. */
export function buildMime(input: MimeInput): Uint8Array {
  const { from, to, subject, body, versionTag } = input;
  for (const [header, value] of [["From", from], ["To", to], ["Subject", subject], ["Body", body]] as const) {
    if (typeof value !== "string") throw new RenderError("invalid_text", `${header} must be a string`, header);
  }
  assertHeaderValue("From", from);
  assertHeaderValue("To", to);
  assertHeaderValue("Subject", subject);
  if (versionTag !== undefined) assertHeaderValue("X-Writ-Version", versionTag);

  if (!isAddrSpec(from)) throw new RenderError("invalid_address", "From must be exactly one address", "From");
  if (!isAddrSpec(to)) throw new RenderError("invalid_address", "To must be exactly one address", "To");
  if (!isWellFormed(subject)) throw new RenderError("invalid_text", "Subject has a lone surrogate", "Subject");
  if (!isWellFormed(body)) throw new RenderError("invalid_text", "Body has a lone surrogate", "Body");
  if (versionTag !== undefined && !VERSION_TAG.test(versionTag)) {
    throw new RenderError("invalid_version_tag", "X-Writ-Version must be 16 lowercase hex", "X-Writ-Version");
  }

  const encodedSubject = encodeSubject(subject);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    encodedSubject === "" ? "Subject:" : `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (versionTag !== undefined) headers.push(`X-Writ-Version: ${versionTag}`);

  const base64 = Buffer.from(toCrlf(body), "utf8").toString("base64");
  let bodyLines = "";
  for (let i = 0; i < base64.length; i += BODY_LINE_LENGTH) {
    bodyLines += `${base64.slice(i, i + BODY_LINE_LENGTH)}\r\n`;
  }

  const message = `${headers.join("\r\n")}\r\n\r\n${bodyLines}`;
  if (!/^[\x00-\x7f]*$/.test(message)) {
    throw new RenderError("invalid_text", "message is not pure ASCII");
  }
  return new Uint8Array(Buffer.from(message, "ascii"));
}

/** Gmail's `raw` field: base64url of the message bytes, without padding. */
export function gmailRaw(mime: Uint8Array): string {
  return Buffer.from(mime.buffer, mime.byteOffset, mime.byteLength).toString("base64url");
}
