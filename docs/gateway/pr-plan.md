# Planned PR sequence: a source-bound action gateway

This is a proposed specification and implementation backlog, not 26 opened PRs or a release approval. P00–P25 are stable planning IDs, independent of GitHub PR numbers. A child such as P06a is a smaller implementation slice of P06; the parent is complete only when all of its required slices are reviewed and proven.

The first milestone is one personal-owner Gmail workflow: the gateway selects an explicitly approved record version and template, constructs the exact message, enforces the confirmed job, and records one admitted provider attempt. Agent-written prose remains a separate mode requiring approval of the exact version. A correct recipient, a template, an AI-clear result or a source hash alone does not establish authorized content provenance.

Phone enrollment, phone testing and the current phone demo remain **ON HOLD**. Planning and offline fixtures do not authorize a phone call, owner decision, provider action, credential import or deployment.

## Starting point and constraints

The deployed source baseline for this plan is `653d1571c109b95db27a0fd3247c5bfe03abb889`. Repository main can advance independently; every implementation PR must record its actual base, head and changed contracts.

- The current gate accepts agent-provided template fields; it has no approved-record source binding. The renderer already freezes gateway MIME and hashes a proposal version. Preserve that mechanism rather than introduce a competing renderer.
- Both the early operation-ID replay path and the unique-conflict path return an existing proposal without comparing changed arguments. That prevents another send for the same stored operation, but does not implement digest-conflict refusal.
- Current quotas, exact-version approval and conservative UNKNOWN handling are useful foundations. UNKNOWN retains its slot; negative Sent search, lease expiry, timeout or restart never authorizes a refund or retry.
- The voice worker has process-local pause/control state, and startup cancels voice sessions. It is not safe to infer replica compatibility from one-container tests. P06/P07 must address startup and every writer before any overlapping application instances.
- The database has eight existing migrations. The merger assigns the next migration number after reconciling concurrent work. Never edit an existing migration, historical authority object or signed receipt. The old binary checks a strict migration list, so a schema-compatible feature-off fallback must be prepared and tested **before** applying a new migration.
- Strict-profile activation is a durable policy decision scoped to the actor/account/connection, with an authoritative policy epoch. It stops new v1 job creation and legacy provider admission with `migration_required` across every covered route. Historical v1 bytes remain verifiable; they are not continuing execution permission. A feature-off fallback must enforce the same durable restriction.
- The intent key is `(authority_scope, job_id, operation_id)`, where the server derives a typed personal-owner or tenant scope. One admitted provider attempt is allowed across all revisions of that intent. Revision has a separate request identity and compare-and-set contract; it cannot create a second attempt after admission.
- OAuth authenticates a supported caller to this gateway; it does not intercept an independently credentialed native connector, browser, SMTP client or hosted agent. Account-wide coverage is a separate managed-environment milestone.
- Gmail provider acceptance and recipient delivery remain distinct. No milestone claims exactly-once delivery, globally instantaneous STOP, universal prompt-injection prevention or proof of hidden model reasoning.
- Performance, onboarding and availability numbers are targets until measured. This plan supplies no unmeasured scale SLA.

The deployed-source anchors are `packages/job-send/src/gate/checks.ts`, `executor/backend.ts`, `executor/jobs.ts`, `executor/render/render.ts`, `executor/dispatch.ts`, `ai-review/provider.ts`, and `packages/job-send-app/src/dial-voice.ts`. Preserve the supported-action boundary in [ADR 0001](../adr/0001-supported-action-boundary.md). That ADR's recorded source snapshot predates the final voice backend; use the pinned implementation above for current behavior.

## Merge and release rules

A merge proves reviewed source and its stated tests. It does not enable a feature, apply a schema to production, confirm a job or authorize a send. Each implementation PR includes a regression that fails when its new invariant is removed, plus positive controls and compatibility checks. Source changes invalidate earlier exact-head keys.

Until P12 passes its release gate, source-bound requests may prepare or enter a held state only. Use a server-side gate that cannot be lifted by client input, AI review, browser or phone approval, a worker or an alternative executor path. Never silently relabel version-1 agent-filled templates as source-bound. Within an activated strict actor/account/connection scope, new v1 creation and every legacy provider admission return `migration_required`; execution requires a newly confirmed supported authority. Preserve historical bytes, not a route around that restriction.

P12 requires **all P01–P10, P11 safety prerequisites and P23a's minimum personal-processing gate**, final integration evidence and reviewed deployment artifacts. P23a has no enterprise dependency. A fresh owner-approved record, fresh job and separately authorized owned-recipient action establish the new milestone. Historical Dana jobs, receipts and demonstrations cannot substitute for it.

A code migration is additive, feature-off and accompanied by a compatible fallback image and restore rehearsal. The fallback must preserve strict-profile epochs and deny legacy admission in activated scopes even when new features are off; a schema-compatible binary that ignores that restriction is not an acceptable fallback. Rolling back preserves acknowledged claims, policy restrictions and evidence. A stale database restore that might omit them remains paused; it is never treated as newly available capacity or permission.

## Execution waves

| Wave | Parallel work | Exit condition |
| --- | --- | --- |
| 0 | P00 contract packet, P01 replay conflicts, P11 operational safety, P14 enterprise B0 contracts | Reviewed contracts and isolated proof plans; no live enablement |
| 1 | P02 → P03 → P04; P06's shared protocol supports P05 strict activation and P07 workers | Server-bound source preparation, durable legacy fences, mandatory prose holds and admission foundations |
| 2 | P08, P09, P10 and P23a against the agreed contracts | UI, approval, evidence and minimum personal-processing controls agree before release |
| 3 | P12, then P13 | One reviewed and authorized source-bound workflow, followed by measured pilot evidence |
| Later profiles | P15–P18 enterprise; P19–P21 supported routing and credential profiles; P22, P23b and P24 operations/evidence/DR | Each claim waits for its own contract and proof; no automatic expansion of the first milestone |
| Separate operations | P25 contract work only | A new operation/provider receives its own reviewed implementation backlog |

## P00 — Contract packet and acceptance charter

- **Depends on:** none.
- **Small deliverable:** define the two content modes, source-use approval, authority versions, operation/request/action identities, admission and STOP boundaries, evidence vocabulary, noncoverage and this backlog. Keep one factsheet version and one recipient per job in the first workflow.
- **Property and proof:** an approved-source request contains only job ID and operation ID; agent fields, recipient overrides and self-asserted trust cannot enter that mode. Contract examples distinguish allow, hold and refusal. Reviewers must reject any example that silently falls back to free text or treats AI-clear as permission.
- **Merge/deploy boundary:** docs and inert fixtures only. No new authority or service behavior.
- **Lane/review:** G1 authors this packet. Warden review and Firepower's bounded source/approval review are confirmed roles; Gx's confirmed contribution is B0 input only. Implementation ownership remains separate.

## P01 — Request-digest conflicts on both replay paths

- **Depends on:** P00 identity contract.
- **Small deliverable:** pin `intentKey = (authority_scope, job_id, operation_id)`, using a server-derived typed personal-owner or tenant scope. Persist the initial request digest and compare it in both early lookup and unique-conflict recovery. Require operation identity in new modes; keep request, revision and frozen MIME/action digests distinct. Define an explicit pre-admission revision API with its own `revision_request_id`, revision digest and expected-current-version CAS; revision never masquerades as changed-input replay.
- **Property and failing test:** the same intent and initial request return its existing result; changed initial arguments conflict. Concurrent conflicts create one intent. A repeated revision request with the same digest is idempotent, changed revision arguments conflict, and stale CAS refuses. Revisions supersede prior pending authority only before admission. Once any revision has an admitted attempt, every revision and new-nonce path refuses a second invocation for the intent. Removing either replay comparison or the intent-wide fence must fail a real-DB regression. New operation IDs still consume the same job quota.
- **Merge/deploy boundary:** independently mergeable correctness change after compatibility review; no retry policy or source auto-send enablement.
- **Lane/review:** proposed executor lane, open; Warden plus a non-author G1/G4 partner.

## P02 — Immutable owner-approved record, template and use manifest

- **Depends on:** P00.
- **Small deliverable:** additive storage and narrow authenticated owner APIs for immutable structured record versions and a use manifest binding the approved template, mapping, customer, recipient and purpose. Require owner-decision authentication and capability, not merely matching owner ID. A same-owner agent OAuth token, private MCP URL credential or tool credential cannot approve records/templates/use. Start with owner-reviewed factsheets; no new CRM integration or arbitrary document ingestion.
- **Property and failing test:** another owner cannot read, approve or use a record; a same-owner agent credential cannot perform an owner decision through any accepted authentication path, alias or fallback. An edited record is a new version, not replacement bytes; a hash alone cannot create approval. Tests cover immutable reads, credential-class separation, unapproved/revoked use, bounded field types and valid authenticated owner approval.
- **Merge/deploy boundary:** feature off. Allocate the next migration through the merger; build and test the compatible feature-off fallback before any live migration.
- **Lane/review:** proposed source-data lane, open; G1/G4 cross-review with Warden authorization review.

## P03 — Source-bound authority v2, with personal ownership preserved

- **Depends on:** P02 and P00's version contract.
- **Small deliverable:** job draft/confirmation binds the source version/digest, use manifest, content mode, template/mapping/renderer version, recipient and purpose alongside existing owner, agent connection, provider grant, quota, expiry and policy. Confirmation requires an authenticated owner-decision capability; same-owner agent credentials cannot confirm, enroll channels or alter owner policy through any authentication path. Continue reading/verifying personal v1 history unchanged, subject to P05's durable execution restriction.
- **Property and failing test:** changed source, recipient, mapping or policy requires a new confirmation; wrong-owner/customer source and same-owner agent confirmation are refused across direct routes, aliases and private-URL fallback. The confirmation view and signed server authority agree. Golden v1 hashes and historical receipts remain unchanged while activated strict scopes refuse legacy creation/admission.
- **Merge/deploy boundary:** source-bound job creation stays gated; no implicit organization adoption or migration of existing jobs.
- **Lane/review:** proposed authority lane, open; Warden and Gx contract review.

## P04 — Strict source-only MCP action and server rendering

- **Depends on:** P01, P02 and P03.
- **Small deliverable:** a discriminated source-only action accepts job ID and operation ID. The server resolves approved data, recipient and mapping, then reuses deterministic rendering to freeze MIME. No caller-provided fields, `to`, custom prose, source override, arbitrary headers or remote fetch.
- **Property and failing test:** valid approved input produces the expected frozen bytes. Supplied overrides, absent/revoked source, wrong ownership/customer and source mismatch refuse before model or provider access. Removing source lookup/binding must fail with zero allowed provider invocations. Positive recipient/time/field controls remain valid.
- **Merge/deploy boundary:** prepare/held only until P12. Ordinary owner approval of a prepared source request must not bypass that release gate.
- **Lane/review:** proposed rendering/MCP lane, open; G1/G4 contract cross-review and an independent executor reviewer.

## P05 — Strict-profile activation and mandatory prose holds

- **Depends on:** P00, P03 and P06's durable control protocol; hold classification can be developed alongside P04, but activation cannot precede P06.
- **Small deliverable:** classify all caller-written v2 prose/template values as provenance-unknown and require exact-version approval. Persist strict activation for the actor/account/connection with a policy epoch; activation denies new v1 creation and legacy provider admission with `migration_required` across canonical/alias MCP tools, owner routes, workers and private-URL fallback. Matching owner ID does not convert an agent credential into owner authority. Preserve model review as an additional hold source.
- **Property and failing test:** agent-filled templates/custom bodies stay held when AI is clear, unavailable or disabled. A strict scope cannot bypass the policy by making a new v1 job, approving an old version, using another alias/credential route or racing activation with a worker. Test each route plus durable restart/fallback behavior. Missing sources, trusted-looking labels and empty review reasons cannot create source-bound auto-send. A valid newly confirmed supported authority remains usable within the release gate.
- **Merge/deploy boundary:** activation blocks future legacy admissions without rewriting historical authority or receipt bytes. It does not recall an already admitted action. Migration requires explicit fresh confirmation. The compatible feature-off binary must retain the strict restriction; turning a new feature off cannot reactivate v1 automatic fields.
- **Lane/review:** proposed gate lane, open; Warden and non-author G4/G1 reviewer.

## P06 — Durable epochs, revocation, STOP and one lock order

- **Depends on:** P03 and P01; coordinate the schema with P02.
- **Small slices:** **P06a** defines durable owner/job/connection/grant/source/use/template/policy/coverage and channel-control epochs, including actor/account/connection strict activation, with one lock order. **P06b** routes every relevant writer through it: browser/MCP aliases and private-URL fallback, source/grant revocation, owner controls, voice decisions, pre-admission revisions and worker admission. Each slice includes its own regressions; the second is not permission to leave an alternative writer unconstrained.
- **Property and failing test:** a control committed before admission prevents that admission across two processes sharing one DB. An action admitted first is labeled as potentially in flight. Tests interleave STOP, source/grant revocation, approval, startup and worker selection; they fail when one writer skips the epoch/lock checks. No process-local pause or startup cancellation may erase another replica's valid work.
- **Merge/deploy boundary:** one live application instance until all writer/startup paths and two-process tests pass. Phone routes are covered with offline fixtures only; phone enrollment remains held.
- **Lane/review:** proposed concurrency lane, open; Warden C/G review partner and a separate lock-order reviewer.

## P07 — Transactional outbox, worker leases and one-attempt admission

- **Depends on:** P06 and P01.
- **Small slices:** **P07a** adds the durable outbox and fenced scheduling leases, with lease ownership explicitly distinct from action authority. **P07b** uniquely commits one provider-attempt claim for `(authority_scope, job_id, operation_id)` across all proposal revisions, together with quota and pre-dispatch evidence, before IO. Only the original admitting worker receiving an unambiguous acknowledgment of that original commit may invoke the provider. Ambiguous acknowledgment makes the attempt UNKNOWN; a later lookup/acknowledgment, lease acquisition or restart supplies no IO permission. Disable hidden adapter/transport retries. A version number or a new approval nonce never creates another attempt for that intent.
- **Property and failing test:** two workers competing across different revisions still permit at most one local stub-provider invocation for the intent. Revision CAS races with admission; the winner either supersedes pending authority before admission or causes the revision to refuse. Crash before/after claim commit, ambiguous DB acknowledgment, lost provider response, lease expiry and restart never create a second invocation. UNKNOWN retains capacity; leases, post-admission revisions and new nonces cannot mint another attempt.
- **Definite refusal:** the adapter must positively classify documented nonacceptance before recording `NOT_SENT`; a generic error is insufficient. Release that attempt's reservation exactly once in the outcome transaction under the explicit adapter policy, while retaining its terminal intent-wide attempt claim. Never replay it automatically or through a revised version/new nonce. A genuinely new authorized intent uses a new operation ID and the remaining job quota; UNKNOWN is neither released nor reclassified from a negative search.
- **Merge/deploy boundary:** fixture-only until the provider adapter and recovery behavior have exact-head review. No exactly-once-delivery claim, automatic resend or UNKNOWN refund.
- **Lane/review:** proposed executor-worker lane, open; Warden plus a separate failure-orchestration reviewer.

## P08 — Owner review shows source provenance and complete resolved rules

- **Depends on:** P03, P04 and P05.
- **Small deliverable:** display source version/use approval and deterministic mapping for source-bound work; unknown provenance for agent prose; full recipient, sender/grant, count, expiry, purpose, content mode and approval rules. Preserve supported natural-language clarification and server-returned confirmation authority.
- **Property and failing test:** actual form → server draft → review uses the returned authority, not optimistic client state. Conflicting/unrecognized wording cannot confirm; a changed source or stale preview cannot approve different bytes. AI-clear does not hide the required review of agent prose.
- **Merge/deploy boundary:** no client-generated authority and no phone activation. UI can merge while source auto-send remains off.
- **Lane/review:** proposed G4/Aman UI lane, open; G1 contract cross-review and Gx UI review. Coordinate touched files before claiming them.

## P09 — Single-use approval nonce for immutable full action bytes

- **Depends on:** P03, P05, P06 and P07; UI integration depends on P08.
- **Small deliverable:** bind a short-lived single-use nonce to the intent key, immutable full MIME/action digest and version, source/use/template/renderer binding, policy/coverage revisions, approver actor/resource rights, provider grant and authenticated caller/agent connection. Recheck all current epochs under the final admission locks. Phone proof additionally binds the matched outbound call and session, verified destination, configuration and current opt-in epochs. Consume proof, reserve capacity and claim the one intent-wide attempt atomically; record a consumed refusal in that transaction too. A same-owner agent token/private URL credential never supplies owner approval, source approval or channel enrollment authority through any route.
- **Property and failing test:** changing any bound value, stale source/use/template/renderer/policy/coverage/actor/resource/grant/caller state, wrong call/session/destination, phone opt-out or expiry/replay refuses. Test the entire binding matrix and same-owner agent credential misuse across owner routes, aliases and fallbacks. A new nonce for an already admitted intent cannot invoke the provider again, even after `NOT_SENT`. Pre-admission revision invalidates the old nonce; post-admission revision is refused. Test browser and phone-shaped offline proofs independently.
- **Merge/deploy boundary:** no activation of phone enrollment or a call. Preserve the distinction between approval already applied and a later opt-out; STOP cannot recall an already admitted provider operation.
- **Lane/review:** proposed approval-authority lane, open; Warden and Firepower's confirmed bounded source/approval review, with any additional security/consent reviewer separately assigned.

## P10 — v2 receipt coverage, provenance and export

- **Depends on:** P03, P04, P06, P07 and P09.
- **Small deliverable:** link confirmed authority, source/use manifest, operation/request/action digests, approval, admission and outcome in versioned signed evidence. Extend the offline verifier and export without altering historical signed payloads or their interpretation.
- **Property and failing test:** exported source/action linkage verifies; changed manifest/MIME/approval bytes fail. Refused, held, admitted and UNKNOWN paths have defined evidence, including consumed approvals. Missing-tail detection is claimed only relative to an independently known checkpoint; a self-contained shortened export is not proof of completeness.
- **Merge/deploy boundary:** minimize raw content and exclude credentials from routine logs. P23a's minimum personal-processing controls are required before P12; independent checkpoints and paid observability follow P23b. Basic enforcement/evidence is not a paid bypass.
- **Lane/review:** proposed evidence lane, open; Gx/Warden independent verifier review.

## P11 — Stable hosting, supervision, backup and key custody

- **Depends on:** P00; starts in Wave 0 and tracks each later schema/image.
- **Small slices:** **P11a** establishes a reviewed stable upstream and canonical route/callback contract. **P11b** adds host/process supervision and independent DNS, public OAuth/MCP challenge and exact-bundle health observations. **P11c** documents key custody and proves backup restore plus schema-compatible feature-off fallback.
- **Property and failing test:** an alive PID with broken public DNS/transport is unhealthy; wrong issuer/bundle/pin fails readiness. A disposable restore reproduces expected migration hashes and preserves acknowledged authority/attempt state and strict-profile epochs. The feature-off fallback still rejects v1 creation/admission in activated scopes. Recovery refuses stale backups that could erase claims or restrictions. Health checks are read-only and never retry a write.
- **Merge/deploy boundary:** infrastructure code/docs can merge before operation. No Azure login or new administrator access is assumed; Azure work is deferred without access. A live migration needs exact source/image/schema identities, protected backup, compatible fallback and root's controlled operation.
- **Lane/review:** root owns live operations; implementation lane is otherwise open. G1 read-only health support and Warden operational review are proposed.

## P12 — Guarded source-bound auto-send enablement

- **Depends on:** every P01–P10, P11 safety gates and P23a; P00 contract accepted. P23b and enterprise P14–P18 are not prerequisites for this personal milestone.
- **Small deliverable:** join the reviewed components behind a narrowly scoped server flag. Enable only the approved-record workflow with established provider and evidence semantics.
- **Property and failing test:** every missing prerequisite keeps the action held/refused through browser, phone-shaped approval, MCP aliases, private-URL fallback and background paths. Same-owner agent credentials cannot approve the source/template/use manifest, confirm the job, enroll a channel or issue owner approval through any accepted authentication path. The strict profile rejects new v1 creation and legacy admission, including after feature-off fallback. Separately authorized live proof uses fresh genuinely owner-approved records and a fresh job with an owned recipient; verify source → frozen MIME → intent-wide admission → provider outcome/capacity plus P23a disclosures, access and retention behavior.
- **Merge/deploy boundary:** source merge is not enablement. Root is sole deployer; final exact-head reviews, compatible fallback and fresh live-test authorization are required. Historical Dana proof is not reused. No phone enrollment/test is part of this gate.
- **Lane/review:** root release lane; Warden acceptance review with independent evidence review.

## P13 — Measured single-workflow paying pilot

- **Depends on:** P12.
- **Small deliverable:** recruit eligible users for the one supported workflow and instrument complete setup, agent connection, first authorized action, exception handling and total cost. Test willingness to pay rather than assert it.
- **Property and proof:** report completion rate, p50/p90 setup time, abandonment/prerequisite failures, review burden and cost per authorized job from at least ten eligible observations. Five-minute onboarding is a target, not a result. Record negative findings and stop/adjust criteria.
- **Merge/deploy boundary:** measurement must not widen scopes, recipients or authority. No scale/availability SLA from a small pilot.
- **Lane/review:** product/pilot lane, open; user workflow owner and independent measurement reviewer.

## P14 — Enterprise B0 contracts before organization behavior

- **Depends on:** P00; starts in Wave 0 alongside the personal workflow.
- **Small deliverable:** specify workspace, principal, capability and resource-grant concepts; read projections; shared revocation; bootstrap; actor/approver separation; and the personal-to-enterprise boundary. Incorporate the existing tenancy and concurrency plans.
- **Property and proof:** a contract matrix distinguishes two tenants, one person with multiple memberships, equal email text with distinct identities, personal grants and organization grants. Every operation has explicit capability and read-visibility requirements. Reviewer fixtures reject domain-based membership and implicit administrator approval.
- **Merge/deploy boundary:** contract/docs only. Gx's confirmed contribution is B0 input only; this does not authorize enterprise implementation or data migration.
- **Lane/review:** G1 packet author coordinates Gx's B0 input and Warden review. Enterprise implementation lanes remain open.

## P15 — Isolated tenant/principal/resource foundation

- **Depends on:** P14 and P06; coordinate with P03/P10 versioning.
- **Small deliverable:** introduce tenant-scoped principals/resources/grants for a future authority v3, retaining explicit personal-owner behavior for v1/v2. Add isolation constraints and narrow migration/adoption rules.
- **Property and failing test:** two tenants cannot select, mutate, export or approve each other's resources even when labels/emails match. Personal jobs remain personal; no historical v1/v2 authority or signature is rewritten into an organization.
- **Merge/deploy boundary:** enterprise feature off, additive schema and compatible fallback. No automatic adoption of personal OAuth grants.
- **Lane/review:** proposed tenancy backend lane, open; Gx B0 contract review and Warden isolation review.

## P16 — Tab-local, server-confirmed workspace context

- **Depends on:** P15 and P14.
- **Small deliverable:** browser, MCP and OAuth flows bind the initiating workspace/context at the server. A tab's selection is not global ambient authority; callbacks return to and validate the initiating context.
- **Property and failing test:** concurrent tabs/workspaces, stale views and context changes cannot redirect a confirmation, callback, resource grant or tool call. Server mismatch requires refresh/reconfirmation. Include valid independent-tab flows.
- **Merge/deploy boundary:** preserve personal flows; no enterprise enablement until backend enforcement and UI agree. A dropdown alone never supplies isolation.
- **Lane/review:** proposed G4/Gx UI plus auth-backend lane, open; cross-review each side of the contract.

## P17 — Explicit resource grants, delegation roles and bootstrap

- **Depends on:** P15 and P16; P09 for approval consumption.
- **Small deliverable:** implement explicit capabilities/delegation and resource grants. Personal bootstrap remains one owner. Two independently authenticated founding principals must jointly establish the strict organization profile and its initial resource/approver grants. Admission stays denied during incomplete formation or loss of the required active principals. Administrator status alone never implies approver authority or permission to create those initial grants unilaterally.
- **Property and failing test:** self-created role labels, administrative access, duplicate representations of one principal, stale delegation and privilege escalation cannot satisfy the two-principal requirement. Test partial bootstrap, duplicate principal identities, suspension/loss of either required founder and unilateral initial grants; each denies admission. A valid jointly established profile and bounded explicit delegations succeed. Two principals do not prove two distinct humans.
- **Merge/deploy boundary:** choose the organization profile explicitly; no silent policy change to personal owners and no emergency path that silently waives approval or restores admission without the required principals.
- **Lane/review:** proposed authorization lane, open; Warden and a non-author enterprise reviewer.

## P18 — Legitimate IdP linking, SSO/SCIM and suspension

- **Depends on:** P15, P16 and P17.
- **Small deliverable:** add supported IdP subject linking and lifecycle contracts, then one IdP integration. Suspension/revocation updates shared authority rather than merely hiding a UI.
- **Property and failing test:** equal email/domain, renamed account or reused address cannot merge principals or transfer grants. Suspended identities cannot obtain new admission across browser/MCP/workers; authorized relinking has a reviewed proof and audit trail.
- **Merge/deploy boundary:** no account/IdP change from source merge. Support and administrator prerequisites must be measured and disclosed.
- **Lane/review:** proposed enterprise identity lane, open; Warden auth review and Gx context review.

## P19 — Supported runtime SDK and confined tool routing

- **Depends on:** P00 boundary contract and P06/P07; enterprise deployment also needs P15–P17.
- **Small deliverable:** one supported runtime exposes conventional mail tools through the gateway, keeps provider credentials out of the agent, and documents required whole-process confinement/egress/credential controls. Normal-looking tool names are an adapter, not an enforcement mechanism by themselves.
- **Property and failing test:** owned local fixtures show that all supported writer paths use the same gateway authority and that the confined process lacks an alternate provider credential/path. A tool rename, local hook or skill alone must fail the coverage assessment.
- **Merge/deploy boundary:** no interception or credential capture of third-party native connectors; no universal hosted-ChatGPT routing claim. Coverage applies only to the explicitly supported controlled runtime.
- **Lane/review:** proposed runtime-adapter lane, open; Warden boundary review and Gx ADR owner.

## P20 — Workspace administrator inventory and write-path coverage

- **Depends on:** P14 and P19; applicable enterprise foundation from P15–P18.
- **Small deliverable:** inventory supported Google Workspace clients, OAuth grants, delegation, APIs, browser/human actions and other write paths. Define the exact administrator controls and selected scopes needed for the claimed deployment.
- **Property and proof:** a controlled test tenant demonstrates each claimed path's allowed/blocked state, with untested/uncontrolled paths explicitly listed. Send, modify/trash and permanent delete have separate scope/operation coverage. Marking an application Trusted for all scopes is not the least-privilege solution.
- **Merge/deploy boundary:** test plan/automation can merge; administrator changes require authorized account access and a rollback plan. Personal-account OAuth alone cannot satisfy this milestone.
- **Lane/review:** proposed Workspace admin lane, open; Warden's offered C/G test-plan/review role and Gx boundary review.

## P21 — Client-compatible credential hardening profiles

- **Depends on:** P00 and P19; tenant resource binding requires P15/P16 where applicable.
- **Small deliverable:** document the audience/TTL/revocation baseline and supported bearer-token limitations. Add DPoP or mTLS only for a client and server combination that actually supports it.
- **Property and failing test:** wrong audience, expired/revoked token and mismatched proof/key fail; the supported legitimate client succeeds. A bearer-only client is labeled as such, not silently described as proof-of-possession protected.
- **Merge/deploy boundary:** client compatibility must be proven before enabling a new profile. DPoP does not establish machine identity, action-body integrity or approval of message content.
- **Lane/review:** proposed OAuth/client lane, open; Warden auth review and the supported-client adapter owner.

## P22 — Replica fairness, budgets, backpressure and measured SLOs

- **Depends on:** P06/P07 two-process/one-DB proof; P15 for tenant fairness; P11/P13 for operational and workload evidence.
- **Small deliverable:** bounded per-tenant queues, concurrency/rate budgets and fair scheduling. Separate notification coalescing from immutable approval sessions and action identity.
- **Property and failing test:** a busy tenant cannot starve another; overload produces bounded pending/refused states, never implicit approval. Restart, lease churn and concurrent limits preserve admission uniqueness and UNKNOWN capacity. Load tests publish workload, environment, latency/error distributions and failure behavior.
- **Merge/deploy boundary:** replica count and SLO claims change only after measurement and startup-safety review. No scale promise from synthetic throughput alone.
- **Lane/review:** proposed reliability/concurrency lane, open; Warden C/G reviewer and an independent measurement partner.

## P23 — Personal processing safeguards, then operational evidence

P23a is required for the first personal release. P23b is a later operational increment; completing P23a does not claim that later capability.

### P23a — Minimum personal processing, disclosure and content access

- **Depends on:** P00, P02, P03, P08 and P10; no enterprise dependency.
- **Small deliverable:** define and implement the personal data inventory, purposes, processing disclosures/consent, retention/deletion behavior and authenticated content-access projections. Cover records, full messages, decisions, receipts, exports and diffs. Disclose model/provider processing; distinguish content-free generic notices from separately consented exact-version phone readout. Treat hashes as potentially sensitive, not anonymization; keep credentials and raw transcripts out of routine logs.
- **Property and failing test:** another owner or same-owner agent lacking the required read capability cannot retrieve protected content through a route, export, diff or log. Tests verify the stated retention/deletion policy, processing disclosures and channel-consent separation with valid owner controls. Do not promise deletion from uncontrolled third-party systems.
- **Merge/deploy boundary:** required before P12, including its live proof; no new phone enrollment or testing. Basic privacy, content access and enforcement cannot depend on a paid observability tier.
- **Lane/review:** proposed personal privacy/evidence lane, open; Warden authorization review and a separately assigned privacy reviewer.

### P23b — Independent checkpoints and permissioned SIEM projections

- **Depends on:** P10 and P23a; organization view permissions additionally require P15/P17 only for that profile.
- **Small deliverable:** independent evidence checkpoints, narrowly permissioned exports/SIEM projections and operational retention controls consistent with P23a.
- **Property and failing test:** modified, reordered or truncated history is detected relative to a retained trusted checkpoint; restricted viewers cannot retrieve hidden content through operational projections. Tests distinguish an incomplete self-contained export from a checkpoint-backed completeness claim.
- **Merge/deploy boundary:** later than the minimum personal gate. Paid observability may add operations/reporting features, never remove enforcement or create an approval bypass. WORM is a retention mechanism, not certification.
- **Lane/review:** proposed operational evidence lane, open; Warden and a separately assigned verifier reviewer.

## P24 — Key rotation, restore, DR and later multi-region

- **Depends on:** P06/P07, P10/P11, P22 and P23b.
- **Small deliverable:** reviewed key rotation and verifiable historical key lineage, restore/DR runbooks and rehearsals. Multi-region is a later child project only after acknowledged-claim preservation and single-writer fencing are proven.
- **Property and failing test:** old valid receipts remain verifiable after rotation; revoked/new signing authority is distinguished. Failover or restore cannot erase acknowledged claims or strict-profile epochs/restrictions, reset quota or replay UNKNOWN. A stale former primary cannot admit external IO.
- **Merge/deploy boundary:** no production key rotation, restore or active-active deployment from this plan. A failed proof leaves the affected system paused; no optimistic recovery send.
- **Lane/review:** root operations with proposed DR/key-custody lane, open; Warden plus independent recovery reviewer.

## P25 — Additional operation/provider contracts only

- **Depends on:** P00 and measured P13 demand; reuse applicable boundary/enterprise contracts.
- **Small deliverable:** one machine-readable contract per proposed operation/provider: Gmail trash versus permanent delete, Instagram, X or TikTok each gets separate primary API review, scopes, eligibility, resource/data authority, approval, idempotency, ambiguity, rate and recovery semantics.
- **Property and proof:** contract examples distinguish reversible/irreversible effects and unknown outcomes, and identify unsupported APIs before implementation. No existing Gmail-send receipt or approval is accepted as authority for another action.
- **Merge/deploy boundary:** contract-only at this ID. Each actual adapter needs a later implementation/review/proof sequence. No blanket POST proxy, universal connector claim or undeclared scope expansion.
- **Lane/review:** connector research lanes open by provider; Warden boundary reviewer and a non-author provider-contract reviewer.

## Review and lane coordination

Confirmed roles are G1 authoring the packet, Warden reviewing it, Firepower providing bounded source/approval review, and Gx providing B0 input only. Other named review pairings and all implementation assignments above are proposals, not additional claims. Root coordinates overlapping files and remains the sole live operator; no other lane should start a second worker, import a key or mutate the live service.

Use this room claim format, after root agrees the scope:

`@agent working_on [Pxx or Pxxa] deliverable=<bounded change> files=<owned paths> depends_on=<IDs> reviewer=<non-author partner> head=<exact SHA when ready> status=<planned|implementing|review>`

Use this review handoff format:

`@reviewer review_requested [Pxx] head=<full SHA> property=<invariant> evidence=<test/report paths> limits=<what was not tested> release=<feature-off|no deployment>`

A claim is not a review key. A helper under the same G1 principal provides useful independent execution/source checking but does not count as an additional external reviewer. Every key names the exact head and separates author tests, independently rerun tests, static review, rehearsal and actual live evidence. Do not carry a key to a changed head.

## Onboarding and acceptance charter

The first user journey is connect the supported account, approve one factsheet/template/use manifest, confirm the resolved job, connect the supported agent, request one owned action and inspect its evidence. Measure the whole eligible-user path, including agent setup. Record provider/admin waits and unsupported clients explicitly rather than remove them from the denominator without explanation.

The engineering charter is one reviewed invariant per small change, positive controls beside refusals, real isolated PostgreSQL where transactions matter, and stub providers until a separate live proof is authorized. Source snapshots, exact test commands, hashes and limits travel with each review. The customer charter is useful work with fewer uncertain exceptions; a larger connector catalog or a lower model score is not a substitute for that evidence.
