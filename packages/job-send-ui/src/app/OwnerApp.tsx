// The owner app: the screens over the owner API, behind hash routes so the server serves one page.
//   #/connect     Connections: Gmail (or Connect Gmail), the agent connection, STOP
//   #/new         the front door, then Confirm job (confirms exactly the hash it showed)
//   #/exceptions  pending versions: Approve or Reject exactly the version shown
//   #/exceptions/<proposal_id>  the same list, that proposal's card first (the link an alert carries)
//   #/jobs        the owner's jobs;  #/jobs/<id>  that job's Flight Recorder
//   #/verify      check a receipt against the pinned key (opened from a Flight Recorder row, or pasted)
// A 401 sends the browser to sign-in and back. Every outcome is said in the Say / Never-say table's words.
import { useCallback, useEffect, useState } from "react";
import { SAY } from "../lib/copy";
import type { Contact } from "../lib/frontDoor";
import { ConfirmJob } from "../screens/ConfirmJob";
import { Connect } from "../screens/Connect";
import { AgentConnectionSetup } from "../screens/AgentConnectionSetup";
import { ExceptionCard, type PendingVersion } from "../screens/ExceptionCard";
import { FlightRecorder } from "../screens/FlightRecorder";
import { FrontDoor, type CompleteDraft } from "../screens/FrontDoor";
import { pinnedVerifier, VerifyPage, type Pinned } from "../screens/VerifyPage";
import {
  jobDraftBody,
  jobDraftFromAuthority,
  OwnerApiError,
  signInHref,
  type ApproveAnswer,
  type ConnectState,
  type CreatedJob,
  type JobSummary,
  type ListedReceipt,
  type OwnerApi,
} from "./api";

export interface OwnerAppProps {
  api: OwnerApi;
  /** The receipt key bundled at build time, for #/verify. */
  pinned: Pinned;
  /** What every job from the front door sends: the stage template, its purpose, and whether template sends run without asking. */
  jobDefaults: { templateId: string; purpose: string; autoSend: boolean };
  /** The owner's clients, for the front door's recipient lines. */
  contacts: readonly Contact[];
  /** Machine's Connect Gmail route (a same-site path). */
  connectGmailHref: string;
  timeZone?: string;
  /** The clock the front door reads; the page uses the real one. */
  now?: () => Date;
  /** The current hash route and how to move; the page passes location.hash, tests pass their own. */
  route: string;
  navigate: (route: string) => void;
  /** Leaves the app for sign-in. */
  signIn: (href: string) => void;
}

/** The owner's words for an approval's end. */
export function approveWords(answer: ApproveAnswer): string {
  if (answer.status === "accepted") return SAY.providerAccepted;
  if (answer.status === "unknown") return SAY.outcomeUnknown;
  if (answer.status === "not_sent") return SAY.notSent;
  return answer.reason ? `${SAY.notSent}: ${answer.reason}` : SAY.notSent;
}

/** Runs a call; a 401 leaves for sign-in, any other failure becomes its fixed error code. */
function useCall(signIn: (href: string) => void, route: string) {
  const [problem, setProblem] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
      setProblem(null);
      try {
        return await call();
      } catch (error) {
        if (error instanceof OwnerApiError && error.code === "sign_in") signIn(signInHref(`/${route}`));
        else setProblem(error instanceof OwnerApiError ? error.code : "unknown_error");
        return undefined;
      }
    },
    [signIn, route],
  );
  return { problem, run };
}

const sameSitePath = (href: string) => (href.startsWith("/") && !href.startsWith("//") ? href : null);

function ConnectView({ api, connectGmailHref, call }: { api: OwnerApi; connectGmailHref: string; call: ReturnType<typeof useCall>["run"] }) {
  const [state, setState] = useState<ConnectState | null>(null);
  const refresh = useCallback(async () => {
    const next = await api.connectState();
    if (!next) throw new OwnerApiError(200, "unconfirmed_response");
    setState(next);
    return next;
  }, [api]);
  const load = useCallback(() => void call(refresh), [call, refresh]);
  useEffect(load, [load]);
  if (!state) return <p>Loading…</p>;
  const connectGmail = sameSitePath(connectGmailHref);
  return (
    <>
      <Connect
        gmail={state.gmail}
        agentConnection={state.agentConnection}
        stopped={state.stopped || !state.connectionId}
        onStop={() => state.connectionId && void call(() => api.stop(state.connectionId!)).then(load)}
      />
      {/* Connect while none is linked; Reconnect when Google's grant lapsed (needs_reconnect), or the owner has no way back. */}
      {!connectGmail ? null : !state.gmail ? (
        <a href={connectGmail}>Connect Gmail</a>
      ) : state.gmail.status === "needs_reconnect" ? (
        <a href={connectGmail}>Reconnect Gmail</a>
      ) : null}
      <details>
        <summary>Setup guide: ChatGPT, Grokbot, and AI review</summary>
        <ol>
          <li><strong>Connect Gmail.</strong> Check the Gmail account above; use Connect Gmail if none is linked.</li>
          <li>
            <p><strong>Connect your agent.</strong> In ChatGPT app setup, choose OAuth with automatic client registration and use this public MCP address.</p>
            <p>
              <label>
                ChatGPT MCP server URL<br />
                <input type="url" value={new URL("/mcp", window.location.href).href} readOnly autoComplete="off" />
              </label>
            </p>
            <p>
              No manual client ID or client secret is needed. For the terminal Grokbot client, use Private URL setup below.
              After connecting, refresh Connections, then reopen New job if it was already open.
            </p>
          </li>
          <li>
            <strong>Create a job.</strong> <a href="#/new">Set up and confirm a job</a> with the recipient, send limit, and expiry you want.
            New jobs use your most recently connected active agent. Each job stays bound to that connection; an existing ChatGPT job does not transfer to Grokbot.
          </li>
          <li>
            <strong>Review held drafts.</strong> Open <a href="#/exceptions">drafts waiting for your approval</a>, review the exact version shown, then approve or reject it.
            Approval can send the draft if the job still permits it. STOP sending is available above.
          </li>
        </ol>
        <p><strong>Where AI review fits:</strong> Jobs request AI review for custom wording by default. Adding AI content rules also requests review of template text. A flag or unavailable review sends the draft to Waiting for you for owner approval. AI review cannot approve a draft, send an email, grant permissions, or change the job's limits.</p>
      </details>
      <AgentConnectionSetup
        api={api}
        connection={state.agentConnectionId ? { id: state.agentConnectionId, label: state.agentConnection?.label ?? "Agent" } : null}
        call={call}
        reload={refresh}
      />
    </>
  );
}

function NewJobView(props: Pick<OwnerAppProps, "api" | "jobDefaults" | "contacts" | "timeZone" | "now" | "navigate"> & { call: ReturnType<typeof useCall>["run"] }) {
  const { api, jobDefaults, contacts, timeZone, now, navigate, call } = props;
  const [created, setCreated] = useState<CreatedJob | null>(null);
  const [ids, setIds] = useState<ConnectState | null>(null);
  useEffect(() => void call(() => api.connectState()).then((state) => state && setIds(state)), [api, call]);
  if (!created) {
    if (ids && (!ids.connectionId || !ids.agentConnectionId)) {
      return <p>Connect Gmail and an agent first: a job binds to both.</p>;
    }
    return (
      <FrontDoor
        contacts={contacts}
        timeZone={timeZone}
        {...(now ? { now } : {})}
        onUse={(draft: CompleteDraft) => {
          if (!ids?.connectionId || !ids.agentConnectionId) return;
          const body = jobDraftBody(draft, { connectionId: ids.connectionId, agentConnectionId: ids.agentConnectionId }, jobDefaults);
          void call(() => api.createJob(body)).then((job) => job && setCreated(job));
        }}
      />
    );
  }
  return (
    <ConfirmJob
      job={jobDraftFromAuthority(created.job)}
      authoritySha256={created.authoritySha256}
      timeZone={timeZone}
      onConfirm={(jobId, sha) => void call(() => api.confirmJob(jobId, sha)).then((done) => done && navigate(`#/jobs/${jobId}`))}
    />
  );
}

function ExceptionsView({ api, call, focus }: { api: OwnerApi; call: ReturnType<typeof useCall>["run"]; focus?: string }) {
  const [pending, setPending] = useState<PendingVersion[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(() => void call(() => api.pending()).then((next) => next && setPending(next.pending)), [api, call]);
  useEffect(load, [load]);
  if (!pending) return <p>Loading…</p>;
  // An alert's link names one proposal. Its card comes first and marked; it is the same card as in the list (the
  // version, hash and Approve the server listed), so the link only orders what is shown and decides nothing.
  const focused = focus === undefined ? [] : pending.filter((version) => version.proposalId === focus);
  const card = (version: PendingVersion) => (
    <ExceptionCard
      key={`${version.proposalId}#${version.version}`}
      pending={version}
      onApprove={(proposalId, number, sha) => void call(() => api.approve(proposalId, number, sha)).then((answer) => answer && (setSaid(approveWords(answer)), load()))}
      onReject={(proposalId, number, sha) => void call(() => api.reject(proposalId, number, sha)).then((done) => done && (setSaid("Rejected. Nothing was sent."), load()))}
    />
  );
  return (
    <section aria-label="Exceptions">
      <h2>Waiting for you</h2>
      {said ? <p role="status">{said}</p> : null}
      {focus !== undefined && focused.length === 0 ? <p>That proposal is not waiting for you any more.</p> : null}
      {focused.length > 0 ? <section aria-label="From your alert">{focused.map(card)}</section> : null}
      {pending.length === 0 ? <p>Nothing is waiting for you.</p> : null}
      {pending.filter((version) => !focused.includes(version)).map(card)}
    </section>
  );
}

function JobsView({ api, call }: { api: OwnerApi; call: ReturnType<typeof useCall>["run"] }) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  useEffect(() => void call(() => api.jobs()).then((next) => next && setJobs(next.jobs)), [api, call]);
  if (!jobs) return <p>Loading…</p>;
  return (
    <section aria-label="Jobs">
      <h2>Jobs</h2>
      {jobs.length === 0 ? <p>No jobs yet.</p> : null}
      <ul>
        {jobs.map((job) => (
          <li key={job.jobId}>
            <a href={`#/jobs/${encodeURIComponent(job.jobId)}`}>{job.purpose}</a> · to {job.recipient} · {job.status} · {job.sendsLeft}{" "}
            {job.sendsLeft === 1 ? "send" : "sends"} left
          </li>
        ))}
      </ul>
    </section>
  );
}

function JobView({ api, jobId, call, onReceipts }: { api: OwnerApi; jobId: string; call: ReturnType<typeof useCall>["run"]; onReceipts: (r: ListedReceipt[]) => void }) {
  const [receipts, setReceipts] = useState<ListedReceipt[] | null>(null);
  const load = useCallback(
    () =>
      void call(() => api.receipts(jobId)).then((next) => {
        if (!next) return;
        setReceipts(next.receipts);
        onReceipts(next.receipts);
      }),
    [api, jobId, call, onReceipts],
  );
  useEffect(load, [load]);
  if (!receipts) return <p>Loading…</p>;
  const texts = new Map(receipts.map((receipt) => [receipt.id, receipt.text]));
  return (
    <>
      <FlightRecorder jobId={jobId} receipts={receipts} receiptText={(id) => texts.get(id)} onResolve={(dispatchId, outcome) => void call(() => api.resolve(dispatchId, outcome)).then(load)} />
      <p>
        Check any receipt yourself: <a href="#/verify">Verify a receipt</a>
      </p>
    </>
  );
}

/** A route segment decoded, or null when it is not valid percent-encoding: a bad link is Not found, not a crash. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The owner app. */
export function OwnerApp(props: OwnerAppProps) {
  const { api, route, signIn } = props;
  const { problem, run } = useCall(signIn, route);
  const [lastReceipts, setLastReceipts] = useState<ListedReceipt[]>([]);
  const path = route.replace(/^#/, "") || "/connect";
  const exceptionsMatch = /^\/exceptions(?:\/([^/]+))?$/.exec(path);
  const focus = exceptionsMatch?.[1] === undefined ? undefined : decodeSegment(exceptionsMatch[1]);
  const jobMatch = /^\/jobs\/([^/]+)$/.exec(path);
  const jobId = jobMatch ? decodeSegment(jobMatch[1] ?? "") : null;
  let view;
  if (path === "/connect") view = <ConnectView api={api} connectGmailHref={props.connectGmailHref} call={run} />;
  else if (path === "/new") view = <NewJobView {...props} call={run} />;
  else if (exceptionsMatch && focus !== null) view = <ExceptionsView api={api} call={run} focus={focus} />;
  else if (path === "/jobs") view = <JobsView api={api} call={run} />;
  else if (jobId !== null) view = <JobView api={api} jobId={jobId} call={run} onReceipts={setLastReceipts} />;
  else if (path === "/verify") view = <VerifyPage keyFingerprint={props.pinned.keyId} verify={pinnedVerifier(props.pinned)} initialReceipt={lastReceipts.length === 1 ? lastReceipts[0]?.text : ""} />;
  else view = <p>Not found.</p>;
  return (
    <div>
      <nav aria-label="Owner">
        <a href="#/connect">Connections</a> · <a href="#/new">New job</a> · <a href="#/exceptions">Waiting for you</a> · <a href="#/jobs">Jobs</a> ·{" "}
        <a href="#/verify">Verify</a>
      </nav>
      {problem ? (
        <p role="alert">
          {SAY.requestUnconfirmed} ({problem}) <a href="#/jobs">Open Jobs</a>.
        </p>
      ) : null}
      <main>{view}</main>
    </div>
  );
}
