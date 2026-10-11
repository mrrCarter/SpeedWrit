// RFC 8785 JSON Canonicalization Scheme (JCS) for the subset that signed and hashed JSON may hold:
// strings, safe integers, booleans, null, arrays and plain objects.
//
// This module has no imports, so the browser verify library can share it with the signer.
//
// Rejected, each with a JcsError naming the path:
// - numbers that are not safe integers: floats, NaN, Infinity, and integers beyond 2^53 - 1;
//   probabilities travel as basis points instead (spec, "No floats");
// - undefined, functions, symbols and BigInt;
// - Dates, Maps, Buffers, typed arrays, class instances, and any object whose prototype is not
//   Object.prototype or null;
// - objects with symbol keys, cyclic structures, and sparse array holes;
// - strings or keys holding a lone UTF-16 surrogate, which UTF-8 cannot represent.
//
// Duplicate keys cannot occur in a JavaScript object, so there is nothing to reject at this layer.
// JSON.parse keeps the last of any duplicates, which is why a verifier must also check that
// canonicalize(JSON.parse(payload)) === payload: text with duplicate keys never re-canonicalizes to
// itself.
//
// A JavaScript number cannot tell 1 from 1.0, so 1.0 is accepted and written as 1. -0 is written as
// 0, as RFC 8785 requires.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export class JcsError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`JCS: ${problem} at ${path}`);
    this.name = "JcsError";
    this.path = path;
  }
}

/** Returns the RFC 8785 canonical JSON text of `value`, or throws JcsError. */
export function canonicalize(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

/** Orders two strings by their UTF-16 code units, as RFC 8785 section 3.2.3 requires. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "object":
      return serializeContainer(value, path, ancestors);
    default:
      // undefined, function, symbol, bigint
      throw new JcsError(path, `${typeof value} is not allowed`);
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new JcsError(path, `number ${String(value)} is not a safe integer`);
  }
  // String(-0) is "0", and every safe integer prints as plain decimal digits.
  return String(value);
}

function serializeString(value: string, path: string): string {
  assertWellFormed(value, path);
  // For a well-formed string, ES2019+ JSON.stringify escapes exactly what RFC 8785 section 3.2.2.2
  // requires: \b \t \n \f \r \" \\ by name, other code units below U+0020 as \u00hh in lowercase
  // hex, and everything else (including U+007F and all non-ASCII) as the literal character.
  return JSON.stringify(value);
}

/** True when `value` has no lone UTF-16 surrogate, so it encodes to UTF-8 without loss. */
export function isWellFormed(value: string): boolean {
  return loneSurrogateIndex(value) < 0;
}

function loneSurrogateIndex(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return i;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return i;
  }
  return -1;
}

function assertWellFormed(value: string, path: string): void {
  const index = loneSurrogateIndex(value);
  if (index >= 0) throw new JcsError(path, `lone surrogate at index ${index}`);
}

function serializeContainer(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new JcsError(path, "cyclic structure");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return serializeArray(value, path, ancestors);
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
      throw new JcsError(path, `${typeof name === "string" ? name : "non-plain object"} is not a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new JcsError(path, "symbol keys are not allowed");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const members: string[] = [];
    for (const key of keys) {
      const memberPath = `${path}.${key}`;
      assertWellFormed(key, memberPath);
      members.push(`${JSON.stringify(key)}:${serialize(record[key], memberPath, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(value: unknown[], path: string, ancestors: Set<object>): string {
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) throw new JcsError(`${path}[${i}]`, "sparse array hole");
    items.push(serialize(value[i], `${path}[${i}]`, ancestors));
  }
  return `[${items.join(",")}]`;
}
