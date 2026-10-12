// Static public information, bundled into the service through the existing /serve export.
// No request, owner config, environment variable, credential or database row enters these pages.
export const PUBLIC_PAGE_CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const support = '<a href="mailto:carther91@gmail.com">carther91@gmail.com</a>';
const navigation = '<nav aria-label="Public information"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Demo terms</a><a href="/owner-app/">Open SpeedWrit</a></nav>';

function page(title: string, introduction: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · SpeedWrit</title><meta name="description" content="${introduction}"><link rel="stylesheet" href="/public.css"></head><body><header><a class="brand" href="/about">SpeedWrit</a>${navigation}</header><main><p class="eyebrow">A working demo</p><h1>${title}</h1><p class="intro">${introduction}</p>${content}</main><footer>${navigation}<p>Questions or data requests: ${support}</p></footer></body></html>`;
}

const about = page("Email authority you can review", "Give an agent a specific email job, with limits you confirm and receipts you can verify.", `
<section><h2>Connect your own account</h2>
<p>Sign in with Google, then connect Gmail and explicitly allow sending email. SpeedWrit requests the Gmail <code>gmail.send</code> permission. It does not request inbox-reading access. Google sign-in also supplies your account identity and email address.</p>
<p><a class="button" href="/owner-app/">Open SpeedWrit and connect</a></p>
<p>Availability depends on this demo's configuration, Google consent and your agent client's support. A successful connection does not itself authorize sending a message.</p></section>
<section><h2>A job defines the permission</h2>
<p>Each job belongs to its owner and names a Gmail connection, an agent connection, one recipient, a template, a send limit and an expiry. Review the server's complete job before confirming it. Custom wording requires the owner's approval when enabled; a client cannot approve its own proposal.</p>
<p>This shared demo currently supports a configured list of demonstration recipients. Adding your own contacts or selecting arbitrary recipients is not available.</p>
<p>Code checks the job's limits before sending. TypeSafe's Jev review can hold applicable message text for owner review; it can miss a problem and cannot waive a code refusal. Optional Dial notifications call a configured owner with a generic notice to open SpeedWrit. A phone call cannot approve or send an email.</p></section>
<section><h2>Connect ChatGPT or another MCP client</h2>
<p>Use the public MCP server URL shown in <a href="/owner-app/#/connect">SpeedWrit Connections</a> and choose OAuth. Complete sign-in and consent for the named agent connection. Each grant is associated with the signed-in owner; jobs also bind to a particular agent connection. The address hosting these information pages may differ from the running app.</p>
<p>Keep agent credentials and any private connection URL private. Owner approval happens in the owner app. Supported callback URLs and client capabilities can limit which clients connect.</p></section>
<section><h2>Read the result carefully</h2>
<p>Signed receipts record actions and outcomes. Provider accepted means Gmail accepted the request; it does not prove inbox delivery. An unknown outcome keeps its reserved send slot, including after an owner records that the message was not seen. Do not treat uncertainty as permission to retry.</p>
<p>Before using the demo, read the <a href="/privacy">privacy notice</a> and <a href="/terms">demo terms</a>. Support: ${support}.</p></section>`);

const privacy = page("Privacy notice", "How this SpeedWrit demo handles account information, email proposals, review data and action records.", `
<section><h2>Information the demo handles</h2>
<p>Google sign-in provides a Google account identifier and email address. Connecting Gmail records the sending account, granted scopes and connection status. The service uses an owner session cookie and OAuth records to authenticate owners and connected agents.</p>
<p>The database stores jobs and their limits; sender and recipient addresses; configured contact information; agent identifiers, declared labels and use timestamps; message proposals, subjects, bodies and the MIME bytes prepared for sending; approvals; provider outcomes; and signed receipts. Receipts include action metadata and hashes that bind events to a particular job or message version.</p>
<p>Google refresh tokens are encrypted before database storage. Short-lived Google access tokens are held in server memory for provider requests. The server decrypts a refresh token when it needs to refresh access or request revocation. Agent clients receive their own agent authorization, not the Gmail refresh token or receipt signing key.</p></section>
<section><h2>Why information is used and where it goes</h2>
<ul><li><strong>Google:</strong> sign-in identifies the owner; Gmail receives the prepared message and recipient when an authorized dispatch occurs. The requested Gmail permission is sending email, not reading the inbox.</li>
<li><strong>TypeSafe / Jev:</strong> when a job requires AI review, the service sends the job purpose, subject, applicable free-text message content and names of other clients to TypeSafe's review API. Message text can contain personal information. Google credentials and the receipt signing key are not included in the review request. Review outcomes, model identifiers, flags and probability values are recorded.</li>
<li><strong>Dial, when configured and opted in:</strong> an owner notification or explicit test sends the configured destination phone number, originating number, an attempt identifier and generic spoken instructions to Dial. The notice says an item needs attention in SpeedWrit; it does not include the email body, recipient, contact list or Gmail credentials. Notification preferences and attempted-call outcomes are stored.</li>
<li><strong>Your agent provider:</strong> the client you choose sends tool arguments and receives permitted tool results and receipts. Content shared with that client is also subject to its own service policies.</li></ul>
<p>The operator's server and database process this information to run the demo, enforce job limits, maintain sessions, investigate failures and retain an auditable action history. Access logs include request method, route and response status; private connection paths are redacted by the application. Hosting and provider services may keep their own operational records under their policies.</p></section>
<section><h2>Retention, stopping and data requests</h2>
<p>This demo has no automatic deletion schedule for job and action history. Message proposals and signed receipts are retained in the database, and copies may exist in operational backups or exported evidence. Receipt rows are append-only in the application.</p>
<p>Use the owner's Stop or disconnect controls to stop applicable future actions, and Google's account permissions to revoke Google access. A successful provider revocation removes the stored refresh token. Revocation or disconnect does not automatically erase message proposals, receipts, backups or messages already accepted by Gmail.</p>
<p>For access, correction or deletion requests, contact ${support}. State which account and records the request concerns; do not email passwords, access tokens or private connection URLs. The operator will assess the request and applicable retained records; this notice does not promise automatic or immediate erasure.</p></section>
<section><h2>Your choices</h2>
<p>Only connect accounts and provide message content you are authorized to use. Review what a job permits before confirming it. AI review may be required by that job, and optional phone notifications require an explicit owner preference. Public information pages do not require sign-in and load no analytics scripts or third-party page assets.</p>
<p>Questions about these practices: ${support}. See also <a href="/about">how SpeedWrit works</a> and the <a href="/terms">demo terms</a>.</p></section>`);

const terms = page("Demo terms", "Use SpeedWrit only with accounts, recipients and message content you are authorized to use.", `
<section><h2>Your authority and review</h2>
<p>You are responsible for the accounts you connect, the recipients you select and the content you submit or approve. Do not use this demo for unsolicited bulk messages, impersonation or attempts to obtain secrets. Keep your agent credentials and private connection URLs secure.</p>
<p>Review the complete job, including its recipient, agent connection, send limit, expiry and approval rules, before confirming it. Confirming a job allows actions within that authority. Review the exact message version before granting any requested owner approval. A later version requires its own applicable review.</p></section>
<section><h2>Understand outcomes and limits</h2>
<p>AI review can miss a problem. A clear review does not expand a job's authority or replace an owner approval. A phone notification cannot grant email permission. Provider accepted means the provider accepted the request, not that the recipient received or read the message.</p>
<p>An unknown send outcome may mean the provider received the request. Its reserved slot remains used; an owner observation does not refund it or authorize a retry. Use Stop or disconnect when you no longer want the applicable connection to act.</p>
<p>This is a working demo. Availability, supported clients, account access and permitted recipients may be limited. The demo does not guarantee a review result, notification, provider acceptance or delivery.</p></section>
<section><h2>Questions and data handling</h2>
<p>Read the <a href="/privacy">privacy notice</a> before connecting. Google, TypeSafe, Dial and your agent provider have their own service requirements. These demo terms do not change those providers' terms.</p>
<p>Contact ${support} for support or questions about this demo. <a href="/about">Return to About SpeedWrit</a>.</p></section>`);

const css = `:root{color-scheme:light;font:17px/1.65 system-ui,sans-serif;color:#24252a;background:#faf9f6}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:900px;margin:auto;padding:1.5rem}header{border-bottom:1px solid #dedbd4;display:flex;gap:1.5rem;align-items:center;justify-content:space-between}.brand{font-size:1.3rem;font-weight:750;text-decoration:none;color:#24252a}nav{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem}a{color:#70521d;text-underline-offset:.2em}a:focus-visible{outline:3px solid #70521d;outline-offset:4px}main{padding-top:3rem;padding-bottom:3rem}h1{font-size:clamp(2rem,5vw,3.3rem);line-height:1.12;letter-spacing:-.035em;max-width:760px}h2{font-size:1.35rem;line-height:1.3;margin-top:2.4rem}.eyebrow{font-size:.8rem;font-weight:650;text-transform:uppercase;letter-spacing:.12em;color:#756b59}.intro{font-size:1.2rem;color:#59564f}li{margin:.8rem 0}code{font-size:.95em;background:#eeece5;padding:.1rem .3rem;border-radius:4px}.button{display:inline-block;background:#70521d;color:#fff;padding:.65rem 1rem;border-radius:7px;text-decoration:none;font-weight:650}footer{border-top:1px solid #dedbd4;font-size:.9rem;color:#59564f}footer p{overflow-wrap:anywhere}@media(max-width:600px){header{align-items:flex-start;flex-direction:column}main{padding-top:1.5rem}}`;

export const PUBLIC_PAGES: ReadonlyMap<string, { contentType: string; body: string }> = new Map([
  ["/about", { contentType: "text/html; charset=utf-8", body: about }],
  ["/privacy", { contentType: "text/html; charset=utf-8", body: privacy }],
  ["/terms", { contentType: "text/html; charset=utf-8", body: terms }],
  ["/public.css", { contentType: "text/css; charset=utf-8", body: css }],
]);
