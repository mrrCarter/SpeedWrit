import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Job } from "@writ/job-send/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobDraftBody, jobDraftFromAuthority, OwnerApi, OwnerApiError, type ConnectState, type ListedReceipt } from "../src/app/api";
import { approveWords, OwnerApp, type OwnerAppProps } from "../src/app/OwnerApp";
import { SAY, findNeverSay } from "../src/lib/copy";
import type { PendingVersion } from "../src/screens/ExceptionCard";

afterEach(cleanup);

const SHA = "9f2c1e0b7a6d5c4b3a291807f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3";
const CONNECTED: ConnectState = {
  gmail: { address: "owner@test.example", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"] },
  agentConnection: { mcpUrl: "https://jobs.example.com/mcp", label: "ChatGPT", lastUsedAt: null },
  stopped: false,
  connectionId: "conn_1",
  agentConnectionId: "ac_1",
};
const AUTHORITY: Job = {
  v: 1,
  job_id: "job_1",
  policy_version: 1,
  owner: "own_1",
  connection: "conn_1",
  agent_connection: "ac_1",
  provider: "gmail",
  sender: "owner@test.example",
  recipient: "dana@acme.com",
  purpose: "Send Dana a recap of Tuesday's call.",
  template: { id: "tpl_recap", sha256: SHA },
  field_rules: { recap: { max: 600, required: true, free_text: true } },
  max_sends: 2,
  expires_at: "2026-10-12T06:59:00.000Z",
  auto_send: true,
  allow_custom_with_approval: true,
  ai_review: "custom_only",
};
const PENDING: PendingVersion = {
  proposalId: "p2",
  version: 2,
  versionSha256: SHA,
  reasons: ["custom_content"],
  aiFlags: [],
  subject: "Recap",
  body: "Hi Dana, here is the full recap.",
  baseline: { label: "version 1", subject: "Recap", body: "Hi Dana, here is the recap." },
};
const RECEIPTS: ListedReceipt[] = [
  { id: "r1", seq: 1, type: "JOB_CONFIRMED", ts: "2026-10-11T19:00:00Z", text: '{"key_id":"k"}' },
  { id: "r2", seq: 2, type: "OUTCOME_UNKNOWN", ts: "2026-10-11T19:04:00Z", proposal: "p1", version: 1, detail: { error_class: "timeout", dispatch: "d1" }, text: "{}" },
];

/** A fake owner API: each method a vi.fn resolving to a fixture. */
function fakeApi(overrides: Partial<Record<keyof OwnerApi, (...args: never[]) => Promise<unknown>>> = {}) {
  const api = {
    integrations: vi.fn(async () => ({ jev: { configured: false, model: "jev-1.13.0" }, dial: { configured: false, live: false, enabled: false, status: "unconfigured", pending: 0, last_result: null } })),
    setAlertsEnabled: vi.fn(async () => ({ enabled: false })),
    testAlert: vi.fn(async () => ({ queued: true })),
    me: vi.fn(async () => ({ owner: { id: "own_1", email: "owner@test.example" } })),
    connectState: vi.fn(async () => CONNECTED),
    stop: vi.fn(async () => ({ stopped: true, receipt_ids: ["r9"] })),
    createJob: vi.fn(async () => ({ job: AUTHORITY, authoritySha256: SHA })),
    confirmJob: vi.fn(async () => ({ policyVersion: 1, receipt_id: "r1" })),
    jobs: vi.fn(async () => ({ jobs: [{ jobId: "job_1", purpose: AUTHORITY.purpose, recipient: AUTHORITY.recipient, status: "active", expiresAt: AUTHORITY.expires_at, sendsLeft: 2 }] })),
    pending: vi.fn(async () => ({ pending: [PENDING] })),
    approve: vi.fn(async () => ({ status: "accepted", receipt_id: "r5" })),
    reject: vi.fn(async () => ({ receipt_id: "r6" })),
    resolve: vi.fn(async () => ({ receipt_id: "r7" })),
    receipts: vi.fn(async () => ({ receipts: RECEIPTS })),
    ...overrides,
  };
  return api as unknown as OwnerApi & typeof api;
}

function renderApp(route: string, api = fakeApi(), extra: Partial<OwnerAppProps> = {}) {
  const navigate = vi.fn();
  const signIn = vi.fn();
  const props: OwnerAppProps = {
    api,
    pinned: { keyId: "0123456789abcdef", publicKeyRaw: new Uint8Array(32) },
    jobDefaults: { templateId: "tpl_recap", purpose: AUTHORITY.purpose, autoSend: true },
    contacts: [{ name: "Dana Ruiz", company: "Acme", email: "dana@acme.com" }],
    connectGmailHref: "/connect/gmail",
    timeZone: "America/Los_Angeles",
    now: () => new Date("2026-10-11T16:00:00Z"),
    route,
    navigate,
    signIn,
    ...extra,
  };
  render(<OwnerApp {...props} />);
  return { api, navigate, signIn };
}

describe("the owner API client", () => {
  it("writes are JSON, same-origin; a 401 is sign_in and any other error keeps its code", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const answers = [
      { ok: true, status: 200, json: async () => ({ receipt_id: "r1" }) },
      // Any 401 means "sign in", whatever its body says.
      { ok: false, status: 401, json: async () => ({ error: "session_expired" }) },
      { ok: false, status: 409, json: async () => ({ error: "authority_changed" }) },
      { ok: false, status: 500, json: async () => Promise.reject(new Error("not json")) },
    ];
    const api = new OwnerApi(async (url, init) => {
      calls.push({ url, init: init as Record<string, unknown> });
      return answers.shift()!;
    });
    await api.reject("p2", 2, SHA);
    expect(calls[0]).toEqual({
      url: "/owner/versions/reject",
      init: {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ proposal_id: "p2", version: 2, shown_sha256: SHA }),
      },
    });
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: "sign_in" });
    await expect(api.confirmJob("job_1", SHA)).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    await expect(api.pending()).rejects.toMatchObject({ status: 500, code: "unknown_error" });
    expect(calls[1]?.init.headers).toEqual({ accept: "application/json" });
  });

  it("the front door's draft becomes the flat job body, bound to the owner's own connections", () => {
    const body = jobDraftBody(
      { recipient: "dana@acme.com", maxSends: 2, expiresAt: AUTHORITY.expires_at, allowCustomWithApproval: true },
      { connectionId: "conn_1", agentConnectionId: "ac_1" },
      { templateId: "tpl_recap", purpose: AUTHORITY.purpose, autoSend: true },
    );
    expect(body).toEqual({
      connection_id: "conn_1",
      agent_connection_id: "ac_1",
      recipient: "dana@acme.com",
      purpose: AUTHORITY.purpose,
      template_id: "tpl_recap",
      max_sends: 2,
      expires_at: AUTHORITY.expires_at,
      auto_send: true,
      allow_custom_with_approval: true,
      ai_review: "custom_only",
    });
    expect(jobDraftBody({ recipient: "x@y.z", maxSends: 1, expiresAt: "t" }, { connectionId: "c", agentConnectionId: "a" }, { templateId: "t", purpose: "p", autoSend: false }).allow_custom_with_approval).toBe(false);
  });

  it("the confirm screen reads exactly the authority object the hash covers", () => {
    expect(jobDraftFromAuthority(AUTHORITY)).toEqual({
      jobId: "job_1",
      policyVersion: 1,
      agentConnectionId: "ac_1",
      recipient: "dana@acme.com",
      purpose: AUTHORITY.purpose,
      template: { id: "tpl_recap" },
      fieldRules: AUTHORITY.field_rules,
      maxSends: 2,
      expiresAt: AUTHORITY.expires_at,
      autoSend: true,
      allowCustomWithApproval: true,
      aiReview: "custom_only",
    });
  });

  it("approval codes become the Say table's words; nothing claims more", () => {
    expect(approveWords({ status: "accepted", receipt_id: "r" })).toBe(SAY.providerAccepted);
    expect(approveWords({ status: "unknown", receipt_id: "r" })).toBe(SAY.outcomeUnknown);
    expect(approveWords({ status: "not_sent", receipt_id: "r" })).toBe(SAY.notSent);
    expect(approveWords({ status: "refused", reason: "superseded", receipt_id: "r" })).toBe(`${SAY.notSent}: superseded`);
  });
});

/** A fake server for the real OwnerApi: answers by method and path, and records every POST body. */
function fakeServer(answer: (method: string, path: string, calls: number) => unknown) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const counts = new Map<string, number>();
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (method === "POST") posts.push({ path: url, body: JSON.parse(init?.body ?? "null") });
    return { ok: true, status: 200, json: async () => answer(method, url, n) };
  };
  return { api: new OwnerApi(fetchImpl), posts };
}

describe("the bodies the client posts: exactly the values it was given", () => {
  it("every write sends its arguments, and only them, under the schema's names", async () => {
    const { api, posts } = fakeServer(() => ({}));
    await api.stop("conn_1");
    await api.confirmJob("job_1", SHA);
    await api.approve("p2", 2, SHA);
    await api.reject("p2", 2, SHA);
    await api.resolve("d1", "not_arrived");
    expect(posts).toEqual([
      { path: "/owner/stop", body: { connection_id: "conn_1" } },
      { path: "/owner/jobs/confirm", body: { job_id: "job_1", authority_sha256: SHA } },
      { path: "/owner/versions/approve", body: { proposal_id: "p2", version: 2, shown_sha256: SHA } },
      { path: "/owner/versions/reject", body: { proposal_id: "p2", version: 2, shown_sha256: SHA } },
      { path: "/owner/dispatches/resolve", body: { dispatch_id: "d1", outcome: "not_arrived" } },
    ]);
  });
});

// "Approve exactly what you saw" (spec): the hash that goes out is the one the screen rendered, even when the server's
// current hash has moved on since. The server refuses a mismatch; these tests make sure the client never "helps" by
// sending the current one instead.
describe("the client posts the hash the screen showed, not the server's current one", () => {
  const SHOWN = SHA;
  const CURRENT = "1".repeat(64);

  it("Confirm posts the createJob answer's authoritySha256, even though later reads report another", async () => {
    const { api, posts } = fakeServer((method, path) => {
      if (method === "GET" && path === "/owner/connect") return CONNECTED;
      if (method === "POST" && path === "/owner/jobs") return { job: AUTHORITY, authoritySha256: SHOWN };
      // The core's own shape (listJobs, #526): the server's view of the job now carries another hash.
      if (method === "GET" && path === "/owner/jobs") return { jobs: [{ job: AUTHORITY, authoritySha256: CURRENT, status: "draft", sendsReserved: 0, sendsLeft: 2 }] };
      return { policyVersion: 1, receipt_id: "r1" };
    });
    renderApp("#/new", api as never);
    fireEvent.click(await screen.findByRole("button", { name: "Review this job" }));
    expect(await screen.findByText(SHOWN.slice(0, 12))).toBeTruthy();
    await api.jobs(); // the server's view moves on; the screen still shows SHOWN
    fireEvent.click(screen.getByRole("button", { name: "Confirm job" }));
    await waitFor(() => expect(posts.some((post) => post.path === "/owner/jobs/confirm")).toBe(true));
    expect(posts.find((post) => post.path === "/owner/jobs/confirm")?.body).toEqual({ job_id: "job_1", authority_sha256: SHOWN });
  });

  it("Approve posts the rendered card's hash; only after a reload does a card show (and post) the new one", async () => {
    const { api, posts } = fakeServer((method, path, calls) => {
      // The core's own shape (listPendingVersions, #526); the client maps it to the card's.
      if (method === "GET" && path === "/owner/pending") {
        return {
          pending: [
            {
              proposalId: "p2",
              jobId: "job_1",
              version: 2,
              sha256: calls === 1 ? SHOWN : CURRENT,
              reviewReasons: ["custom_content"],
              recipient: "dana@acme.com",
              subject: PENDING.subject,
              body: PENDING.body,
              createdAt: "2026-10-11T19:02:00Z",
              baseline: { subject: PENDING.baseline.subject, body: PENDING.baseline.body },
            },
          ],
        };
      }
      if (path === "/owner/versions/approve") return { status: "refused", reason: "superseded", receipt_id: "r9" };
      return {};
    });
    renderApp("#/exceptions", api as never);
    fireEvent.click(await screen.findByRole("button", { name: "Approve version 2" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/owner/versions/approve", body: { proposal_id: "p2", version: 2, shown_sha256: SHOWN } });
    // The refusal reloads the list; the card now renders CURRENT, and only that is what a second Approve sends.
    expect(await screen.findByText(CURRENT.slice(0, 16))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve version 2" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.body).toEqual({ proposal_id: "p2", version: 2, shown_sha256: CURRENT });
  });
});

describe("OwnerApp", () => {
  it("Connections: STOP stops the owner's own Gmail connection and reloads", async () => {
    const { api } = renderApp("#/connect");
    fireEvent.click(await screen.findByRole("button", { name: "STOP sending" }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith("conn_1"));
    await waitFor(() => expect(api.connectState).toHaveBeenCalledTimes(2));
  });

  it("Connections: with no Gmail it links to Connect Gmail (a same-site path only)", async () => {
    const api = fakeApi({ connectState: async () => ({ ...CONNECTED, gmail: null, connectionId: null }) });
    renderApp("#/connect", api);
    expect((await screen.findByRole("link", { name: "Connect Gmail" })).getAttribute("href")).toBe("/connect/gmail");
    cleanup();
    renderApp("#/connect", fakeApi({ connectState: async () => ({ ...CONNECTED, gmail: null, connectionId: null }) }), { connectGmailHref: "https://evil.example/x" });
    await screen.findByText("No Gmail account connected");
    expect(screen.queryByRole("link", { name: "Connect Gmail" })).toBeNull();
  });

  it("Connections: a lapsed Google grant offers Reconnect Gmail; a working one offers no link", async () => {
    const lapsed = { ...CONNECTED, gmail: { ...CONNECTED.gmail!, status: "needs_reconnect" as const } };
    renderApp("#/connect", fakeApi({ connectState: async () => lapsed }));
    expect((await screen.findByRole("link", { name: "Reconnect Gmail" })).getAttribute("href")).toBe("/connect/gmail");
    expect(screen.getByText(/Google access lapsed/)).toBeTruthy();
    cleanup();
    renderApp("#/connect", fakeApi({ connectState: async () => ({ ...CONNECTED, gmail: { ...CONNECTED.gmail!, status: "active" as const } }) }));
    await screen.findByRole("button", { name: "STOP sending" });
    expect(screen.queryByRole("link", { name: /Connect Gmail|Reconnect Gmail/ })).toBeNull();
  });

  it("New job: explicit limits make a draft; Confirm posts the returned authority hash, then opens the job", async () => {
    const { api, navigate } = renderApp("#/new");
    const review = await screen.findByRole("button", { name: "Review this job" });
    const agent = screen.getByRole("region", { name: "Agent for this job" });
    expect(within(agent).getByText("ChatGPT").tagName).toBe("BDI");
    expect(within(agent).getByText("ac_1")).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Sends at most" })).toHaveValue(3);
    expect(api.createJob).not.toHaveBeenCalled();
    expect(api.confirmJob).not.toHaveBeenCalled();
    fireEvent.click(review);
    await waitFor(() => expect(api.createJob).toHaveBeenCalledTimes(1));
    expect(api.createJob).toHaveBeenCalledWith({
      connection_id: "conn_1",
      agent_connection_id: "ac_1",
      recipient: "dana@acme.com",
      purpose: AUTHORITY.purpose,
      template_id: "tpl_recap",
      max_sends: 3,
      expires_at: "2026-10-12T06:59:00.000Z",
      auto_send: true,
      allow_custom_with_approval: true,
      ai_review: "custom_only",
    });
    const confirm = await screen.findByRole("button", { name: "Confirm job" });
    // The server returned a two-send authority even though three was requested: review exactly that object.
    expect(screen.getByText("More than 2 sends")).toBeInTheDocument();
    expect(api.confirmJob).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.confirmJob).toHaveBeenCalledWith("job_1", SHA));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("#/jobs/job_1"));
  });

  it("New job: confirmation shows the returned authority's agent, not captured or newer connection metadata", async () => {
    const current = { ...CONNECTED, agentConnectionId: "ac_newer", agentConnection: { ...CONNECTED.agentConnection!, label: "Newer client" } };
    const connectState = vi.fn().mockResolvedValueOnce(CONNECTED).mockResolvedValue(current);
    const returned = { ...AUTHORITY, job_id: "job_returned", agent_connection: "ac_authority" };
    const api = fakeApi({ connectState, createJob: vi.fn(async () => ({ job: returned, authoritySha256: SHA })) });
    renderApp("#/new", api);
    const review = await screen.findByRole("button", { name: "Review this job" });
    await api.connectState(); // Another read now sees a newer connection; the open form keeps its snapshot.
    expect(screen.getByText("ac_1")).toBeVisible();
    expect(screen.queryByText("ac_newer")).toBeNull();
    fireEvent.click(review);
    const confirm = await screen.findByRole("region", { name: "Confirm job job_returned" });
    expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ agent_connection_id: "ac_1" }));
    expect(within(confirm).getByText("ac_authority")).toBeVisible();
    for (const stale of ["ac_1", "ChatGPT", "ac_newer", "Newer client"]) expect(within(confirm).queryByText(stale)).toBeNull();
    expect(api.confirmJob).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm job" }));
    await waitFor(() => expect(api.confirmJob).toHaveBeenCalledWith("job_returned", SHA));
    expect(connectState).toHaveBeenCalledTimes(2);
  });

  it("New job: the captured stable ID remains visible when a connection label is unavailable", async () => {
    renderApp("#/new", fakeApi({ connectState: async () => ({ ...CONNECTED, agentConnection: null }) }));
    const agent = await screen.findByRole("region", { name: "Agent for this job" });
    expect(within(agent).getByText("ac_1")).toBeVisible();
    expect(within(agent).queryByText("ChatGPT")).toBeNull();
    expect(screen.getByRole("button", { name: "Review this job" })).toBeEnabled();
  });

  it("New job: cannot review a draft until connection identity has loaded", async () => {
    let resolve!: (value: ConnectState) => void;
    const connection = new Promise<ConnectState>((done) => { resolve = done; });
    const api = fakeApi({ connectState: () => connection });
    renderApp("#/new", api);
    expect(screen.getByRole("status")).toHaveTextContent("Loading connections");
    expect(screen.queryByRole("button", { name: "Review this job" })).toBeNull();
    expect(api.createJob).not.toHaveBeenCalled();
    await act(async () => resolve(CONNECTED));
    expect(await screen.findByRole("button", { name: "Review this job" })).toBeEnabled();
    expect(api.createJob).not.toHaveBeenCalled();
  });

  it("New job: without both connections there is no draft to make", async () => {
    renderApp("#/new", fakeApi({ connectState: async () => ({ ...CONNECTED, agentConnection: null, agentConnectionId: null }) }));
    expect(await screen.findByText("Connect Gmail and an agent first: a job binds to both.")).toBeTruthy();
  });

  it("Waiting for you: Approve and Reject send the version and hash shown, and say the outcome in the spec's words", async () => {
    const { api } = renderApp("#/exceptions");
    fireEvent.click(await screen.findByRole("button", { name: "Approve version 2" }));
    expect(await screen.findByText(SAY.providerAccepted)).toBeTruthy();
    expect(api.approve).toHaveBeenCalledWith("p2", 2, SHA);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. Nothing was sent.")).toBeTruthy();
    expect(api.reject).toHaveBeenCalledWith("p2", 2, SHA);
  });

  it("an alert's link, #/exceptions/<proposal_id>, puts that proposal's card first and marked; Approve sends its own hash", async () => {
    const SHA3 = "3".repeat(64);
    const P3: PendingVersion = { ...PENDING, proposalId: "p3", version: 1, versionSha256: SHA3, baseline: { label: "nothing earlier (the first version)", subject: "", body: "" } };
    const cards = () => screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"));
    const { api } = renderApp("#/exceptions/p3", fakeApi({ pending: async () => ({ pending: [PENDING, P3] }) }));
    const marked = await screen.findByRole("region", { name: "From your alert" });
    expect(within(marked).getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Version 1 of p3"]);
    expect(cards()).toEqual(["Version 1 of p3", "Version 2 of p2"]);
    expect(screen.queryByText("That proposal is not waiting for you any more.")).toBeNull();
    fireEvent.click(within(marked).getByRole("button", { name: "Approve version 1" }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith("p3", 1, SHA3));
    cleanup();
    // Without the id: the server's order, nothing marked.
    renderApp("#/exceptions", fakeApi({ pending: async () => ({ pending: [PENDING, P3] }) }));
    await screen.findAllByRole("article");
    expect(cards()).toEqual(["Version 2 of p2", "Version 1 of p3"]);
    expect(screen.queryByRole("region", { name: "From your alert" })).toBeNull();
  });

  it("an alert's link for a proposal no longer waiting says so and lists the rest; a malformed link is Not found", async () => {
    renderApp("#/exceptions/p9");
    expect(await screen.findByText("That proposal is not waiting for you any more.")).toBeTruthy();
    expect(screen.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Version 2 of p2"]);
    expect(screen.queryByRole("region", { name: "From your alert" })).toBeNull();
    cleanup();
    renderApp("#/exceptions");
    await screen.findByRole("article");
    expect(screen.queryByText("That proposal is not waiting for you any more.")).toBeNull();
    cleanup();
    for (const route of ["#/exceptions/%E0", "#/jobs/%E0", "#/exceptions/p2/x"]) {
      renderApp(route);
      expect(screen.getByText("Not found."), route).toBeTruthy();
      cleanup();
    }
  });

  it("a 401 on an alert's link comes back to the same link after sign-in", async () => {
    const { signIn } = renderApp("#/exceptions/p3", fakeApi({ pending: async () => Promise.reject(new OwnerApiError(401, "sign_in")) }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("/auth/sign-in?return_to=%2F%23%2Fexceptions%2Fp3"));
  });

  it("a 401 anywhere leaves for sign-in and comes back to the same view", async () => {
    const { signIn } = renderApp("#/exceptions", fakeApi({ pending: async () => Promise.reject(new OwnerApiError(401, "sign_in")) }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("/auth/sign-in?return_to=%2F%23%2Fexceptions"));
  });

  it("another request failure shows its code and offers the recorder without claiming a send outcome", async () => {
    renderApp("#/exceptions", fakeApi({ approve: async () => Promise.reject(new OwnerApiError(409, "superseded")) }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve version 2" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`${SAY.requestUnconfirmed} (superseded) Open Jobs.`);
    expect(within(alert).getByRole("link", { name: "Open Jobs" }).getAttribute("href")).toBe("#/jobs");
  });

  it.each(["lost response", "503 response"])("an approval with a %s stays unconfirmed and is never automatically retried", async (failure) => {
    const posts: unknown[] = [];
    const api = new OwnerApi(async (path, init) => {
      if (path === "/owner/pending") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pending: [{
              proposalId: PENDING.proposalId,
              jobId: "job_1",
              version: PENDING.version,
              sha256: PENDING.versionSha256,
              reviewReasons: PENDING.reasons,
              recipient: AUTHORITY.recipient,
              subject: PENDING.subject,
              body: PENDING.body,
              createdAt: "2026-10-11T19:00:00Z",
              baseline: PENDING.baseline,
            }],
          }),
        };
      }
      if (path === "/owner/versions/approve" && init?.method === "POST") {
        posts.push(JSON.parse(init.body!));
        // The request was submitted; neither failure establishes whether the provider sent it.
        if (failure === "lost response") throw new TypeError("Connection closed before the response");
        return { ok: false, status: 503, json: async () => ({ error: "server_error" }) };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const approve = vi.spyOn(api, "approve");
    renderApp("#/exceptions", api as never);
    const button = await screen.findByRole("button", { name: "Approve version 2" });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(button));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(SAY.requestUnconfirmed);
      expect(alert.textContent).toContain(`(${failure === "lost response" ? "unknown_error" : "server_error"})`);
      expect(alert.textContent).toContain("before repeating an action");
      expect(alert.textContent).toContain("Flight Recorder");
      expect(within(alert).getByRole("link", { name: "Open Jobs" }).getAttribute("href")).toBe("#/jobs");
      expect(alert.textContent).not.toMatch(/nothing (?:new )?was sent|not sent/i);
      for (const recordedOutcome of [SAY.providerAccepted, SAY.notSent, SAY.outcomeUnknown]) {
        expect(screen.queryByText(recordedOutcome)).toBeNull();
      }
      // Leaving the failed request on screen cannot schedule another approval.
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve).toHaveBeenCalledWith("p2", 2, SHA);
      expect(posts).toEqual([{ proposal_id: "p2", version: 2, shown_sha256: SHA }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a job's Flight Recorder resolves an UNKNOWN send by its dispatch, in the core's words", async () => {
    const { api } = renderApp("#/jobs/job_1");
    fireEvent.click(await screen.findByRole("button", { name: SAY.resolveSeen }));
    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith("d1", "seen"));
    expect(api.receipts).toHaveBeenCalledWith("job_1");
  });

  it("no view says anything the Say / Never-say table forbids", async () => {
    for (const route of ["#/connect", "#/new", "#/exceptions", "#/exceptions/p2", "#/exceptions/p9", "#/jobs", "#/jobs/job_1", "#/verify"]) {
      renderApp(route);
      if (route === "#/new") await screen.findByRole("button", { name: "Review this job" });
      else await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
      // The exact configured model is diagnostic data, not product prose.
      if (route === "#/connect") await screen.findByText("jev-1.13.0");
      const prose = document.body.cloneNode(true) as HTMLElement;
      if (route === "#/connect") {
        const model = prose.querySelector('[aria-label="Integrations"] code');
        expect(model?.textContent).toBe("jev-1.13.0");
        model?.remove();
      }
      expect(findNeverSay(prose.textContent ?? ""), route).toEqual([]);
      cleanup();
    }
  });
});
