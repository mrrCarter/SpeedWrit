// The owner app's browser entry (bundled by scripts/build-owner-app.mjs; never imported by the index). The receipt
// key is compiled in at build time, so /verify does not trust the server at run time (spec: "Verification away from
// the signer"). Everything else comes from /owner-app/config.json, which the app server writes from its environment.
import { decodeBase64Url } from "@writ/job-send/verify";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OwnerApi } from "./api";
import type { OwnerAppConfig } from "./config";
import { OwnerApp } from "./OwnerApp";
import { OwnerAppBootstrap } from "./OwnerAppBootstrap";

declare const __RECEIPT_KEY_ID__: string;
declare const __RECEIPT_PUBLIC_KEY_B64URL__: string;


const publicKeyRaw = decodeBase64Url(__RECEIPT_PUBLIC_KEY_B64URL__);
if (!publicKeyRaw || publicKeyRaw.byteLength !== 32) throw new Error("the build's receipt public key is not 32 bytes");
const PINNED = { keyId: __RECEIPT_KEY_ID__, publicKeyRaw };

const hashRoute = () => window.location.hash || "#/connect";

function Root({ config }: { config: OwnerAppConfig }) {
  const api = useMemo(() => new OwnerApi(), []);
  const [route, setRoute] = useState(hashRoute);
  useEffect(() => {
    const follow = () => setRoute(hashRoute());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  return (
    <OwnerApp
      api={api}
      pinned={PINNED}
      jobDefaults={config.jobDefaults}
      contacts={config.contacts}
      connectGmailHref={config.connectGmailHref}
      timeZone={config.timeZone}
      route={route}
      navigate={(next) => {
        window.location.hash = next;
      }}
      signIn={(href) => window.location.assign(href)}
    />
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<OwnerAppBootstrap>{(config) => <Root config={config} />}</OwnerAppBootstrap>);
