import { useState } from "react";
import { verifyReceiptText, type Pinned, type VerifyResult } from "@writ/job-send/verify";
import { SAY } from "../lib/copy";

/** The receipts verify library's answer (`@writ/job-send/verify`). `ok` is true ONLY for "verified". */
export type { Pinned, VerifyResult };

/** The browser-side check: these exact bytes against the key bundled at build. */
export type VerifyReceipt = (receiptText: string) => Promise<VerifyResult>;

/**
 * The page's check: the library's `verifyReceiptText` against the pinned key. It accepts only the canonical receipt
 * envelope (`receiptEnvelopeText`), so the pasted text is exactly what was checked. It REJECTS, rather than answering,
 * when this browser cannot run Ed25519 or the pin is inconsistent: that is "not checked", never a result.
 */
export function pinnedVerifier(pinned: Pinned): VerifyReceipt {
  return (receiptText) => verifyReceiptText(receiptText, pinned);
}

/** A check belongs to the exact text it checked; a null result means the library could not check here. */
type Checked = { text: string; result: VerifyResult | null };

export interface VerifyPageProps {
  /** The pinned public key's id, as shown on the slide. */
  keyFingerprint: string;
  verify: VerifyReceipt;
  initialReceipt?: string;
}

/**
 * What the page says: one of the spec's two results. "Signature verified" only for ok with reason "verified";
 * anything else is "Signature invalid" with the library's reason code, so a receipt under another key reads
 * invalid with `unknown_key` (spec A17; warden, #496).
 */
function describe(result: VerifyResult | null): { text: string; reason: string | null } {
  if (result === null) return { text: SAY.notChecked, reason: null };
  if (result.ok && result.reason === "verified") return { text: SAY.signatureVerified, reason: null };
  return { text: SAY.signatureInvalid, reason: result.reason === "verified" ? "malformed" : result.reason };
}

/**
 * /verify (spec: "Receipts and Flight Recorder", Verification away from the signer). Paste or open a receipt; the
 * page shows the pinned key and the result for exactly the text it checked. A result belongs to the text it checked:
 * an edit hides it, and the box is read-only while a check runs, so a forged byte never sits beside
 * "Signature verified" (warden, #496). A verified receipt proves only that these bytes were signed by the pinned key.
 */
export function VerifyPage({ keyFingerprint, verify, initialReceipt = "" }: VerifyPageProps) {
  const [receipt, setReceipt] = useState(initialReceipt);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    const text = receipt; // the result will be shown only beside these exact bytes
    setChecking(true);
    try {
      setChecked({ text, result: await verify(text) });
    } catch {
      setChecked({ text, result: null }); // the library could not check here: neither result
    } finally {
      setChecking(false);
    }
  };

  const shown = checked && checked.text === receipt ? describe(checked.result) : null;
  return (
    <section aria-label="Verify a receipt">
      <h2>Verify a receipt</h2>
      <p>
        Pinned key <code>{keyFingerprint}</code>
      </p>
      <label>
        Receipt
        <textarea
          value={receipt}
          readOnly={checking}
          onChange={(event) => setReceipt(event.target.value)}
          rows={12}
          spellCheck={false}
        />
      </label>
      <button type="button" onClick={() => void check()} disabled={checking || !receipt}>
        Verify
      </button>
      {shown ? (
        <p role="status">
          {shown.text}
          {shown.reason ? <code> {shown.reason}</code> : null}
        </p>
      ) : null}
      <p>A verified receipt shows these exact bytes were signed by the holder of the pinned key and are unchanged. It does not show that the email arrived, or which model asked for it.</p>
    </section>
  );
}
