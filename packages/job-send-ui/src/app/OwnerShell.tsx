import type { ReactNode } from "react";
import { Logo } from "./Logo";

const LINKS = [
  ["connect", "Connections", "Connect Gmail and your agent, then create a job."],
  ["new", "New job", "Set the limits. Review the job before you confirm it."],
  ["exceptions", "Waiting for you", "Review the exact draft and version before approving a send."],
  ["jobs", "Jobs", "Open a job to inspect its recorded activity and signed receipts."],
  ["verify", "Verify", "Check a receipt against the public key pinned in this app."],
] as const;

/** Presentation only: every screen keeps its real owner API and existing hash route. */
export function OwnerShell({ path, children }: { path: string; children: ReactNode }) {
  const active = LINKS.find(([id]) => path === `/${id}` || path.startsWith(`/${id}/`));
  return (
    <div className="owner-shell" data-view={active?.[0] ?? "other"}>
      <a className="owner-skip" href="#owner-content" onClick={(event) => { event.preventDefault(); document.getElementById("owner-content")?.focus(); }}>Skip to content</a>
      <header className="owner-header">
        <div className="owner-topbar">
          <a className="owner-brand" href="#/connect" aria-label="SpeedWrit home"><Logo height={62} /></a>
          <div className="owner-heading"><strong>SpeedWrit</strong><span>Your jobs. Your call.</span></div>
          <nav className="owner-nav" aria-label="Owner">
            {LINKS.map(([id, label]) => <a key={id} href={`#/${id}`} aria-current={active?.[0] === id ? "page" : undefined}>{label}</a>)}
          </nav>
        </div>
      </header>
      <div className="owner-layout">
        <div className="owner-context"><span className="owner-eyebrow">OWNER WORKSPACE</span><p>{active?.[2] ?? "Choose a page above to continue."}</p></div>
        <main id="owner-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
