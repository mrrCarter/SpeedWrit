# SpeedWrit action gateway research review

Status: planning and claim reconciliation, 12 October 2026. This document informs the [specification](specification.md) and [PR plan](pr-plan.md); it does not enable a feature, approve a deployment, or certify a customer environment.

The deployment reference remains `653d1571c109b95db27a0fd3247c5bfe03abb889` at `speedwrit.aidenid.com`, with the separately recorded `d3` image and `ae3` runtime/configuration identities. The source reference for this plan is repository `main` at `887b8b3f5d2985ff19d2a10877e53b743c03b908`; the planning branch advanced from its initial `5ddb` base to that reference before these documentation changes. Repository changes are not evidence of deployment. Owner phone enrollment and the held job remain unfinished. Source-bound automatic actions, enterprise authority and replica-safe admission remain proposed work.

## Inputs and complete-read provenance

The three reports were read in full as data, including their tables, caveats and source lists. The HTML was parsed without executing scripts or embedded instructions. Hashes below identify the supplied files, not the correctness of their conclusions. Raw reports, conversation content, credentials, phone numbers and owner identifiers are not included in this repository.

| Input | Exact supplied filename | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| R1: adversarial review and build decision | `AIdenID_Adversarial_Review_and_Build_Decision_2026-10-12.html` | 32,965 | `5cd6d9e906971ca03c0e726dc89acb86ed2f255af08c0089668ede2572a9880b` |
| R2: technical due diligence | `AIdenID_Action_Gateway_DD_2026-10-12.html` | 32,647 | `fa043c3627543d3da1ea506bf35d98c72cb9024f1067fe1b9b034fd13cdecf72` |
| R3: DeepResearch hardening review | `compass_artifact_wf-cda7026d-0b3e-89df-89e5-09b1abd0222a_text_markdown_aidenid.md` | 48,882 | `638a56f1695302a44811cfd199aa85eb5ed4920421e207672d598552183f4fe6` |
| C1: Claude conversation excerpt | User-provided chat input; no file was supplied | Not applicable | No file hash exists |

Coverage includes R1's complete correction/design/reliability/business discussion and 20 source entries; R2's eight numbered sections, tables and 17 source groups; and all 309 lines and 53 source entries of R3. Every R3 reference was reviewed for provenance. This is not a claim that every linked webpage was independently read: some are secondary summaries, community reports or historical announcements. R3's CaMeL citation points to a different paper; the correct primary paper is linked below. Unverified acquisition figures, taxonomy revisions, vendor prices and connector-launch claims are omitted from this plan.

C1 is a user-supplied design and commercial direction, not externally verified research. In paraphrase, it favors protected provider credentials, closure of other agent routes, action constraints independent of intent detection, approved-source automatic actions, exact approval for custom wording, separate operation/digest/nonce identities, and no resend of uncertain actions. It also proposes a free gateway with paid operations and intelligence, without harvesting customer data, and a first paid pilot around one approved factsheet workflow.

The review retains existing operational evidence and fresh authenticated network observations under their actual timestamps and scope. Such evidence can establish the checks performed; it cannot establish that this proposed source-bound workflow or enterprise controls are deployed. A focused source audit of the pinned runtime also has a narrower scope than a whole-repository audit or live provider test.

## Decision

Proceed with one Gmail customer-update workflow whose job pins an owner-approved factsheet version, recipient, purpose, template, limits and expiry. The server resolves the record and renders the message. The agent requests an authorized job; it cannot replace its source, recipient, subject, body or trust labels. All agent-authored prose is held for authenticated approval of the exact submitted bytes.

Today's template fields are still agent-supplied. Their structure, length and template hash do not establish information origin. Preserve historical interpretation and add an explicit source-bound mode rather than relabeling existing jobs. Source approval establishes permission to use particular bytes for a particular purpose; it does not establish factual truth, freshness or correct customer assignment. Those require their own owner/connector controls.

Historical v1 authority objects and receipt hashes remain unchanged. Activating the strict profile for a covered scope blocks new v1 job creation and refuses legacy provider admission across REST/MCP/SDK aliases, revisions, owner decisions, background workers and compatibility routes. Continuing an old job requires a reviewed migration and fresh v2 confirmation. A feature-off fallback must preserve this restriction rather than reopen legacy execution.

## Accept, refine and reject

These decisions reconcile conflicting recommendations in favor of conservative final-action authorization. Each implementation claim still requires the acceptance evidence in the PR plan.

| Recommendation or claim | Decision | Consequence for the plan |
| --- | --- | --- |
| Credential custody and policy outside the model | Accept | Only the trusted executor uses the provider write credential. An agent receives a SpeedWrit credential and server-derived job authority. |
| Approved factsheet plus template enables routine automatic work | Accept with a new mode | Pin record approval/version, customer, purpose, recipient and mapping. Server-render typed fields; reject overrides and missing-source fallback. |
| Valid template fields or a clear model score establish safe provenance | Reject | Agent text remains provenance-unknown and requires exact approval. Jev can add a hold, never grant authority. |
| One payload hash supplies operation identity and idempotency | Refine | Separate operator intent, replay request digest, frozen MIME hash and approval nonce. Identical bytes can represent different intended operations. |
| Approval of a draft authorizes later reconstruction | Reject | Preview and dispatch use the same frozen gateway-submitted bytes. Changes invalidate authority; provider rewriting is outside that byte claim. |
| Searching Sent and finding nothing permits retry | Reject | Preserve UNKNOWN and its reservation. Absence of a search result or recipient delivery report is not proof of nonacceptance. Read-capable reconciliation also requires additional scopes. [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes). |
| Internal deduplication proves at-most-once sending or exactly-once delivery | Reject as a provider guarantee | Earn one local admitted adapter invocation per intent under defined failure assumptions. Gmail documents no client idempotency-key parameter. Disable hidden retries; retain uncertain outcomes. |
| STOP instantly recalls all work | Refine | STOP prevents admissions committed after its authoritative ordering point. Previously admitted calls can finish. Uncertain writer ownership or a restore that may omit claims pauses admission. |
| OAuth installation protects the whole account | Reject | Name the supported routed connection, confined runtime or verified managed-account coverage. Consumer Gmail can support a provisioned agent route while other account activity remains outside it. |
| A Trusted send app closes all Gmail write paths | Reject | Trusted permits all Workspace OAuth scopes; Specific Google data restricts requested scopes. Inventory every write-capable grant and separate non-API route. Admin policy blocks or permits access; it does not reroute clients. [Google app controls](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data). |
| A Bash sandbox or tool hook establishes complete confinement | Reject | Shell sandboxing leaves file tools, MCP servers and hooks outside its boundary. Define and test the complete managed runtime. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing). |
| Claude hooks fail closed uniformly | Refine | Command/HTTP `onFailure: "block"` requires version 2.1.295 or later. MCP-tool hooks have distinct failure behavior that can continue. Pin versions and test failures and loaded configuration. [Hook reference](https://code.claude.com/docs/en/hooks). |
| DPoP binds exact action content or a physical host | Reject | DPoP establishes proof-of-possession binding; it does not bind general request bodies or attest host location. Protected key use and exact-action authorization remain separate. [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html). |
| A signed capability alone enforces quotas or one-use approval | Reject | Shared transactional state consumes budgets/nonces and checks current revocation. A signature cannot maintain a counter. |
| Signed receipts prove truthful, complete capture of every action | Refine | Signatures authenticate recorded claims under a key. Retained checkpoints bound gap/truncation detection; they cannot prove unlogged activity, intent or delivery. |
| The flight recorder is inherently probabilistic | Reject | Instrumented observations and receipt verification are distinct from probabilistic risk interpretation. Missing telemetry means not observed. |
| Object Lock requires bucket creation and certifies compliance | Reject | AWS supports existing versioned buckets. Retention protects specific versions; current-key deletion markers remain possible. Choose retention intentionally, without a product compliance claim. [Configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html), [version protection](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html). |
| Most attacks are prevented, as demonstrated by external benchmarks | Reject as product performance | The adaptive paper reports 12 defenses bypassed, with over 90% success for most, not all. CaMeL's results concern its stated benchmark and threat model. Neither evaluates SpeedWrit. [Adaptive evaluation](https://arxiv.org/abs/2510.09023), [CaMeL v2](https://arxiv.org/abs/2503.18813v2). |
| Almost all competing products only detect suspicious text | Reject | Current products also enforce policy, broker credentials and obtain asynchronous approval. Compare concrete workflows and control boundaries. |
| Schema validation, a five-minute setup target or a pricing thesis is proof | Refine | Confirm interpreted typed rules with the owner. Measure setup, interruptions, task completion and pilot demand. Do not substitute validation or a forecast for those outcomes. |

## Four identities with separate meanings

These are proposed contract terms; existing `operation_id` compatibility must be explicit. The runtime audit found that an existing proposal can be returned without comparing changed request arguments, including the uniqueness-conflict path. Both replay paths need the same conflict check.

| Identity | Meaning | Required binding |
| --- | --- | --- |
| `operatorIntentID` (`operation_id`) | One intended business operation, stable across retries of that intention | Authoritative key `(personal_owner_or_tenant_scope, job_id, operation_id)`. All revisions share at most one admitted provider attempt. New IDs still consume the same job quota. |
| `requestDigest` | Canonical request semantics used to detect changed-input replay | Intent, pinned authority/source/template versions and permitted input. Same intent with different semantics is refused. |
| `frozenMIMESHA` | Digest of the exact immutable MIME submitted by the Gmail adapter | Stored action manifest, renderer version and all approved content/targets. No dispatch-time rerender. |
| Approval nonce | Single-use authenticated permission for one frozen action | Intent, action digest, approver authority, policy version and expiry; consumed atomically with admission. |

Digest equality does not authorize an actor, establish source truth or prove provider deduplication. The first slice should have one recipient and no attachments, arbitrary headers, mutable remote content or free-text substitutions. A later capability expansion needs its own frozen-byte and authorization contract.

The personal-owner or tenant scope comes from authenticated server state. Changed-input replays conflict in both lookup paths. A legitimate pre-admission revision is a separate compare-and-set operation on the intent's current revision, permitted only when no provider attempt has been admitted. It creates the new request/frozen version and invalidates the old approval atomically. After admission, a revision or another approval nonce cannot create another attempt for that intent.

The claim, reservation and pre-dispatch evidence commit before external I/O. Only the original worker's unambiguous successful acknowledgement of that original admission transaction authorizes its one provider request. Once a commit is classified as ambiguous, it becomes conservative UNKNOWN with its applicable reservation retained. A later acknowledgement, database lookup, lease acquisition, restart or failover can establish recorded status but cannot grant provider I/O or replay authority for that ambiguous attempt. Reconciliation can add evidence to UNKNOWN; it cannot turn a negative search into permission to send again. These are proposed local execution properties, not remote delivery guarantees.

## Coverage must be demonstrated per route

The following is an inventory and proof requirement, not instructions to change customer accounts. A routed-action claim is useful without suppressing ordinary human activity. A managed-account claim requires verified closure of every route included in that promise. No current customer receives a global guarantee from this document.

| Route | Evidence required before claiming control |
| --- | --- |
| SpeedWrit action tool/API | Caller/job authorization, approved-source or exact-approval binding, frozen bytes, admission and outcome tests. |
| Other OAuth applications and existing grants | Review all scopes authorizing the claimed operation, including full-mail, modify, compose and send grants. Inventory context-limited add-on scopes separately: their permitted operations depend on the add-on interaction and provider interface, and must not be treated as general send/delete authority. Review existing tokens, client IDs, organizational-unit overrides and revocation behavior. [Send authorization](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes). |
| Logged-in browser, first-party Gmail/mobile tools and computer use | Establish which sessions the agent can access and which human routes remain outside the promise. OAuth allowlisting alone is insufficient. |
| SMTP clients, POP/IMAP and app passwords | Inventory each protocol and credential route separately. POP/IMAP controls do not prove SMTP closed; app-password eligibility depends on the account. [Mail-client controls](https://knowledge.workspace.google.com/admin/sync/turn-pop-and-imap-on-or-off-for-users), [app-password conditions](https://support.google.com/accounts/answer/185833). |
| SMTP relay | Review separate relay authentication/IP configuration and runtime reachability. [Google relay documentation](https://knowledge.workspace.google.com/admin/gmail/advanced/route-outgoing-smtp-relay-messages-through-google). |
| Domain-wide delegation, service accounts and mailbox delegates | Review delegated scopes, impersonation authority and alternate principals separately. Documented availability is not evidence of a usable or blocked route in a particular tenant. [DWD controls](https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation). |
| Apps Script, triggers, forwarding and other provider automations | Inventory identities and automations with write authority; an agent-facing send endpoint cannot govern an independently authorized script. [GmailApp capability](https://developers.google.com/apps-script/reference/gmail/gmail-app). |
| Other MCP servers, generic HTTP tools, hooks and subprocesses | Establish tool/process and credential custody for the complete runtime. A protected MCP server governs its own authenticated surface, not other tools. [Pinned MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). |
| Model-provider calls, retrieval, logs and allowed network dependencies | Identify data that can leave before a final write gate. Restrict approved-data use and allowed services according to the workflow's confidentiality requirements. |
| Configuration changes and capability drift | Protect administration from the agent; revalidate changed tools, grants, sessions and runtime versions. Unverified paths prevent a broader protected label. |

Google settings describe available controls, not a tested tenant configuration. The final inventory must include all relevant write scopes and routes rather than checking only `gmail.send`. A protected managed runtime likewise needs more than a shell-domain blocklist. Whole-account consumer restrictions and universal interception of independently hosted connectors are not established.

## Documented alternatives and useful differentiation

Provider documentation establishes features and interfaces, not head-to-head performance or identical guarantees. The comparison is deliberately limited to capabilities verified from current primary documentation.

| Alternative | Documented capability | Boundary and implication |
| --- | --- | --- |
| AWS Bedrock AgentCore Policy | Deterministic Cedar/Dogwood gateway policy, natural-language candidate authoring and session-aware approval/count/budget conditions. [Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html), [temporal policies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-temporal.html). | Enforcement concerns configured gateway traffic. Rules outside the model and structured approval conditions are not unique to SpeedWrit. |
| Auth0 Token Vault and CIBA | External OAuth token storage/exchange and asynchronous user authorization. [Token Vault](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault), [CIBA](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow). | A trusted application backend receives upstream tokens. Its integration must enforce exact action semantics; it can be infrastructure or a substitute. |
| Microsoft Entra Agent ID | Agent identities, blueprint-based token acquisition and enterprise identity governance. [Identity model](https://learn.microsoft.com/en-us/entra/agent-id/agent-identities). | Identity/access governance does not itself establish exact Gmail-content approval across independent routes. Feature and licensing scope matters. |
| OAuth integration brokers such as Nango | Authenticated external-API requests and credential lifecycle support. [Proxy interface](https://nango.dev/docs/guides/platform/proxy-requests). | A broker can sit behind the executor. An unrestricted agent-facing proxy would reopen actions the semantic policy does not understand. |

The hypothesis to test is that one source-bound workflow produces fewer review interruptions, dependable exception handling and a usable record of authority with less integration effort than the customer's alternatives. A tested connector-semantics catalog, recovery procedures and useful operating support may become valuable; hashes, risk prompts and an MCP endpoint do not by themselves establish a moat.

## Evidence, privacy and the proposed business model

Keep the free gateway's authorization and evidence semantics independent of a paid detector. Paid operations and intelligence may add hosted reliability, credential lifecycle management, team workflows, investigation tools and measured anomaly analysis. This is the user's proposed commercial direction, not current pricing or evidence of willingness to pay.

Customer records are not a data-harvesting asset. Minimize retained message content, separate token and content encryption, authorize tenant access, define deletion/retention and reviewer handling, and make any optional learning use separately consented. Provider-token custody is not zero knowledge: the trusted executor must use credentials, and its compromise remains inside the trusted computing base.

Receipts should identify the authority, source/action versions, decision, observed provider response, uncertainty, signing key and coverage. Cryptographic verification establishes integrity under its assumptions; an anomaly score remains an inference. A retained checkpoint can strengthen gap detection, but neither storage retention nor a signature proves that every event was captured or that the recorded claim was true. Report provider responses and acceptance evidence precisely; do not claim recipient delivery or access to hidden reasoning.

The next proof is one owner-approved factsheet and confirmed template, useful failure/hold cases, exact-byte evidence and a measured pilot. The [specification](specification.md) defines the proposed contract and exclusions. The [PR plan](pr-plan.md) supplies the implementation dependencies and owned-fixture acceptance gates. Live tests, customer administrative changes and rollout remain separate operator decisions; the held phone enrollment/job is not resumed by this research.
