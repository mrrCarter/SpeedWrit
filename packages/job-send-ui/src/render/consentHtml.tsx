// The consent page as a whole HTML document, for the /oauth/authorize route to send (warden's PR B injects it as
// renderConsent). Its own entry point ("@writ/job-send-ui/consent-html"), so react-dom/server never reaches a
// browser bundle through the package index. No script and no inline style: the page works under a strict CSP
// (default-src 'none'; form-action 'self' plus the pending redirect's origin, as #517 sends it: browsers apply
// form-action to the redirect after the POST, so 'self' alone would stop Allow and Deny) and posts with the browser alone.
import { renderToStaticMarkup } from "react-dom/server";
import { ConsentForm, type ConsentView } from "../screens/Consent";

export type { ConsentView };

/** The full page: doctype, charset, viewport, title, and the consent form. React escapes every value. */
export function renderConsentHtml(view: ConsentView): string {
  return `<!doctype html>${renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Connect an agent to SpeedWrit</title>
      </head>
      <body>
        <main>
          <ConsentForm view={view} />
        </main>
      </body>
    </html>,
  )}`;
}
