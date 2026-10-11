import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderError,
  buildMime,
  canonicalize,
  fill,
  gmailRaw,
  normalizeAddress,
  normalizeRecipient,
  placeholderNames,
  render,
  sha256Hex,
  storedVersionIntact,
  templateSha256,
  versionSha256,
} from "../dist/index.js";

// Golden values were computed with Python's base64, hashlib and json modules, independently of
// this package and of Node's Buffer.
const TEMPLATE = Object.freeze({
  id: "tpl_recap",
  sha256: "c2473760b60bfdae9e7580c436dd56964e7c88ecbc7d147016e02b97a4499724",
  subject_tpl: "Recap: {{topic}}",
  body_tpl: "Hi {{first_name}},\n\nThanks for the {{topic}}. Here is the recap:\n\n{{recap}}\n\nBest,\nOwner",
});

const FIELDS = Object.freeze({
  first_name: "Dana",
  topic: "onboarding call",
  recap: "We agreed to start the pilot Monday, and I'll send the checklist by Friday.",
});

const GOLDEN_MIME =
  "From: owner@example.com\r\n" +
  "To: dana@test.example\r\n" +
  "Subject: Recap: onboarding call\r\n" +
  "MIME-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=UTF-8\r\n" +
  "Content-Transfer-Encoding: base64\r\n" +
  "\r\n" +
  "SGkgRGFuYSwNCg0KVGhhbmtzIGZvciB0aGUgb25ib2FyZGluZyBjYWxsLiBIZXJlIGlzIHRoZSBy\r\n" +
  "ZWNhcDoNCg0KV2UgYWdyZWVkIHRvIHN0YXJ0IHRoZSBwaWxvdCBNb25kYXksIGFuZCBJJ2xsIHNl\r\n" +
  "bmQgdGhlIGNoZWNrbGlzdCBieSBGcmlkYXkuDQoNCkJlc3QsDQpPd25lcg==\r\n";

const GOLDEN_BODY =
  "Hi Dana,\r\n\r\nThanks for the onboarding call. Here is the recap:\r\n\r\n" +
  "We agreed to start the pilot Monday, and I'll send the checklist by Friday.\r\n\r\nBest,\r\nOwner";

const GOLDEN_CANONICAL =
  '{"body_sha256":"5bb6dd972f8e0d41cb4488c81de9894eda6bf1b42415671f1d5be2b24249c25b",' +
  '"connection_id":"con_gmail_1","custom":false,' +
  '"fields":{"first_name":"Dana","recap":"We agreed to start the pilot Monday, and I\'ll send the checklist by Friday.","topic":"onboarding call"},' +
  '"job_expires_at":"2026-10-12T06:59:00Z","job_id":"job_tuesday_recap",' +
  '"mime_sha256":"44050b1aea715c90c383f188d6b8308db2ffabe9a8708f120f871a70070005f5",' +
  '"policy_version":1,"provider":"gmail","recipient":"dana@test.example","sender":"owner@example.com",' +
  '"subject":"Recap: onboarding call","template_id":"tpl_recap",' +
  '"template_sha256":"c2473760b60bfdae9e7580c436dd56964e7c88ecbc7d147016e02b97a4499724","v":1}';

const GOLDEN_VERSION_SHA256 = "f6f73d21d67352a54c8ee029105e21ac839e1f168947e81f785df34e0bf0a525";

function makeJob(overrides = {}) {
  return {
    v: 1,
    job_id: "job_tuesday_recap",
    policy_version: 1,
    owner: "own_carter",
    connection: "con_gmail_1",
    agent_connection: "ac_chatgpt_1",
    provider: "gmail",
    sender: "owner@example.com",
    recipient: "dana@test.example",
    purpose: "Send Dana at Acme a recap of Tuesday's call.",
    template: { id: TEMPLATE.id, sha256: TEMPLATE.sha256 },
    field_rules: {
      first_name: { max: 40, single_line: true, required: true },
      topic: { max: 80, single_line: true, required: true },
      recap: { max: 600, required: true, free_text: true },
    },
    max_sends: 2,
    expires_at: "2026-10-12T06:59:00Z",
    auto_send: true,
    allow_custom_with_approval: true,
    ai_review: "custom_only",
    ...overrides,
  };
}

function makeTemplate(subject_tpl, body_tpl, id = TEMPLATE.id) {
  return { id, subject_tpl, body_tpl, sha256: templateSha256({ subject_tpl, body_tpl }) };
}

const text = (bytes) => Buffer.from(bytes).toString("latin1");

function splitMime(mime) {
  const message = text(mime);
  const at = message.indexOf("\r\n\r\n");
  assert.ok(at > 0, "message has a header/body separator");
  const bodyLines = message.slice(at + 4).split("\r\n");
  assert.equal(bodyLines.pop(), "", "body ends with CRLF");
  return {
    headers: message.slice(0, at).split("\r\n"),
    bodyLines,
    body: Buffer.from(bodyLines.join(""), "base64").toString("utf8"),
  };
}

function rejectsWith(code, fn, label) {
  assert.throws(fn, (error) => error instanceof RenderError && error.code === code, label ?? code);
}

const mimeInput = (overrides = {}) => ({
  from: "owner@example.com",
  to: "dana@test.example",
  subject: "Recap: onboarding call",
  body: GOLDEN_BODY,
  ...overrides,
});

test("render: golden bytes for the stage template and fields", () => {
  assert.equal(templateSha256(TEMPLATE), TEMPLATE.sha256);
  assert.equal(text(buildMime(mimeInput())), GOLDEN_MIME);

  const { draft, canonical, version_sha256 } = render(makeJob(), "dana@test.example", { fields: { ...FIELDS } }, TEMPLATE);
  assert.ok(draft.mime instanceof Uint8Array);
  assert.equal(text(draft.mime), GOLDEN_MIME);
  assert.equal(draft.subject, "Recap: onboarding call");
  assert.equal(draft.body, GOLDEN_BODY);
  assert.equal(draft.custom, false);
  assert.equal(draft.free_text, FIELDS.recap);
  assert.deepEqual(draft.fields, { ...FIELDS });
  assert.equal(canonicalize(canonical), GOLDEN_CANONICAL);
  assert.equal(version_sha256, GOLDEN_VERSION_SHA256);
  assert.equal(versionSha256(canonical), GOLDEN_VERSION_SHA256);
});

test("render: the optional X-Writ-Version header", () => {
  const tagged = text(buildMime(mimeInput({ versionTag: GOLDEN_VERSION_SHA256.slice(0, 16) })));
  assert.equal(
    tagged,
    GOLDEN_MIME.replace(
      "Content-Transfer-Encoding: base64\r\n",
      "Content-Transfer-Encoding: base64\r\nX-Writ-Version: f6f73d21d67352a5\r\n",
    ),
  );
  for (const bad of ["F6F73D21D67352A5", "f6f73d21d67352a", "f6f73d21d67352a5f", "f6f73d21d67352ag"]) {
    rejectsWith("invalid_version_tag", () => buildMime(mimeInput({ versionTag: bad })), bad);
  }
});

test("render: a non-ASCII subject is RFC 2047 B-encoded UTF-8", () => {
  const { headers, body } = splitMime(buildMime(mimeInput({ subject: "Récap: café ☕" })));
  assert.equal(headers[2], "Subject: =?UTF-8?B?UsOpY2FwOiBjYWbDqSDimJU=?=");
  assert.equal(body, GOLDEN_BODY);
});

test("render: a long subject folds into encoded-words that never split a character", () => {
  const subject = "Récapitulatif de l'appel d'intégration — étapes suivantes 😀 pour l'équipe Acme 😀😀 naïve façade";
  const { headers } = splitMime(buildMime(mimeInput({ subject })));
  const start = headers.findIndex((line) => line.startsWith("Subject: "));
  const end = headers.findIndex((line, i) => i > start && !line.startsWith(" "));
  const lines = headers.slice(start, end);
  assert.ok(lines.length > 1, "the subject folds onto continuation lines");
  const fatal = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  lines.forEach((line, i) => {
    assert.ok(line.length <= 76, `line ${i} is ${line.length} characters`);
    const word = i === 0 ? line.slice("Subject: ".length) : line.slice(1);
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/]+={0,2}\?=$/);
    assert.ok(word.length <= 75);
    decoded += fatal.decode(Buffer.from(word.slice(10, -2), "base64"));
  });
  assert.equal(decoded, subject);
});

test("render: subject encoding rules for ASCII edge cases", () => {
  const subjectLines = (subject) => {
    const { headers } = splitMime(buildMime(mimeInput({ subject })));
    const start = headers.findIndex((line) => line.startsWith("Subject:"));
    return headers.slice(start, headers.findIndex((line, i) => i > start && !line.startsWith(" ")));
  };
  assert.deepEqual(subjectLines("Plain ASCII subject"), ["Subject: Plain ASCII subject"]);
  assert.deepEqual(subjectLines(""), ["Subject:"]);
  // "=?" could be read as an encoded-word, and edge spaces would be dropped, so both get encoded.
  for (const subject of ["Price =?utf-8?q?x?=", " leading space", "trailing space ", "tab\there", "x".repeat(70)]) {
    const lines = subjectLines(subject);
    assert.ok(lines[0].startsWith("Subject: =?UTF-8?B?"), JSON.stringify(subject));
    const decoded = lines.map((line, i) => Buffer.from((i === 0 ? line.slice(9) : line.slice(1)).slice(10, -2), "base64").toString("utf8")).join("");
    assert.equal(decoded, subject);
  }
  assert.deepEqual(subjectLines("x".repeat(69)), [`Subject: ${"x".repeat(69)}`]);
});

test("render: the body is base64 wrapped at 76 characters", () => {
  const body = Array.from({ length: 40 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog. Ünïcödé ✓`).join("\n");
  const { bodyLines, body: decoded } = splitMime(buildMime(mimeInput({ body })));
  assert.ok(bodyLines.length > 10);
  bodyLines.forEach((line, i) => {
    if (i < bodyLines.length - 1) assert.equal(line.length, 76, `line ${i}`);
    else assert.ok(line.length > 0 && line.length <= 76);
    assert.match(line, /^[A-Za-z0-9+/]+={0,2}$/);
  });
  assert.equal(decoded, body.replace(/\n/g, "\r\n"));
});

test("render: every line ends in CRLF, headers and body alike", () => {
  const body = "one\ntwo\rthree\r\nfour\n\nfive\r\r\nsix\n";
  const mime = text(buildMime(mimeInput({ body, subject: "Ünïcödé subject that is long enough to fold onto a second line ✓" })));
  assert.equal(/\r(?!\n)|(?<!\r)\n/.test(mime), false, "no bare CR or LF in the message");
  const { body: decoded } = splitMime(buildMime(mimeInput({ body })));
  assert.equal(decoded, "one\r\ntwo\r\nthree\r\nfour\r\n\r\nfive\r\n\r\nsix\r\n");
  assert.equal(/\r(?!\n)|(?<!\r)\n/.test(decoded), false, "no bare CR or LF in the decoded body");

  const job = makeJob({ allow_custom_with_approval: true });
  const custom = render(job, "dana@test.example", { custom_subject: "Kickoff", custom_body: "Hi Dana,\nThursday at 2pm?\rBest" }, null);
  assert.equal(custom.draft.body, "Hi Dana,\r\nThursday at 2pm?\r\nBest");
  assert.equal(splitMime(custom.draft.mime).body, custom.draft.body);
});

test("render: CR, LF or NUL in any header value throws header_injection", () => {
  for (const bad of ["\r", "\n", "\r\n", "\0"]) {
    rejectsWith("header_injection", () => buildMime(mimeInput({ to: `dana@test.example${bad}Bcc: x@evil.example` })), `to ${JSON.stringify(bad)}`);
    rejectsWith("header_injection", () => buildMime(mimeInput({ from: `owner@example.com${bad}` })), `from ${JSON.stringify(bad)}`);
    rejectsWith("header_injection", () => buildMime(mimeInput({ subject: `Hi${bad}Bcc: x@evil.example` })), `subject ${JSON.stringify(bad)}`);
    rejectsWith("header_injection", () => buildMime(mimeInput({ versionTag: `f6f73d21d67352a5${bad}` })), `tag ${JSON.stringify(bad)}`);
  }
  // Through render too: a custom subject is a header value.
  rejectsWith("header_injection", () =>
    render(makeJob(), "dana@test.example", { custom_subject: "Hi\r\nBcc: x@evil.example", custom_body: "b" }, null),
  );
});

test("render: To and From must be exactly one bare address", () => {
  const bad = [
    "dana@test.example, bo@test.example",
    "dana@test.example,bo@test.example",
    "dana@test.example;bo@test.example",
    "dana@test.example,",
    "dana@test.example;",
    "dana@test.example bo@test.example",
    "Dana <dana@test.example>",
    '"Dana" <dana@test.example>',
    "<dana@test.example>",
    "dana@test.example (Dana)",
    '"dana"@test.example',
    "dana@[127.0.0.1]",
    "undisclosed:;",
    "dana",
    "@test.example",
    "dana@",
    "dana@localhost",
    "dana@@test.example",
    "da na@test.example",
    "dana.@test.example",
    "dána@test.example",
    "dana@-test.example",
    " dana@test.example",
    "",
  ];
  for (const to of bad) {
    rejectsWith("invalid_address", () => buildMime(mimeInput({ to })), `to ${JSON.stringify(to)}`);
    assert.equal(normalizeAddress(to), to === " dana@test.example" ? "dana@test.example" : null, JSON.stringify(to));
  }
  rejectsWith("invalid_address", () => buildMime(mimeInput({ from: "Owner <owner@example.com>" })));
  rejectsWith("invalid_address", () => buildMime(mimeInput({ from: "owner@example.com, x@example.com" })));
  assert.equal(normalizeAddress("  Dana@Test.Example  "), "dana@test.example");
  assert.equal(normalizeAddress("o'brien+recap@sub.test.example"), "o'brien+recap@sub.test.example");
  assert.equal(normalizeAddress(42), null);
});

test("render: anything outside printable ASCII is refused before trimming or case mapping (A3)", () => {
  // Built from code points so this file's bytes cannot change what the test means.
  const cp = (...points) => String.fromCodePoint(...points);
  const refused = {
    "trailing CRLF": `dana@test.example${cp(0x0d, 0x0a)}`,
    "trailing LF": `dana@test.example${cp(0x0a)}`,
    "leading LF": `${cp(0x0a)}dana@test.example`,
    "leading CR": `${cp(0x0d)}dana@test.example`,
    "U+2028 line separator": `dana@test.example${cp(0x2028)}`,
    "U+2029 paragraph separator": `${cp(0x2029)}dana@test.example`,
    "BOM U+FEFF": `${cp(0xfeff)}dana@test.example`,
    "NBSP U+00A0": `dana@test.example${cp(0xa0)}`,
    // toLowerCase would map the Kelvin sign onto an ASCII "k".
    "Kelvin sign U+212A": `${cp(0x212a)}en@test.example`,
    "dotted capital I U+0130": `${cp(0x130)}van@test.example`,
    NUL: `dana@test.example${cp(0)}`,
    tab: `${cp(0x09)}dana@test.example`,
    "vertical tab": `dana@test.example${cp(0x0b)}`,
    DEL: `dana@test.example${cp(0x7f)}`,
  };
  assert.equal(cp(0x212a).toLowerCase(), "k", "the hazard this guards against");
  for (const [label, raw] of Object.entries(refused)) {
    assert.equal(normalizeAddress(raw), null, label);
    // buildMime takes no trimming path at all: the same input never becomes a To or From header.
    assert.throws(() => buildMime(mimeInput({ to: raw })), RenderError, `To: ${label}`);
    assert.throws(() => buildMime(mimeInput({ from: raw })), RenderError, `From: ${label}`);
  }
  assert.equal(normalizeAddress("  A@X.COM  "), "a@x.com");
  assert.equal(normalizeAddress("A@X.COM"), "a@x.com");
  assert.equal(normalizeAddress("   "), null);
});

test("fill: {{name}} only; unknown placeholders and malformed templates throw", () => {
  assert.equal(fill("Hi {{first_name}}, re {{topic}} / {{topic}}", { first_name: "Dana", topic: "x" }), "Hi Dana, re x / x");
  assert.deepEqual(placeholderNames("{{a}} and {{b_2}} and {{a}}"), ["a", "b_2", "a"]);
  assert.equal(fill("no placeholders", {}), "no placeholders");
  // Values are inserted literally, never re-expanded.
  assert.equal(fill("{{a}}", { a: "{{b}}", b: "boom" }), "{{b}}");

  rejectsWith("unknown_placeholder", () => fill("Hi {{nope}}", { first_name: "Dana" }));
  rejectsWith("unknown_placeholder", () => fill("Hi {{toString}}", {}));
  rejectsWith("unknown_placeholder", () => fill("Hi {{__proto__}}", {}));
  for (const template of ["{{ topic }}", "{{topic", "topic}}", "{topic}", "{{{topic}}}", "{{a.b}}", "{{#if x}}", "{{}}", "{{1a}}", "a { b"]) {
    rejectsWith("malformed_template", () => fill(template, { topic: "x", a: "y" }), template);
  }
});

test("render: the recipient is compared and sent in the gate's normalized form", () => {
  const call = { fields: { ...FIELDS } };
  const expected = render(makeJob(), "dana@test.example", call, TEMPLATE);
  const mimeText = (result) => Buffer.from(result.draft.mime).toString("latin1");
  assert.match(mimeText(expected), /\r\nTo: dana@test\.example\r\n/);

  // The gate passes on these (one normalizer on both sides), so render must agree, and the version
  // must not depend on how the address was written.
  for (const [recipient, to] of [
    ["Dana@Test.Example", "dana@test.example"],
    ["dana@test.example", "Dana@TEST.example"],
    [" dana@test.example ", "dana@test.example"],
  ]) {
    const result = render(makeJob({ recipient }), to, call, TEMPLATE);
    assert.equal(result.draft.recipient, "dana@test.example", `${recipient} / ${to}`);
    assert.match(mimeText(result), /\r\nTo: dana@test\.example\r\n/);
    assert.equal(result.version_sha256, expected.version_sha256, `${recipient} / ${to}`);
  }

  // Render accepts exactly the pairs the gate's normalizer calls the same address.
  const variants = ["dana@test.example", "DANA@test.example", " dana@test.example", "dana@test.example.", "dana@test", "bo@test.example", "", "dana@@test.example"];
  for (const recipient of variants) {
    for (const to of variants) {
      const same = normalizeRecipient(to) !== null && normalizeRecipient(to) === normalizeRecipient(recipient);
      const job = makeJob({ recipient });
      if (same) assert.doesNotThrow(() => render(job, to, call, TEMPLATE), `${JSON.stringify(recipient)} / ${JSON.stringify(to)}`);
      else rejectsWith("recipient_not_in_job", () => render(job, to, call, TEMPLATE));
    }
  }
});

test("render: field and template checks", () => {
  const job = makeJob();
  const to = "dana@test.example";

  const unknown = makeTemplate("Recap: {{topic}}", "Hi {{first_name}}, {{surprise}}");
  rejectsWith("unknown_placeholder", () => render(makeJob({ template: { id: unknown.id, sha256: unknown.sha256 } }), to, { fields: { ...FIELDS } }, unknown));

  const { recap, ...withoutRecap } = FIELDS;
  rejectsWith("missing_field", () => render(job, to, { fields: withoutRecap }, TEMPLATE));
  rejectsWith("missing_field", () => render(job, to, { fields: { ...FIELDS, first_name: "" } }, TEMPLATE));
  rejectsWith("field_not_allowed", () => render(job, to, { fields: { ...FIELDS, cc: "bo@test.example" } }, TEMPLATE));
  rejectsWith("invalid_field_value", () => render(job, to, { fields: { ...FIELDS, topic: 7 } }, TEMPLATE));
  rejectsWith("field_not_allowed", () => render(job, to, { fields: { ...FIELDS }, custom_body: "x" }, TEMPLATE));
  rejectsWith("invalid_call", () => render(job, to, {}, TEMPLATE));
  rejectsWith("recipient_not_in_job", () => render(job, "bo@test.example", { fields: { ...FIELDS } }, TEMPLATE));
  rejectsWith("recipient_not_in_job", () => render(job, `dana@test.example${String.fromCharCode(7)}`, { fields: { ...FIELDS } }, TEMPLATE));
  rejectsWith("recipient_not_in_job", () => render(job, 7, { fields: { ...FIELDS } }, TEMPLATE));
  rejectsWith("recipient_not_in_job", () => render(makeJob({ recipient: "not an address" }), "not an address", { fields: { ...FIELDS } }, TEMPLATE));

  rejectsWith("template_mismatch", () => render(job, to, { fields: { ...FIELDS } }, null));
  rejectsWith("template_mismatch", () => render(job, to, { fields: { ...FIELDS } }, { ...TEMPLATE, id: "tpl_other" }));
  rejectsWith("template_mismatch", () => render(job, to, { fields: { ...FIELDS } }, { ...TEMPLATE, body_tpl: `${TEMPLATE.body_tpl}!` }));
  rejectsWith("template_mismatch", () => render(job, to, { fields: { ...FIELDS } }, { ...TEMPLATE, sha256: "0".repeat(64) }));

  rejectsWith("custom_not_allowed", () =>
    render(makeJob({ allow_custom_with_approval: false }), to, { custom_subject: "s", custom_body: "b" }, null),
  );
  rejectsWith("invalid_call", () => render(job, to, { custom_subject: "s" }, null));

  // An optional field the agent leaves out renders as empty text.
  const optional = makeJob({ field_rules: { ...job.field_rules, recap: { max: 600, free_text: true } } });
  const { draft } = render(optional, to, { fields: withoutRecap }, TEMPLATE);
  assert.ok(draft.body.includes("recap:\r\n\r\n\r\n\r\nBest"));
  assert.equal(draft.free_text, "");
  assert.deepEqual(draft.fields, withoutRecap);
});

test("render: free_text is the agent-written text", () => {
  const rules = {
    first_name: { max: 40, single_line: true, required: true },
    topic: { max: 80, single_line: true, required: true, free_text: true },
    recap: { max: 600, required: true, free_text: true },
  };
  const { draft } = render(makeJob({ field_rules: rules }), "dana@test.example", { fields: { ...FIELDS } }, TEMPLATE);
  assert.equal(draft.free_text, `${FIELDS.recap}\n${FIELDS.topic}`);

  const custom = render(makeJob(), "dana@test.example", { custom_subject: "Kickoff", custom_body: "Does Thursday at 2pm work?" }, null);
  assert.equal(custom.draft.custom, true);
  assert.equal(custom.draft.fields, null);
  assert.equal(custom.draft.free_text, "Does Thursday at 2pm work?");
  assert.equal(custom.canonical.custom, true);
  assert.equal(custom.canonical.fields, null);
  assert.equal(custom.canonical.template_id, TEMPLATE.id);
});

test("render: mime_sha256 and body_sha256 match the draft bytes", () => {
  for (const call of [{ fields: { ...FIELDS } }, { custom_subject: "Kickoff ✓", custom_body: "Line one\nLine two" }]) {
    const { draft, canonical, version_sha256 } = render(makeJob(), "dana@test.example", call, TEMPLATE);
    assert.equal(canonical.mime_sha256, sha256Hex(draft.mime));
    assert.equal(canonical.body_sha256, sha256Hex(draft.body));
    assert.equal(canonical.body_sha256, sha256Hex(Buffer.from(draft.body, "utf8")));
    assert.equal(splitMime(draft.mime).body, draft.body, "the MIME body decodes to exactly draft.body");
    assert.equal(canonical.subject, draft.subject);
    assert.equal(version_sha256, sha256Hex(canonicalize(canonical)));
    assert.equal(storedVersionIntact({ canonical, sha256: version_sha256, mime: draft.mime }), true);

    const flipped = Uint8Array.from(draft.mime);
    flipped[flipped.length - 3] ^= 0x01;
    assert.equal(storedVersionIntact({ canonical, sha256: version_sha256, mime: flipped }), false, "a changed MIME byte");
    assert.equal(storedVersionIntact({ canonical: { ...canonical, subject: "x" }, sha256: version_sha256, mime: draft.mime }), false);
    assert.equal(storedVersionIntact({ canonical, sha256: "0".repeat(64), mime: draft.mime }), false);
    assert.equal(storedVersionIntact({ canonical: { ...canonical, policy_version: 1.5 }, sha256: version_sha256, mime: draft.mime }), false);
  }
});

const CANONICAL_KEYS = [
  "v",
  "job_id",
  "policy_version",
  "connection_id",
  "provider",
  "sender",
  "recipient",
  "template_id",
  "template_sha256",
  "fields",
  "custom",
  "subject",
  "body_sha256",
  "mime_sha256",
  "job_expires_at",
];

test("version hash: the canonical object has exactly the spec's fields", () => {
  const { canonical } = render(makeJob(), "dana@test.example", { fields: { ...FIELDS } }, TEMPLATE);
  assert.deepEqual(Object.keys(canonical).sort(), [...CANONICAL_KEYS].sort());
});

test("version hash: changing any one canonical field changes version_sha256", async (t) => {
  const { canonical, version_sha256 } = render(makeJob(), "dana@test.example", { fields: { ...FIELDS } }, TEMPLATE);
  const altered = (value) => {
    if (value === null) return { first_name: "Dana" };
    if (typeof value === "boolean") return !value;
    if (typeof value === "number") return value + 1;
    if (typeof value === "string") return `${value}x`;
    return null;
  };
  for (const key of CANONICAL_KEYS) {
    await t.test(key, () => {
      const changed = { ...canonical, [key]: altered(canonical[key]) };
      assert.notDeepEqual(changed[key], canonical[key]);
      assert.notEqual(versionSha256(changed), version_sha256);
    });
  }
  await t.test("fields: one value", () => {
    assert.notEqual(versionSha256({ ...canonical, fields: { ...canonical.fields, topic: "kickoff" } }), version_sha256);
  });
});

test("version hash: each render input reaches its canonical field", async (t) => {
  const to = "dana@test.example";
  const base = render(makeJob(), to, { fields: { ...FIELDS } }, TEMPLATE);
  const otherTemplate = makeTemplate("Recap: {{topic}}", `${TEMPLATE.body_tpl}\nP.S.`, "tpl_recap_v2");
  const sameTextNewId = { ...TEMPLATE, id: "tpl_recap_copy" };
  const cases = {
    job_id: () => render(makeJob({ job_id: "job_other" }), to, { fields: { ...FIELDS } }, TEMPLATE),
    policy_version: () => render(makeJob({ policy_version: 2 }), to, { fields: { ...FIELDS } }, TEMPLATE),
    connection_id: () => render(makeJob({ connection: "con_gmail_2" }), to, { fields: { ...FIELDS } }, TEMPLATE),
    provider: () => render(makeJob({ provider: "outlook" }), to, { fields: { ...FIELDS } }, TEMPLATE),
    sender: () => render(makeJob({ sender: "other@example.com" }), to, { fields: { ...FIELDS } }, TEMPLATE),
    recipient: () => render(makeJob({ recipient: "bo@test.example" }), "bo@test.example", { fields: { ...FIELDS } }, TEMPLATE),
    template_id: () =>
      render(makeJob({ template: { id: sameTextNewId.id, sha256: TEMPLATE.sha256 } }), to, { fields: { ...FIELDS } }, sameTextNewId),
    template_sha256: () =>
      render(makeJob({ template: { id: otherTemplate.id, sha256: otherTemplate.sha256 } }), to, { fields: { ...FIELDS } }, otherTemplate),
    fields: () => render(makeJob(), to, { fields: { ...FIELDS, recap: "Pilot starts Tuesday." } }, TEMPLATE),
    custom: () => render(makeJob(), to, { custom_subject: base.draft.subject, custom_body: base.draft.body }, null),
    subject: () => render(makeJob(), to, { fields: { ...FIELDS, topic: "kickoff call" } }, TEMPLATE),
    body_sha256: () => render(makeJob(), to, { fields: { ...FIELDS, first_name: "Dane" } }, TEMPLATE),
    mime_sha256: () => render(makeJob(), to, { fields: { ...FIELDS, recap: `${FIELDS.recap} ` } }, TEMPLATE),
    job_expires_at: () => render(makeJob({ expires_at: "2026-10-12T07:00:00Z" }), to, { fields: { ...FIELDS } }, TEMPLATE),
  };
  for (const [field, run] of Object.entries(cases)) {
    await t.test(field, () => {
      const next = run();
      assert.notDeepEqual(next.canonical[field], base.canonical[field], `${field} itself changed`);
      assert.notEqual(next.version_sha256, base.version_sha256);
    });
  }
});

test("version hash: stable when nothing canonical changes", () => {
  const to = "dana@test.example";
  const base = render(makeJob(), to, { fields: { ...FIELDS } }, TEMPLATE);
  assert.equal(base.version_sha256, GOLDEN_VERSION_SHA256);
  assert.equal(render(makeJob(), to, { fields: { ...FIELDS } }, TEMPLATE).version_sha256, base.version_sha256);
  const reordered = { recap: FIELDS.recap, topic: FIELDS.topic, first_name: FIELDS.first_name };
  assert.equal(render(makeJob(), to, { fields: reordered }, TEMPLATE).version_sha256, base.version_sha256);
  const reversedJob = Object.fromEntries(Object.entries(makeJob()).reverse());
  assert.equal(render(reversedJob, to, { fields: { ...FIELDS } }, TEMPLATE).version_sha256, base.version_sha256);
  // Job fields outside the canonical object do not move the version hash.
  const unrelated = makeJob({
    owner: "own_x",
    agent_connection: "ac_x",
    purpose: "Something else",
    max_sends: 5,
    auto_send: false,
    ai_review: "all_free_text",
  });
  assert.equal(render(unrelated, to, { fields: { ...FIELDS } }, TEMPLATE).version_sha256, base.version_sha256);
});

test("gmailRaw: base64url without padding of the exact bytes", () => {
  const { draft } = render(makeJob(), "dana@test.example", { fields: { ...FIELDS } }, TEMPLATE);
  const raw = gmailRaw(draft.mime);
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(new Uint8Array(Buffer.from(raw, "base64url")), draft.mime);
  assert.equal(gmailRaw(new Uint8Array([0xfb, 0xff])), "-_8");
  assert.equal(gmailRaw(draft.mime.subarray(7, 20)), Buffer.from(draft.mime.subarray(7, 20)).toString("base64url"));
});
