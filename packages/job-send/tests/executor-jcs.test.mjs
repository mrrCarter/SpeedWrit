import assert from "node:assert/strict";
import test from "node:test";

import { JcsError, canonicalSha256Hex, canonicalize, sha256Hex } from "../dist/index.js";

// Non-ASCII characters and backslashes are built from code points so this file's bytes cannot
// change what a test means.
const cp = (...points) => String.fromCodePoint(...points);
const BS = cp(0x5c);

test("JCS: RFC 8785 section 3.2.3 property sorting uses UTF-16 code units", () => {
  // The RFC's sorting example. U+1F600 (surrogates D83D DE00) sorts before U+FB33 in UTF-16 order,
  // though it would sort after it in code point order.
  assert.ok(cp(0x1f600) < cp(0xfb33));
  const input = {
    [cp(0x20ac)]: "Euro Sign",
    [cp(0x0d)]: "Carriage Return",
    [cp(0xfb33)]: "Hebrew Letter Dalet With Dagesh",
    1: "One",
    [cp(0x1f600)]: "Emoji: Grinning Face",
    [cp(0x80)]: "Control",
    [cp(0xf6)]: "Latin Small Letter O With Diaeresis",
  };
  assert.equal(
    canonicalize(input),
    `{"${BS}r":"Carriage Return","1":"One","${cp(0x80)}":"Control","${cp(0xf6)}":"Latin Small Letter O With Diaeresis",` +
      `"${cp(0x20ac)}":"Euro Sign","${cp(0x1f600)}":"Emoji: Grinning Face","${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`,
  );
});

// RFC 8785 section 3.2.2.2, the string example: the JSON text exactly as the RFC prints it, escapes and all,
const RFC_STRING_TEXT = `"${BS}u20ac$${BS}u000F${BS}u000aA'${BS}u0042${BS}u0022${BS}u005c${BS}${BS}${BS}"${BS}/"`;
// and the canonical text the RFC gives for it.
const RFC_STRING_CANONICAL = `"${cp(0x20ac)}$${BS}u000f${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"`;

test("JCS: RFC 8785 section 3.2.2.2 string escaping", () => {
  const value = JSON.parse(RFC_STRING_TEXT);
  assert.equal(value, `${cp(0x20ac)}$${cp(0x0f, 0x0a)}A'B"${BS}${BS}"/`);
  assert.equal(canonicalize(value), RFC_STRING_CANONICAL);
});

test("JCS: the RFC 8785 sample object, restricted to our subset", () => {
  const input = JSON.parse(`{ "string": ${RFC_STRING_TEXT}, "literals": [null, true, false] }`);
  assert.equal(canonicalize(input), `{"literals":[null,true,false],"string":${RFC_STRING_CANONICAL}}`);
});

test("JCS: every control character escapes as RFC 8785 requires", () => {
  const named = { 8: "b", 9: "t", 10: "n", 12: "f", 13: "r" };
  for (let code = 0; code < 0x20; code++) {
    const escape = named[code] ?? `u${code.toString(16).padStart(4, "0")}`;
    assert.equal(canonicalize(cp(code)), `"${BS}${escape}"`, `U+${code.toString(16)}`);
  }
  for (const literal of [cp(0x7f), cp(0x80), cp(0x9f), cp(0x2028), cp(0x2029), cp(0xfeff), "/"]) {
    assert.equal(canonicalize(literal), `"${literal}"`, `U+${literal.codePointAt(0).toString(16)}`);
  }
  assert.equal(canonicalize(`"${BS}`), `"${BS}"${BS}${BS}"`);
});

test("JCS: integers, literals, nesting and empty containers", () => {
  assert.equal(canonicalize(0), "0");
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize(-17), "-17");
  assert.equal(canonicalize(Number.MAX_SAFE_INTEGER), "9007199254740991");
  assert.equal(canonicalize(Number.MIN_SAFE_INTEGER), "-9007199254740991");
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
  assert.equal(canonicalize([]), "[]");
  assert.equal(canonicalize({}), "{}");
  assert.equal(canonicalize({ b: [1, { d: null, c: "x" }], a: {} }), '{"a":{},"b":[1,{"c":"x","d":null}]}');
  assert.equal(canonicalize(Object.assign(Object.create(null), { z: 1, y: 2 })), '{"y":2,"z":1}');
});

test("JCS: rejects floats, NaN, infinities and unsafe integers", () => {
  for (const value of [1.5, -0.25, 0.1, 1e-7, Number.NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 1e21]) {
    assert.throws(() => canonicalize(value), JcsError, String(value));
    assert.throws(() => canonicalize({ detail: { p: value } }), (error) => error instanceof JcsError && error.path === "$.detail.p");
  }
});

test("JCS: rejects undefined, functions, symbols, BigInt and non-plain objects", () => {
  class Thing {}
  const rejected = [
    undefined,
    () => 1,
    Symbol("s"),
    1n,
    new Date(0),
    new Map(),
    new Set(),
    new Thing(),
    new Uint8Array(2),
    Buffer.from("x"),
    /re/,
    new String("boxed"),
    new Number(1),
  ];
  for (const value of rejected) {
    assert.throws(() => canonicalize(value), JcsError);
    assert.throws(() => canonicalize({ k: value }), JcsError);
    assert.throws(() => canonicalize([value]), JcsError);
  }
  assert.throws(() => canonicalize({ [Symbol("k")]: 1 }), JcsError);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalize([1, , 3]), JcsError);
});

test("JCS: rejects lone surrogates in values and keys", () => {
  for (const bad of ["\ud800", "\udc00", "a\ud83d", "\ude00b", "\ud83d\ud83d"]) {
    assert.throws(() => canonicalize(bad), JcsError, JSON.stringify(bad));
    assert.throws(() => canonicalize({ [bad]: 1 }), JcsError);
  }
  assert.equal(canonicalize("😀"), '"😀"');
});

test("JCS: rejects cycles but allows shared references", () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), JcsError);
  const shared = { x: 1 };
  assert.equal(canonicalize({ a: shared, b: [shared] }), '{"a":{"x":1},"b":[{"x":1}]}');
});

test("JCS: key insertion order never changes the bytes", () => {
  const one = { v: 1, job_id: "job_1", nested: { z: [1, 2], a: "é", m: null }, flag: true };
  const two = { flag: true, nested: { m: null, a: "é", z: [1, 2] }, job_id: "job_1", v: 1 };
  assert.equal(canonicalize(one), canonicalize(two));
  assert.equal(canonicalSha256Hex(one), canonicalSha256Hex(two));
  assert.equal(canonicalize(one), '{"flag":true,"job_id":"job_1","nested":{"a":"é","m":null,"z":[1,2]},"v":1}');
  // Canonical text parses back to itself.
  assert.equal(canonicalize(JSON.parse(canonicalize(one))), canonicalize(one));
});

test("JCS: sha256Hex hashes UTF-8 bytes", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(new Uint8Array([0x61, 0x62, 0x63])), sha256Hex("abc"));
  assert.equal(canonicalSha256Hex({ b: 1, a: 2 }), sha256Hex('{"a":2,"b":1}'));
});
