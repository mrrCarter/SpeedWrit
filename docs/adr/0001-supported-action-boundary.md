# ADR 0001: Supported action boundary

Status: Proposed; documents implemented scope and integration limits, without adding enforcement.

Source snapshot: `10ae59162d59732de32efabc9aa71120b94eefaa`, reviewed 2026-10-12. Runtime and client demonstrations require separate, dated evidence. Unmerged phone-decision work is outside this snapshot.

## Decision

SpeedWrit governs Gmail sends submitted through its server executor under an owner-confirmed job. It does not govern every action taken by an agent, browser, Gmail account or external application.

The supported integration is a client calling SpeedWrit's MCP tools with a SpeedWrit credential. The server resolves the agent connection, checks its job, renders an immutable version, applies review holds, and reserves a permitted send before submitting the stored MIME to Gmail. The four tools expose no owner approval or job-confirmation operation. OAuth and the private-URL fallback reach the same backend; the fallback remains a separate credential mechanism. [MCP entry][mcp], [tools][tools], [backend][backend], [dispatch][dispatch].

This boundary is the same for ChatGPT, Grok or another client that successfully uses this MCP service. Client compatibility and live connectivity remain separate evidence claims. The application process, database and credential custody are trusted components of this design.

Google credentials stay in server custody; the client receives a SpeedWrit credential, not that Google grant. Gmail's own send API accepts Google OAuth authorization independently of SpeedWrit. Therefore an independently authorized Gmail integration is outside this job gate. This is an architectural scope limit, not a claim that the current deployment has inventoried or disabled every other write path. [Token custody][custody], [Gmail send API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send) (checked 2026-10-12).

## Ownership and authority

- **Owner:** the application maps a verified Google subject to an owner record. Owner-scoped rows and API checks are the isolation mechanism described here; this is not an organization/workspace role or administrator-policy model. [Owner mapping][owner-mapping].
- **Agent and job:** a job binds that owner, one Gmail connection and one agent connection. MCP job lookup, listing, revision and status use both owner and agent IDs. A new connection does not inherit another connection's jobs. Client labels are declared names, not verified platform identities. [Job authority][authority], [connection-scoped reads and writes][backend].
- **Confirmation and approval:** an authenticated owner confirms the full job-authority hash. Later approval names the exact proposal version and full hash; reservation rechecks current state, expiry, STOP, policy, recipient, integrity and capacity. Approval does not turn a prohibited attempt into an approvable draft. Owner writes also require the configured Origin. [Job confirmation][confirmation], [owner API][owner-api], [reservation and approval][dispatch].

## Enforceability and coverage matrix

“Implemented” describes source behavior at this snapshot, not a fresh live result. The code does not distinguish consumer from managed accounts when applying a job; successful Google authorization and any administrator restrictions are separate prerequisites. “Either” below means consumer Gmail or managed Workspace Gmail, not evidence that both were tested.

| Account type | Action | Credential and path | Implemented boundary / coverage limit |
| --- | --- | --- | --- |
| Consumer Gmail | `propose_send` / `revise_proposal` | SpeedWrit agent OAuth token or private-URL credential → MCP; server-held Google grant → Gmail | Owner/agent/job binding, field and recipient rules, holds, immutable versions and dispatch limits. The client must use this endpoint. [Gate][gate], [backend][backend]. |
| Managed Workspace Gmail | Same MCP email actions | Same SpeedWrit credential and server-held Google grant; administrator policy must permit that app/account | Same job enforcement once authorized. Actual tenant admission, policy and live coverage are unverified here; this is not organization-wide enforcement. |
| Either | Job confirmation; browser Approve/Reject | SpeedWrit owner session cookie → owner API, with exact Origin and displayed hash | Owner-bound, transactional decisions for the identified job/version. No authority over unrelated actions. [Owner API][owner-api], [dispatch][dispatch]. |
| Either | Native Gmail UI or browser-driven Gmail sending | Google browser session → Gmail, outside SpeedWrit | No interception or job check implemented. Missing SpeedWrit receipts do not show that these actions did not occur. |
| Either | Native connector or independent API sending, **if that product supports writes and has sufficient authorization** | Its separate Google grant/token → Google, outside SpeedWrit | No SpeedWrit enforcement. Write support depends on the particular product and granted scopes; no claim that every named native connector can send or is read-only. |
| Managed Workspace only | Candidate restrictions on other apps' Gmail access | Administrator app-access policy → Google OAuth access controls | Future deployment option, not implemented tenant configuration or a per-message SpeedWrit check. Scope and remaining paths require validation. [Official controls][workspace-controls]. |
| Either | Files, payments, calendar changes or other agent/browser actions | Other tools, sessions or provider credentials | No general action broker implemented. Connecting SpeedWrit does not constrain a client's other available tools. |

Within the supported path, AI review can add a hold, including on required-review unavailability; it cannot override code denials or grant approval, and can miss content. Generic Dial notices/test calls cannot decide a draft at this snapshot. [Review wiring][review], [notifications][dial].

STOP uses the authenticated owner workflow to disable dispatch on the specified connection; revocation of its Google grant is attempted separately and may fail. It cannot recall submitted mail or stop independent credentials. UNKNOWN retains its reservation and is not automatically resent. Receipt verification uses a pinned public key, not a Google credential, and establishes signed payload integrity rather than delivery or a complete account audit. Sparta/local worlds are evaluation, not provider enforcement. [STOP and observations][stop], [historical evidence][evidence], [Sparta][sparta], [local world limits][worlds].

## Integration requirements and future options

For the supported Gmail path, deploy the reviewed server with its database, credential custody and pinned receipt key; route the client's email actions to its four MCP tools; and have the owner confirm a job bound to that client's connection. Keep browser decisions in the authenticated owner workflow. A platform's own confirmation prompt is additional UX, not a substitute for these server checks. The owned-domain Worker transports an explicit set of routes and preserves authentication and Origin; it does not supply missing job policy. [Service composition][service], [Worker transport][worker].

For a managed Workspace account, a feasible candidate is to permit the SpeedWrit app's required access while restricting other apps' Gmail write access. Google documents restrictions on high-risk Gmail scopes and per-app access settings such as Specific Google data. These are app/scope controls, not SpeedWrit's recipient/version policy. The documentation does not prove this tenant is configured, that native/browser paths are covered, or that all alternative sending authority is removed. [Official Workspace app-access controls][workspace-controls] (checked 2026-10-12).

Before claiming broader enforcement, identify the account type and administrator authority, approved app identities/scopes, and remaining native/session/independent-credential paths. Record the actual policy scope and separately validate permitted and denied actions in an authorized test environment; none of those tenant checks was performed for this ADR. A platform-specific action hook is conditional future work only if a documented interface and validation establish coverage. No universal pre-tool hook or already-enforced Workspace policy is claimed.

## Evidence discipline

Existing gate, owner, dispatch-race and provider suites are useful regression locations; this documentation change does not rerun them. Distinguish source review, synthetic/stub tests, actual client connectivity, provider acceptance and owner delivery observations. The selected public receipt bundle is historical and incomplete; it is not evidence that every listed client or a future integration has passed live validation. [Existing suites][tests], [evidence limitations][evidence].

[mcp]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/server/http.ts#L347-L398
[tools]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/mcp/tools.ts#L45-L108
[backend]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/backend.ts#L89-L427
[dispatch]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/dispatch.ts#L410-L557
[custody]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/gmail-tokens.ts#L73-L142
[owner-mapping]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/owner/pg-store.ts#L58-L68
[authority]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/jobs.ts#L48-L72
[confirmation]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/owner.ts#L192-L261
[owner-api]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/server/owner-api.ts#L260-L301
[gate]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/gate/checks.ts#L91-L146
[review]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/backend.ts#L151-L198
[dial]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send-app/src/dial-alerts.ts#L22-L39
[stop]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send/src/executor/dispatch.ts#L659-L742
[evidence]: ../evidence/2026-10-11/README.md
[sparta]: ../../sparta/README.md
[worlds]: ../../packages/grokbot/worlds/README.md
[service]: https://github.com/mrrCarter/SpeedWrit/blob/10ae59162d59732de32efabc9aa71120b94eefaa/packages/job-send-app/src/service.ts#L82-L156
[worker]: ../../deploy/owned-domain/README.md
[tests]: ../../packages/job-send/tests/
[workspace-controls]: https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data
