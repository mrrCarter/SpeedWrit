// Static presentation only. No request data, imports, fonts, URLs or other network assets.
// renderConsentHtml authorizes this one block with the response's fresh CSP nonce.
export const CONSENT_CSS = `
:root { color-scheme: dark; font-family: Menlo, Monaco, ui-monospace, "Courier New", monospace; font-size: 14px; line-height: 1.65; color: #f1eee8; background: #0b0a09; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 280px; min-height: 100vh; background: radial-gradient(1000px 600px at 8% -20%, #33281b, transparent 70%), #0b0a09; }
.consent-brand { display: flex; align-items: center; gap: 22px; max-width: 800px; margin: 0 auto; padding: 28px 28px 22px; }
.consent-brand .owner-logo { display: block; width: 148px; height: auto; flex-shrink: 0; }
.consent-brand p { margin: 0; display: flex; flex-direction: column; }
.consent-brand strong { font-size: 17px; }
.consent-brand span { color: #b5ada1; font-size: 12px; }
main { max-width: 800px; margin: 0 auto; padding: 0 28px 48px; }
.consent-card { background: #14120f; border: 1px solid #39332b; border-radius: 16px; padding: 32px; box-shadow: 0 16px 50px #00000030; }
.consent-eyebrow { margin: 0 0 12px; color: #e2bf74; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; }
h1 { margin: 0 0 14px; font-size: clamp(25px, 4vw, 34px); line-height: 1.2; letter-spacing: -.035em; }
p { margin: 0 0 20px; }
.consent-intro, .consent-check, .consent-footnote { color: #b5ada1; }
.consent-identity { padding: 18px 20px; background: #211d18; border: 1px solid #65543a; border-radius: 9px; overflow-wrap: anywhere; }
.consent-identity strong { color: #f1eee8; }
.consent-details { display: grid; grid-template-columns: 115px minmax(0, 1fr); gap: 18px 24px; margin: 26px 0; }
dt { color: #e2bf74; font-weight: bold; }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
code { font: inherit; font-size: .9em; color: #d0c6b4; overflow-wrap: anywhere; }
bdi { overflow-wrap: anywhere; }
.consent-check { padding-top: 22px; border-top: 1px solid #39332b; margin-bottom: 24px; }
.consent-actions { display: flex; flex-wrap: wrap; gap: 12px; }
button { min-height: 48px; min-width: 132px; padding: 12px 24px; font: inherit; font-weight: bold; border-radius: 8px; cursor: pointer; }
.consent-allow { background: #e2bf74; color: #17130c; border: 1px solid #e2bf74; }
.consent-allow:hover { background: #f0d193; border-color: #f0d193; }
.consent-deny { background: #211d18; color: #f1eee8; border: 1px solid #65543a; }
.consent-deny:hover { background: #30271c; border-color: #e2bf74; }
button:focus-visible { outline: 3px solid #f6dcaa; outline-offset: 4px; }
.consent-footnote { margin: 18px 0 0; font-size: 12px; }
[role="alert"] { width: 100%; color: #ffd1cb; border-left: 3px solid #ff9b91; padding: 12px 16px; background: #301916; }
@media (max-width: 520px) {
  .consent-brand { padding: 20px 18px; gap: 16px; }
  .consent-brand .owner-logo { width: 120px; }
  main { padding: 0 14px 28px; }
  .consent-card { padding: 24px 20px; border-radius: 12px; }
  .consent-details { grid-template-columns: 1fr; gap: 5px; }
  dd { margin-bottom: 15px; }
  .consent-identity { padding: 14px; }
  .consent-actions { display: grid; grid-template-columns: 1fr 1fr; }
  button { min-width: 0; padding: 12px; }
  [role="alert"] { grid-column: 1 / -1; }
}
@media (forced-colors: active) { button:focus-visible { outline-color: Highlight; } }
`;
