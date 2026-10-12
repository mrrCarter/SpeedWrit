# SpeedWrit source bound action gateway specification

Status: Proposed contract for review. This packet changes documentation only. Implementation and activation follow the separately reviewed [PR plan](pr-plan.md). The [research review](research-review.md) records the supplied reports, primary sources and corrections.

SpeedWrit should first govern one concrete workflow: an owner approves a factsheet and template, confirms a bounded Gmail job for Dana, and the server renders and submits that approved content. Agent-written prose follows a separate path that always requires approval of the exact frozen message. Both paths enforce current authority at final admission and preserve uncertain outcomes without automatic resend.

The product promises enforcement on identified execution paths. Connecting SpeedWrit does not intercept another connector's independently authorized requests. Broader coverage requires control of provider credentials, the agent's available execution paths, and the applicable provider or runtime restrictions. Approved sources address content origin; they do not establish factual truth, benign intent or permission to disclose everything in a record.

## Baseline and first release

The observed deployment is runtime `653d1571c109b95db27a0fd3247c5bfe03abb889`, immutable image `d3b7439d`, behind the owned-domain Worker. Public recovery, rollout and the receipt pin were independently checked. Phone approval capability is deployed, but Carter has not opted in or confirmed a fresh test job; the live phone decision proof remains on hold. Main `887b8b3f5d2985ff19d2a10877e53b743c03b908` includes later UI labels, loading polish and transport health tooling and is not the deployed application.

Existing owner/job/agent binding, deterministic limits, frozen versions, approval, quota reservation, signed receipts and conservative UNKNOWN handling are building blocks. Current template fields are supplied by the agent; an allowlisted recipient and clear Jev review do not prove the fields came from an approved factsheet. Source approval, tenant roles and durable multi-replica admission are proposed work, not existing guarantees. [Implemented boundary](../adr/0001-supported-action-boundary.md), [current proposal path](https://github.com/mrrCarter/SpeedWrit/blob/653d1571c109b95db27a0fd3247c5bfe03abb889/packages/job-send/src/executor/backend.ts).

The first enabled workflow supports one owner, one approved factsheet version, one approved template version, one bound sender and agent connection, one recipient and a bounded count/expiry. It retains existing text-only restrictions. Gmail trash, permanent deletion, attachments, shared mailboxes, organization delegation and social publishing need distinct capability and provider contracts.

## Coverage profiles

Coverage is an explicit deployment record scoped to an actor, account, operation and execution path. Each record identifies controlled and excluded paths, proof type, reviewer, observation time, relevant configuration/version and refresh conditions. Unknown or stale proof never upgrades a coverage claim. Internal gateway checks still apply when an external path is excluded; a broader coverage profile is unavailable until its required controls are verified.

| Profile | Permitted claim after its gates pass | Remaining boundary |
| --- | --- | --- |
| Gateway routed | Every action admitted through this gateway is checked against its confirmed authority | Separate native connectors, browser sessions, tokens and provider automations are outside this path |
| Provisioned individual agent | This supported agent's listed mail execution routes use the gateway and receive no provider write credential | Consumer Gmail has no Workspace administration plane; unrelated agents and human/account paths remain excluded |
| Controlled enterprise agent | The named agent identities and enumerated write paths are governed, with measured administrator/runtime restrictions | Privileged administrators, first-party clients, human web/mobile actions and remaining paths must be individually covered or explicitly excluded |
| Managed runtime | The listed process/tool/credential/egress paths are confined to supported gateway execution | A Bash-only sandbox or hook is insufficient; inherited credentials, MCP servers, file tools, browsers and permitted relays need separate control |

A hosted ChatGPT conversation with both SpeedWrit and an independent write-capable Gmail connector has gateway-routed coverage. Installing an app does not provision or confine that entire hosted agent. A supported SDK/runtime can register an ordinary mail tool such as `send_email` whose executor is the gateway; the user need not name SpeedWrit in each instruction. Enforcement follows the executor and its credential authority, rather than the model choosing an enforcement product.

For Workspace, prefer explicitly selected necessary OAuth data over blanket Trusted access. Inventory every scope that permits the claimed operation, existing grants, SMTP clients and relay authentication, POP/IMAP access, app passwords where available, domain-wide delegation, delegated mailboxes, Apps Script/automation, browser/mobile sessions and privileged administrative changes. Policies block or permit clients; they do not reroute their requests. Record propagation and residual in-flight limits through actual owned-tenant observations. [Google app controls](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data), [Gmail send authorization scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [delegation](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation), [SMTP relay](https://knowledge.workspace.google.com/admin/gmail/advanced/route-outgoing-smtp-relay-messages-through-google).

## Approved data and templates

An approved record has a stable resource identity and immutable version. Its use manifest binds the owning personal scope or future tenant, source identity and lineage, schema and content digest, permitted customer/audience, purpose, classification, approver and approval/revocation revision. Record approval and job confirmation are separate decisions. Agents cannot approve records, relabel another client's record or transfer their use rights by submitting metadata.

Start with owner-authenticated manual factsheets or one authorized system-of-record adapter. Schema-bound fields, size limits and server-derived ownership prevent arbitrary text/file substitution. The owner reviews the record, audience and permitted use before approval. A template also has an immutable version, digest, renderer version and approved mapping from record fields; output limits and the current email restrictions still apply.

An edit creates a new version. It does not change an existing job's pinned source, template or message. Source/template/use revocation blocks future admissions and invalidates unconsumed approval authority. Already-admitted provider work remains separately visible. A signed use manifest establishes an authorization decision about known content, not the accuracy or harmlessness of that content.

## Two content paths

| Path | Agent input | Server behavior | Permission to send |
| --- | --- | --- | --- |
| Approved source | Strict `job_id` and required `operation_id` | Resolve the job's approved source/template versions and mapping; render and freeze the complete message server-side | Eligible for automatic admission only after all source, policy, identity, capacity, expiry, STOP and coverage-profile conditions pass |
| Agent prose | Job and required operation identity plus proposed wording | Store a new immutable version, display full content and mark external provenance unknown | Always HELD for exact-content approval; AI clear never substitutes for that approval |

The approved-source API rejects `to`, field overrides, free prose, attachment references, alternative records/templates and unknown keys. A tool alias or adapter must reach the same checks. Reject prohibited input before provider access. A source render may prepare a held version during rollout; **all source-mode provider admission remains disabled until P12**, including browser or phone approval, worker execution and alternate API paths.

Natural-language rules can propose a policy, not create authority. Supported structural limits compile into checkable fields; contradictions or unsupported hard requirements require clarification before confirmation. Semantic preferences such as “don't sound rude” remain visibly AI-assisted or human-reviewed. An AI finding can add a hold; it cannot waive a deterministic refusal, source restriction or mandatory prose approval. An explicit required-review outage creates a hold. No probabilistic model is needed to establish approved-source origin.

Historical authority-v1 objects and signed evidence retain their original bytes and interpretation. They are not relabeled as source-approved. Strict source-profile activation is a durable policy epoch for the covered actor/account/connection scope. It stops new v1 job creation and refuses v1 provider admission with `migration_required` until the owner freshly confirms v2 authority. This restriction includes previously held proposals, legacy tools, SDK aliases, private connection URLs, owner approval routes and workers. A compatible feature-off fallback must preserve this restriction or keep admission disabled. Unmigrated legacy-only scopes remain labeled with their limited coverage.

New source-bound personal jobs use an explicit versioned authority contract; future tenant authority is another explicit schema/version transition. Importing an old job or personal grant into a new mode/workspace requires a reviewed migration and fresh confirmation, never a silent upgrade. Agent credentials belonging to the same owner do not confer owner authority: they cannot approve source/template/use trust, confirm jobs or consume a human approval through any authentication path or alias.

## Authority and immutable action

Before confirmation, the server returns the complete authority to be reviewed: actor scope, provider account and connection, agent connection, operation, content mode, pinned source/use/template/mapping, recipient, purpose, structural and semantic-rule treatment, count/rate limits, expiry, approval policy and coverage reference. Confirmation names its full digest. Adding metadata later must not silently widen an already signed authority.

Resolve the authorized sender and recipient server-side. Produce canonical content and the final MIME once, including any variable headers, encoding and stable identifiers. Store the MIME and its byte digest before approval or admission; send the stored bytes rather than re-rendering a mutable record. The review/readback shows sender, recipient, subject, full decoded body, applicable source provenance and important holds, and binds them to that frozen version. Renderer or encoding changes require a new version and decision.

| Identity | Purpose | Required behavior |
| --- | --- | --- |
| Operation ID | Names one intent under `(personal owner or tenant scope, job_id, operation_id)` | Job authorization binds the caller; ordinary replay resolves that intent without another render or attempt, and changed arguments cause a conflict |
| Request digest | Compares the normalized semantic request before replay | Excludes credentials and unstable transport noise; includes mode and all action-changing inputs |
| Frozen content/MIME digest | Identifies the immutable provider submission | Changing content, source binding or relevant authority invalidates approval and creates a new version |
| Approval nonce/capability | Grants one bounded decision about a version | Independent of the operation ID/digest; one use, expiry and current actor/grant/authority binding |
| Provider attempt ID | Identifies the locally admitted external attempt | Never used as a presumed Gmail idempotency guarantee |

Persist request digests on both the early-replay and concurrent-uniqueness paths. Current replay returns an existing proposal without checking changed arguments; the new contract must refuse such conflicts. Legacy rows with no recoverable original request digest require explicit compatibility handling, rather than guessing from rendered content. The authoritative intent tuple has at most one admitted provider attempt across **all versions**. Caller aliases, content hashes, revision IDs and approval nonces cannot create another attempt for that intent.

Before admission, a separate revision API uses its own revision request ID/digest and expected-version compare-and-set. A successful revision stays within the original intent and supersedes its older approval; ordinary changed-input replay remains a conflict. After admission, acceptance or UNKNOWN, revision or a new nonce cannot authorize a second invocation. Replays return the existing intent's current status. A genuinely new intent still consumes the same job limits and cannot reuse an already dispatched version as renewed authority.

Browser and phone decisions reach the same final authorization transaction. A nonce binds the intent tuple, frozen action/MIME digest and immutable version, source/use/template/renderer/policy/coverage revisions, actor/resource/grant/caller authority epochs, expiry and channel. A phone decision also binds the matched outbound call/session and current destination, configuration and opt-in revision. Check and consume these bindings atomically with final admission; a refused consumed decision retains signed evidence.

Approval does not override a hard denial. Phone authority remains separate opt-in for an explicitly authorized approver and exact draft; handset control is not speaker identity. Enterprise voice enrollment requires per-principal destination verification, current resource rights and organization policy, rather than reusing the host's fixed demo phone configuration.

## Final admission and uncertain outcomes

Introduce a shared durable admission protocol before multiple application replicas. All affected writers and controls use one reviewed lock order and current authority epochs. A lease schedules work; it never authorizes a provider call. The final transaction rechecks principal/membership where applicable, connection/agent/source/use/template status, job/policy/coverage and activation revisions, exact version, required approval nonce, expiry, STOP and capacity. It conditionally consumes the nonce, reserves capacity and commits one provider-attempt claim unique to the authoritative intent tuple, across all revisions.

Only the admitting worker's original unambiguous successful commit acknowledgement authorizes that one provider request. Provider I/O occurs outside the transaction. An ambiguous or lost acknowledgement conservatively makes the attempt UNKNOWN and grants no permission to send. A later acknowledgement, database lookup, lease, restart or failover cannot restore provider-I/O permission for that attempt, even if no request was observed. Crash or lease expiry after admission is not permission for another worker to replay the attempt. Startup must not cancel another replica's sessions or reset shared authority/cursors.

STOP and revocation linearize at their durable commit: they block later admissions. They cannot cancel a provider request already admitted or recall an accepted email. Use database time, compare-and-set control revisions and current membership/resource epochs; a delayed enable cannot overwrite a newer disable. Outcome completion is bound to the exact action/attempt and cannot consume or refund capacity twice.

| Observation | Recorded state and permitted next step |
| --- | --- |
| Definitely not admitted | Refused/cancelled before provider authority; any reversible reservation adjustment is transactional and explicit |
| Provider accepted | Record the provider identifier and acceptance receipt; recipient delivery remains a separate observation |
| Documented definitive provider nonacceptance | NOT_SENT; apply only the adapter contract's explicit transactional reservation disposition. Do not automatically retry or replay this attempt |
| Ambiguous admission or provider response | UNKNOWN; retain the applicable capacity reservation and do not automatically resend |
| Message not found in Sent or recipient says it did not arrive | Append the bounded observation; it is not evidence of nonacceptance and does not authorize resend/refund |
| Later definitive provider or recipient evidence | Append attributed late evidence; do not rewrite historical signed bytes or silently reopen execution |

Gmail's documented send request has no idempotency-key parameter. Promise at most one local provider invocation for a properly deduplicated admitted action under the tested crash assumptions, with conservative reconciliation. Do not promise exactly-once provider execution or delivery. Adding read scopes solely for reconciliation requires a separate privacy/verification decision; send-only remains the initial scope. [Gmail method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

## Personal and organization authority

Personal workspace compatibility preserves owner identifiers, provider grants and historical hashes. Organizations add explicit membership and resource grants; membership, an email domain or an administrator label alone gives no sender use, message-body access or approval power. A provider mailbox, human principal, tenant and agent instance are distinct identities.

Proposed roles are member, tenant administrator, connection custodian, job controller, approver, security operator and auditor. Each role needs explicit resource scope and a paired read projection. Metadata-only administrators/auditors do not receive message bodies, prior-version diffs or full signed envelopes that contain restricted data. Where full-envelope access is allowed, return the original signed bytes; a redacted view is a separate projection and cannot be presented as that original.

Proposed B0 default: workspace selection is tab-local and server-confirmed, while global login is shared. Selection does not grant authority. Every scoped request and response carries a session-bound server context and authorization revision; exact wire names are decided in P14. Changing a tab's context invalidates its old view generation, clears privileged selections/caches/confirmation forms, and discards late successes and errors. Other tabs retain their own authorized context. Aborting or hiding a response does not cancel submitted work; reconcile the original operation without replay.

Provider OAuth initiation binds the authenticated principal and initiating workspace; a callback cannot attach the grant to whichever workspace is later displayed. Membership loss differs from expired global login. Revocation responses distinguish internal commit, new admissions blocked, admitted work in flight and provider revocation pending/succeeded/failed. The UI calls completion only for the stated property.

Proposed bootstrap default: an individual continues in a personal workspace with explicit control over their own sender and approvals. Two independently authenticated founding principals accept enrollment and jointly confirm a strict organization profile plus its initial resource-use and approver grants. Its initial administrator may invite members but cannot unilaterally give the second principal approval authority or count twice. Pending formation permits no organization provider admission. Loss of a required active principal pauses new admissions; recovery cannot silently waive the requirement.

This establishes two-principal authorization, not proof of two distinct humans. A two-person separation claim additionally requires the customer's identity/enrollment assurance, which this project has not demonstrated. One-person convenience remains the personal profile; alternative organization policies require an explicit reviewed contract. Emergency recovery preserves the stated distinction and its audit trail.

SSO links validated issuer and subject through a deliberate account-link flow; it never merges accounts from matching email/domain alone. SCIM suspension commits new admission denial and invalidates delegated pending authority. Rejoining does not resurrect old credentials, jobs or phone opt-in. Agent credentials resolve a fixed workspace/capability server-side; an agent-provided tenant selector cannot widen them.

## Evidence privacy and product packaging

New evidence links operation/request, authority, source/use/template/renderer, immutable version/content, approver channel and capability, admission/attempt, provider outcome and coverage profile. Preserve existing signed envelopes and their original interpretation. Integrity proves what was signed by the trusted service; it does not establish complete account coverage, benign intent, delivery or protection from a compromised signer.

Routine logs and generic notifications omit provider tokens, phone numbers, full transcripts and message bodies. Separately consented exact-draft phone readout intentionally processes the full recipient, subject and body through Dial; disclose that processing before opt-in. The current voice design retains a transcript hash rather than a full transcript. Content access/retention follows explicit resource rights and a disclosed purpose/period; hashes can also be sensitive. P23a's minimum processing disclosure, retention, access and minimization controls are prerequisites to P12, not deferred paid features. Export or external checkpoints require tenant authorization. Omission detection is relative to a known checkpoint, and storage immutability protects specified records/versions; it is not a blanket compliance certification or erasure guarantee for third parties.

Proposed packaging keeps deterministic policy, required exact approval, receipts and STOP useful in the free gateway. Paid features can operate richer forensics, team workflows, SIEM export, support and governance. Security correctness is not paywalled, and probabilistic anomaly detection is labeled as such. There is no default resale/training/mining of customer message content; any optional telemetry purpose and retention are separately disclosed and consented. This is a product direction to validate, not a pricing or revenue forecast.

## Release gates and proof

The [PR plan](pr-plan.md) gives each increment a property, a test capable of failing and a merge/activation boundary. Gate the first source-bound release on isolation and immutable record/template tests, same-owner agent exclusion from human decisions, all-agent-prose holds, closure of legacy admission in activated scopes, both replay conflict paths, one attempt across revisions, two-process/one-database admission/crash/control tests, exact approval and evidence linkage, source-aware UI, P23a minimum privacy controls, and reviewed infrastructure/rollback compatibility.

Choose new migration numbers from reviewed current main. Existing eight migration files and historical authority/receipt hashes remain unchanged. Because older binaries reject unknown migration sets, feature OFF alone is not a rollback image: prepare and prove a compatible feature-off fallback before applying an additive migration. Rehearse restores on disposable infrastructure, not production data.

Enable one fresh owned-recipient workflow only after separate owner record approval, job confirmation and any channel opt-in. Demonstrate approved factsheet to Dana, held free prose, exact approved execution, duplicate/conflicting operation handling, STOP and UNKNOWN with separate source, synthetic, live-provider and recipient-witness evidence. Pilot onboarding and throughput measurements carry sample/workload/environment, failure and cost information; they are not inferred from a demo.

Enterprise coverage and high-concurrency claims require the additional tenant, runtime/provider-path and load/operations gates. Other providers and destructive operations remain disabled until their own authorization, data, approval, outcome and recovery contracts pass. No research report or planning merge authorizes an existing job replay, phone enrollment, new provider grant or production deployment.
