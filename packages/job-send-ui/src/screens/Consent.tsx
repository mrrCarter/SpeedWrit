/** ChatGPT's connector callback (packages/job-send oauth CHATGPT_REDIRECT; a test pins the two together). */
export const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_PER_CONNECTION = /^https:\/\/chatgpt\.com\/connector\/oauth\/([A-Za-z0-9_-]{1,128})$/;
/** Grok's connector callback on grok.com (oauth GROK_REDIRECT; a test pins them together). */
export const GROK_CALLBACK = "https://grok.com/connectors-oauth-exchange-code/";
/** The two callbacks Grok Bot registers (oauth GROK_BOT_REDIRECTS): Cursor's web callback, and a loopback one. */
export const CURSOR_CALLBACK = "https://www.cursor.com/agents/mcp/oauth/callback";
export const LOOPBACK_CALLBACK = "http://localhost:8787/callback";

/** The only scope SpeedWrit grants (packages/job-send MCP_SCOPE). */
export const CONSENT_SCOPE = "jobs.act";

/** The authorize request as checkAuthorizeRequest accepted it. The screen shows it and posts back exactly it. */
export interface ConsentRequest {
  clientId: string;
  /** Declared by the client at registration; never verified. */
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
}

export interface ConsentProps {
  request: ConsentRequest;
  /** The signed-in owner the grant is for, so a shared browser can't grant for the wrong account. */
  ownerEmail: string;
  onAllow: (request: ConsentRequest) => void;
  onDeny: (request: ConsentRequest) => void;
}

/** Where the code goes, in words, from the exact redirect string (never a parsed and normalized URL). */
export function describeRedirect(uri: string): { where: string; connection: string | null } {
  if (uri === CHATGPT_CALLBACK) return { where: "ChatGPT", connection: null };
  const perConnection = CHATGPT_PER_CONNECTION.exec(uri);
  if (perConnection) return { where: "ChatGPT", connection: perConnection[1] ?? null };
  if (uri === GROK_CALLBACK) return { where: "Grok (grok.com)", connection: null };
  if (uri === CURSOR_CALLBACK) return { where: "Cursor's website (cursor.com)", connection: null };
  // localhost is the computer this page is open on: the code goes to an app running there.
  if (uri === LOOPBACK_CALLBACK) return { where: "An app on this computer", connection: null };
  return { where: "Another address", connection: null };
}

/** What both consent views show: who asks (declared), for which owner, where the code goes, and what it may do. */
function ConsentDetails({ clientName, redirectUri, ownerEmail }: { clientName: string; redirectUri: string; ownerEmail: string }) {
  const target = describeRedirect(redirectUri);
  return (
    <>
      <p className="consent-eyebrow">Agent connection</p>
      <h1>Connect an agent to SpeedWrit</h1>
      <p className="consent-intro">Allow connects this agent. It does not create a job or send an email.</p>
      <p className="consent-identity">
        {/* <bdi> isolates the declared name: a direction override inside it cannot reorder "(declared)" (machine, #512). */}
        <strong>
          <bdi>{clientName}</bdi>
        </strong>{" "}
        (declared) asks to act for <strong>{ownerEmail}</strong>.
      </p>
      <dl className="consent-details">
        <dt>Returns to</dt>
        <dd>
          {target.where}
          {target.connection ? <> · connection <code>{target.connection}</code></> : null} ·{" "}
          <code>
            <bdi>{redirectUri}</bdi>
          </code>
        </dd>
        <dt>It may</dt>
        <dd>Send email only inside jobs you confirm for this connection, and only what each job allows.</dd>
        <dt>It may not</dt>
        <dd>Read your inbox, change a job, or approve its own messages. It has no jobs until you confirm one.</dd>
      </dl>
      <p className="consent-check">Continue only if you recognize this request and the return address.</p>
    </>
  );
}

const NOT_GRANTABLE = "This request asks for something SpeedWrit does not grant.";

/**
 * The owner's consent screen for /oauth/authorize (spec: "OAuth contract"). The server has already checked the
 * request; this screen only shows it. The client's name is declared, so the screen shows where the code actually
 * goes (ChatGPT and its per-connection id, or the exact address) beside it: a familiar name on someone else's
 * connector is visible. Allow posts back exactly the request shown; any scope but jobs.act offers no Allow.
 */
export function Consent({ request, ownerEmail, onAllow, onDeny }: ConsentProps) {
  const grantable = request.scope === CONSENT_SCOPE;
  return (
    <section className="consent-card" aria-label="Connect an agent">
      <ConsentDetails clientName={request.clientName} redirectUri={request.redirectUri} ownerEmail={ownerEmail} />
      {grantable ? (
        <button className="consent-allow" type="button" onClick={() => onAllow(request)}>
          Allow
        </button>
      ) : (
        <p role="alert">{NOT_GRANTABLE}</p>
      )}
      <button className="consent-deny" type="button" onClick={() => onDeny(request)}>
        Deny
      </button>
    </section>
  );
}

/**
 * What the server-rendered consent page shows: the shape PR B's renderConsent receives. The server keeps the authorize
 * request under `requestId` (one time, bound to the owner, short-lived); the page shows `request` but posts back only
 * that id and the decision, never request fields.
 */
export interface ConsentView {
  requestId: string;
  /** Server-generated CSP nonce for the static stylesheet, never part of the posted form. */
  styleNonce: string;
  request: ConsentRequest;
  ownerEmail: string;
}

/** Where the consent form posts. */
export const CONSENT_FORM_ACTION = "/oauth/authorize";

/**
 * The consent screen as a real form, for a server that renders it to static HTML (renderConsentHtml): the same
 * wording as Consent, a hidden request_id, and submit buttons named decision. It posts nothing else, and offers no
 * Allow for any scope but jobs.act.
 */
export function ConsentForm({ view }: { view: ConsentView }) {
  const grantable = view.request.scope === CONSENT_SCOPE;
  return (
    <section className="consent-card" aria-label="Connect an agent">
      <ConsentDetails clientName={view.request.clientName} redirectUri={view.request.redirectUri} ownerEmail={view.ownerEmail} />
      <form className="consent-actions" method="post" action={CONSENT_FORM_ACTION}>
        <input type="hidden" name="request_id" value={view.requestId} />
        {grantable ? (
          <button className="consent-allow" type="submit" name="decision" value="allow">
            Allow
          </button>
        ) : (
          <p role="alert">{NOT_GRANTABLE}</p>
        )}
        <button className="consent-deny" type="submit" name="decision" value="deny">
          Deny
        </button>
      </form>
      <p className="consent-footnote">Deny returns to the requesting app without connecting it.</p>
    </section>
  );
}
