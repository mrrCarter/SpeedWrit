// The consent page as a whole HTML document, for the /oauth/authorize route to send (warden's PR B injects it as
// renderConsent). Its own entry point ("@writ/job-send-ui/consent-html"), so react-dom/server never reaches a
// browser bundle through the package index. No scripts or external assets: the static stylesheet uses the
// server-generated response nonce. The strict CSP keeps default-src none and permits form-action only for
// self plus the pending redirect origin (browsers apply form-action after the POST as well).
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentForm, type ConsentView } from "../screens/Consent";
import { Logo } from "../app/Logo";
import { CONSENT_CSS } from "./consentStyles";

export type { ConsentView };

/** The full page: doctype, charset, viewport, title, and the consent form. React escapes every value. */
export function renderConsentHtml(view: ConsentView): string {
  return `<!doctype html>${renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Connect an agent to SpeedWrit</title>
        <style nonce={view.styleNonce}>{CONSENT_CSS}</style>
      </head>
      <body className="consent-page">
        <header className="consent-brand">
          <Logo height={62} />
          <p><strong>SpeedWrit</strong><span>Your jobs. Your call.</span></p>
        </header>
        <main>
          <ConsentForm view={view} />
        </main>
      </body>
    </html>,
  )}`;
}
