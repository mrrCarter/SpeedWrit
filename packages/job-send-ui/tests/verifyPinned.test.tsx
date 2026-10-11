// The real check, end to end (spec A17): a receipt signed with the server's code verifies on /verify through the
// browser library; one changed byte is invalid; a receipt under another key is invalid with unknown_key.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { generateReceiptKeyPair, signReceipt } from "@writ/job-send";
import { receiptEnvelopeText } from "@writ/job-send/verify";
import { afterEach, describe, expect, it } from "vitest";
import { SAY } from "../src/lib/copy";
import { VerifyPage, pinnedVerifier } from "../src/screens/VerifyPage";

afterEach(cleanup);

const pair = generateReceiptKeyPair();
const pinned = { keyId: pair.keyId, publicKeyRaw: pair.publicKeyRaw };
const signed = signReceipt(pair.privateKey, { id: "rcp_7", seq: 7, type: "PROVIDER_ACCEPTED", ts: "2026-10-11T19:04:11Z", owner: "own_1" });
const envelope = receiptEnvelopeText(signed);

async function check(text: string): Promise<string | null> {
  render(<VerifyPage keyFingerprint={pinned.keyId} verify={pinnedVerifier(pinned)} initialReceipt={text} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
  // WebCrypto answers on a later task than act() flushes, so wait for the status to appear.
  return (await screen.findByRole("status")).textContent;
}

describe("VerifyPage with the pinned key", () => {
  it("the shared receipt reads 'Signature verified'", async () => {
    expect(await check(envelope)).toBe(SAY.signatureVerified);
  });

  it("one changed byte inside the signed payload reads 'Signature invalid'", async () => {
    const tampered = envelope.replace("PROVIDER_ACCEPTED", "PROVIDER_ACCEPTEE");
    expect(tampered).not.toBe(envelope);
    expect(await check(tampered)).toBe(`${SAY.signatureInvalid} invalid_signature`);
  });

  it("a receipt signed under another key reads 'Signature invalid' with unknown_key", async () => {
    const other = generateReceiptKeyPair();
    const foreign = receiptEnvelopeText(signReceipt(other.privateKey, { id: "rcp_7", seq: 7, type: "PROVIDER_ACCEPTED", ts: "2026-10-11T19:04:11Z", owner: "own_1" }));
    expect(await check(foreign)).toBe(`${SAY.signatureInvalid} unknown_key`);
  });

  it("an unsigned key appended to the envelope reads 'Signature invalid' (malformed), never verified", async () => {
    expect(await check(`${envelope.slice(0, -1)},"status":"arrived"}`)).toBe(`${SAY.signatureInvalid} malformed`);
  });
});
