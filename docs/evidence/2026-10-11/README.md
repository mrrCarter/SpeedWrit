# Selected SpeedWrit evidence

These seven files are original canonical receipt envelopes from the historical run on source `480ee1fbb3782e39ed9ab9a1a0e58756bee628ce`. Their signed payloads and original file bytes have not been edited. [The manifest](manifest.json) gives each file's SHA-256; [the public key](receipt-key.json) has fingerprint `8d7fe1becc5eff89`.

With Node.js 22, run this from the repository root:

```sh
node docs/evidence/2026-10-11/verify.mjs
```

The dependency-free checker compares file hashes, verifies all seven Ed25519 signatures against the pinned public key, and rejects an in-memory one-byte edit of each signed payload. It performs no network requests and leaves the files unchanged. This checks signatures and file integrity, not the truth of an email outcome or the full application receipt schema.

| Receipt | What its signed record shows |
| --- | --- |
| [Routine acceptance](receipts/rcp_A_i3OZ22WSdaS0ij.json) | A provider-accepted outcome for one proposal version. Acceptance is separate from inbox arrival. |
| [Wrong recipient](receipts/rcp_QfnP4-NpIeD0etqn.json) | A `recipient_not_in_job` denial. The separate audit reconstructed spare capacity from the surrounding signed sequence; this one envelope does not contain that sequence. |
| [Wrong connection](receipts/rcp_Inj40qVf69D8xhqm.json) | A `job_not_found` denial with no job attribution. It does not appear in a particular job's Flight Recorder timeline. |
| [Exact-version approval](receipts/rcp_QD2lfO9NJuIKsdXL.json) | An owner approval bound to a proposal version and its full hash. |
| [Custom acceptance](receipts/rcp_V8zlL_P8gApSqzFu.json) | Provider acceptance for that same proposal version and hash. These two files alone do not show the earlier hold or owner's browser actions. |
| [Controlled UNKNOWN](receipts/rcp__lT7ioEP7xwZMzbJ.json) | An UNKNOWN outcome with `network` recorded. The operator's controlled fault occurred before provider acceptance; this was not evidence that Gmail accepted mail and lost its response. Fault provenance is contextual audit evidence, not a claim made by this receipt alone. |
| [Owner non-arrival observation](receipts/rcp_gGUhLCj966G_J1kh.json) | The owner recorded `not_arrived` for the UNKNOWN dispatch. Source and the separate retention audit establish that UNKNOWN and its reservation remain; this observation is not a failed-send verdict or permission to resend. |

To inspect a receipt, open the linked file's raw content and paste the complete canonical envelope into the deployed owner's `/owner-app/#/verify` page. Verify the displayed public-key fingerprint against `receipt-key.json`. A signature verifies the payload under that key; it does not prove that the payload's real-world claim is complete or independently witnessed. Changing any signed payload byte invalidates its signature. These are selected receipts, not a complete sequence or chain.

The recorded browser check verified the routine acceptance envelope and rejected a one-byte payload edit on both the historical 480 build and the later `910252e7a0d206fffbb9953deeb5320a8c200576` runtime. The new-runtime check occurred at 23:03:51Z on 2026-10-11 with the same public key. Rechecking a historical receipt does not make its send a new-runtime send. Browser-test observations are separate from signed receipts. See the [observation summary](browser-check.json), [original verified screenshot](browser-original.png), and [one-byte edit rejected screenshot](browser-one-byte-edit.png). The screenshots show the same historical receipt; their unchanged appearance is expected because the verifier UI did not change.

An owned-inbox witness reported sender, subject, opening preview and displayed message time for the historical routine and custom sends. Full body and Cc/Bcc were not compared. This bundle does not contain inbox evidence and does not turn provider acceptance into a delivery guarantee.

Provider-call and retry counters were not measured. No automatic resend is source policy, not a measured zero in this bundle. No stopwatch measurements or savings result are available. The fresh recorded take, stale-approval demonstration and STOP-with-unused-capacity demonstration are not established by these files. AI review was unconfigured in the historical run; no live Jev execution or Grok acceptance run is claimed.

The envelopes intentionally retain opaque record identifiers, public client labels, hashes, signatures, and opaque provider message identifiers where recorded. They contain no message body, subject, recipient address, credential, private key, secret connection URL or private filesystem path.
