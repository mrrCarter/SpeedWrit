import test from "node:test";
import assert from "node:assert/strict";

import { createStubMailProvider } from "./support/stub-mail-provider.mjs";

const bytes = (text) => new TextEncoder().encode(text);

test("the stub follows its script, then the fallback, and records every call's exact bytes", async () => {
  const stub = createStubMailProvider({ script: ["not_sent:http_400", "unknown:timeout"] });
  assert.deepEqual(await stub.provider.send(bytes("a")), { status: "not_sent", errorClass: "http_400" });
  assert.deepEqual(await stub.provider.send(bytes("b")), { status: "unknown", errorClass: "timeout" });
  assert.deepEqual(await stub.provider.send(bytes("c")), { status: "accepted", providerMessageId: "stub-msg-3" });
  assert.equal(stub.callCount, 3);
  assert.deepEqual([0, 1, 2].map((i) => stub.sentText(i)), ["a", "b", "c"]);
});

test("recorded bytes are a copy: changing the caller's buffer later does not change the record", async () => {
  const stub = createStubMailProvider();
  const buffer = bytes("stored mime");
  await stub.provider.send(buffer);
  buffer[0] = 0x58;
  assert.equal(stub.sentText(0), "stored mime");
});

test("a held call stays pending until released, so a case can open a race window", async () => {
  const stub = createStubMailProvider({ script: ["hold"] });
  let settled = false;
  const pending = stub.provider.send(bytes("x")).then((outcome) => {
    settled = true;
    return outcome;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(stub.heldCount, 1);
  stub.release(0, "accept");
  assert.deepEqual(await pending, { status: "accepted", providerMessageId: "stub-msg-1" });
  assert.equal(stub.heldCount, 0);
});

test("a held call can end as a transport reset, which the executor must record as UNKNOWN", async () => {
  const stub = createStubMailProvider({ script: ["hold"] });
  const pending = stub.provider.send(bytes("x"));
  stub.reset(0);
  await assert.rejects(pending, { code: "ECONNRESET" });
});

test("the stub refuses anything but bytes, and unknown steps", async () => {
  const stub = createStubMailProvider({ script: ["explode"] });
  await assert.rejects(stub.provider.send("text"), TypeError);
  await assert.rejects(stub.provider.send(bytes("x")), /unknown stub step/);
});

test("an error class keeps every colon after the first", async () => {
  const stub = createStubMailProvider({ script: ["unknown:smtp:421", "not_sent:http:400"] });
  assert.deepEqual(await stub.provider.send(bytes("a")), { status: "unknown", errorClass: "smtp:421" });
  assert.deepEqual(await stub.provider.send(bytes("b")), { status: "not_sent", errorClass: "http:400" });
});

test("releasing a held call with a bad step throws and leaves the call held, so the case fails fast", async () => {
  const stub = createStubMailProvider({ script: ["hold"] });
  const pending = stub.provider.send(bytes("x"));
  assert.throws(() => stub.release(0, "acept"), /unknown stub step/);
  assert.equal(stub.heldCount, 1);
  stub.release(0, "accept");
  assert.deepEqual(await pending, { status: "accepted", providerMessageId: "stub-msg-1" });
});
