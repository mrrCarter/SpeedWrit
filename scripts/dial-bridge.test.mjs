import assert from "node:assert/strict";
import { test } from "node:test";
import { alertItems } from "./dial-bridge.mjs";

const receipt = (type, detail) => ({ id: `rcp_${type}`, type, payload: JSON.stringify({ type, detail }) });

test("each watched receipt becomes one alert in the relay's categories", () => {
  const items = alertItems(
    [
      receipt("ATTEMPT_DENIED", { reason_code: "recipient_not_in_job", args_sha256: "0".repeat(64) }),
      receipt("OUTCOME_UNKNOWN", { dispatch: "dsp_1" }),
      receipt("APPROVAL_REFUSED", { reason: "superseded" }),
    ],
    [],
  );
  assert.deepEqual(items, [
    { category: "out_of_policy", label: "An agent attempt, recipient not in job" },
    { category: "unusual", label: "A send outcome" },
    { category: "unusual", label: "An approval, superseded" },
  ]);
});

test("a held version asks for a decision; other receipt types and bad payloads stay quiet or generic", () => {
  const items = alertItems(
    [
      receipt("PROVIDER_ACCEPTED", { dispatch: "dsp_2" }),
      { id: "rcp_bad", type: "ATTEMPT_DENIED", payload: "not json" },
    ],
    [{ id: "pv_1", version: 2 }],
  );
  assert.deepEqual(items, [
    { category: "out_of_policy", label: "An agent attempt" },
    { category: "ambiguous", label: "A held draft, version 2" },
  ]);
});

test("labels carry no address, subject or body", () => {
  const items = alertItems([receipt("ATTEMPT_DENIED", { reason_code: "recipient_not_in_job", to: "dana@acme.example.test" })], [
    { id: "pv_2", version: 1, recipient: "dana@acme.example.test", body: "secret plans" },
  ]);
  for (const it of items) assert.doesNotMatch(it.label, /@|secret plans|dana/i);
});
