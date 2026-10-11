import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerApi, type ConnectState } from "../src/app/api";
import { OwnerApp, type OwnerAppProps } from "../src/app/OwnerApp";
import { SAY, findNeverSay } from "../src/lib/copy";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

// Synthetic URL only; no provider, OAuth or live secret is used by these tests.
const SECRET_URL = "https://speedwrit.example/mcp/c/synthetic_test_secret";
const CREATED = { url: SECRET_URL, agent_connection_id: "agent_new", receipt_id: "receipt_created" };
const REVOKED = { revoked: true, receipt_id: "receipt_revoked" };
const EMPTY: ConnectState = { gmail: null, agentConnection: null, stopped: false, connectionId: null, agentConnectionId: null };
const EXISTING: ConnectState = {
  ...EMPTY,
  agentConnection: { mcpUrl: "https://speedwrit.example/mcp", label: "Old agent", lastUsedAt: null },
  agentConnectionId: "agent_old",
};
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };
const reply = (data: unknown, status = 200): Reply => ({ ok: status < 400, status, json: async () => data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { create?: () => Promise<Reply> | Reply; revoke?: () => Promise<Reply> | Reply; connection?: ConnectState; staleConnection?: boolean } = {}) {
  let connection = options.connection ?? EMPTY;
  const requests: Array<{ path: string; init: unknown }> = [];
  const api = new OwnerApi(async (path, init) => {
    requests.push({ path, init });
    if (path === "/owner/connect") return reply(connection);
    if (path === "/owner/jobs" && init?.method === "GET") return reply({ jobs: [] });
    if (path === "/owner/agent-connections/secret-path-new") {
      const result = await (options.create?.() ?? reply(CREATED));
      if (result.ok && !options.staleConnection) connection = {
        ...EMPTY,
        agentConnectionId: CREATED.agent_connection_id,
        agentConnection: { mcpUrl: "https://speedwrit.example/mcp", label: "Stage agent", lastUsedAt: null },
      };
      return result;
    }
    if (path === "/owner/agent-connections/revoke") {
      const result = await (options.revoke?.() ?? reply(REVOKED));
      if (result.ok && !options.staleConnection) connection = EMPTY;
      return result;
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const posts = () => requests.filter(request => (request.init as { method?: string }).method === "POST");
  return { api, requests, posts };
}

function show(api: OwnerApi) {
  const props: OwnerAppProps = {
    api, pinned: { keyId: "0123456789abcdef", publicKeyRaw: new Uint8Array(32) },
    jobDefaults: { templateId: "recap", purpose: "A recap", autoSend: true },
    contacts: [], connectGmailHref: "/connect/gmail", route: "#/connect",
    navigate: vi.fn(), signIn: vi.fn(),
  };
  const view = render(<OwnerApp {...props} />);
  return { ...view, signIn: props.signIn, go: (route: string) => view.rerender(<OwnerApp {...props} route={route} />) };
}
async function submitLabel(label = "  Stage agent  ") {
  fireEvent.change(await screen.findByRole("textbox", { name: "Agent label" }), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: "Create agent connection URL" }));
}
const secretField = () => screen.queryByRole("textbox", { name: "Agent connection URL" });

describe("agent connection API contracts", () => {
  it("accepts complete connection states and rejects missing, malformed, or mismatched current state", async () => {
    const connected: ConnectState = {
      ...EXISTING,
      gmail: { address: "owner@example.test", grantedScopes: ["gmail.send"], status: "active" },
      connectionId: "gmail_existing",
    };
    for (const value of [EMPTY, EXISTING, connected]) {
      await expect(new OwnerApi(async () => reply(value)).connectState()).resolves.toEqual(value);
    }
    for (const value of [
      null, {}, [], { ...EMPTY, stopped: undefined }, { ...EMPTY, stopped: "false" },
      { ...EMPTY, connectionId: undefined }, { ...EMPTY, agentConnectionId: undefined },
      { ...EMPTY, gmail: undefined }, { ...EMPTY, agentConnection: undefined },
      { ...EXISTING, agentConnectionId: " " }, { ...EXISTING, agentConnectionId: null },
      { ...EMPTY, agentConnectionId: "agent_missing" }, { ...connected, connectionId: null },
      { ...EMPTY, connectionId: "gmail_missing" },
      { ...connected, gmail: { ...connected.gmail, grantedScopes: null } },
      { ...connected, gmail: { ...connected.gmail, grantedScopes: [42] } },
      { ...connected, gmail: { ...connected.gmail, status: "unknown" } },
      { ...EXISTING, agentConnection: { ...EXISTING.agentConnection, lastUsedAt: undefined } },
      { ...EXISTING, agentConnection: { ...EXISTING.agentConnection, mcpUrl: "" } },
      { ...EXISTING, agentConnection: { ...EXISTING.agentConnection, label: null } },
    ]) {
      await expect(new OwnerApi(async () => reply(value)).connectState()).rejects.toMatchObject({ status: 200, code: "unconfirmed_response" });
    }
    const unreadable = new OwnerApi(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("unreadable response"); } }));
    await expect(unreadable.connectState()).rejects.toMatchObject({ code: "unconfirmed_response" });
  });

  it("posts only the declared bodies with same-origin JSON credentials", async () => {
    const f = fixture();
    expect(await f.api.createAgentConnection("Stage agent")).toEqual(CREATED);
    expect(await f.api.revokeAgentConnection("agent_new")).toEqual(REVOKED);
    expect(f.posts()).toEqual([
      { path: "/owner/agent-connections/secret-path-new", init: {
        method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_label: "Stage agent" }),
      } },
      { path: "/owner/agent-connections/revoke", init: {
        method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ agent_connection_id: "agent_new" }),
      } },
    ]);
  });

  it("rejects missing or malformed successful create/revoke results as unconfirmed", async () => {
    for (const value of [null, {}, { ...CREATED, url: " " }, { ...CREATED, agent_connection_id: null }, { ...CREATED, receipt_id: "" }]) {
      const f = fixture({ create: () => reply(value) });
      await expect(f.api.createAgentConnection("Agent")).rejects.toMatchObject({ status: 200, code: "unconfirmed_response" });
    }
    for (const value of [null, {}, { ...REVOKED, revoked: false }, { ...REVOKED, receipt_id: "" }]) {
      const f = fixture({ revoke: () => reply(value) });
      await expect(f.api.revokeAgentConnection("agent_new")).rejects.toMatchObject({ status: 200, code: "unconfirmed_response" });
    }
    const badJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("unreadable response"); } });
    const f = fixture({ create: badJson, revoke: badJson });
    await expect(f.api.createAgentConnection("Agent")).rejects.toMatchObject({ code: "unconfirmed_response" });
    await expect(f.api.revokeAgentConnection("agent_new")).rejects.toMatchObject({ code: "unconfirmed_response" });
  });
});

describe("owner agent connection setup", () => {
  it("requires an explicit nonblank label, shows readonly text, and hides it without losing revocation", async () => {
    const f = fixture();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log");
    show(f.api);
    const input = await screen.findByRole("textbox", { name: "Agent label" });
    expect(input).toHaveAttribute("maxlength", "100");
    const create = screen.getByRole("button", { name: "Create agent connection URL" });
    expect(create).toBeDisabled();
    expect(f.posts()).toEqual([]);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(create).toBeDisabled();
    expect(f.posts()).toEqual([]);
    await submitLabel();
    const url = await screen.findByRole("textbox", { name: "Agent connection URL" });
    expect(url).toHaveValue(SECRET_URL);
    expect(url).toHaveAttribute("readonly");
    expect(screen.getAllByRole("link").every(link => !link.getAttribute("href")?.includes("synthetic_test_secret"))).toBe(true);
    expect(screen.getByText(SAY.agentConnectionCreated)).toBeTruthy();
    expect(f.requests.filter(request => request.path === "/owner/connect")).toHaveLength(2);
    expect(JSON.parse((f.posts()[0]!.init as { body: string }).body)).toEqual({ client_label: "Stage agent" });
    expect(storage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(findNeverSay(screen.getByRole("region", { name: "Agent connection setup" }).textContent ?? "")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Hide URL" }));
    expect(secretField()).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke agent connection" })).toBeEnabled();
  });

  it("blocks same-tick repeated creation and revocation, and revokes the returned ID despite stale status", async () => {
    const creation = deferred<Reply>();
    const revocation = deferred<Reply>();
    const f = fixture({ create: () => creation.promise, revoke: () => revocation.promise, connection: EXISTING, staleConnection: true });
    show(f.api);
    const input = await screen.findByRole("textbox", { name: "Agent label" });
    fireEvent.change(input, { target: { value: "Stage agent" } });
    act(() => { fireEvent.submit(input.closest("form")!); fireEvent.submit(input.closest("form")!); });
    expect(f.posts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Creating agent connection…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke agent connection" })).toBeDisabled();
    await act(async () => creation.resolve(reply(CREATED)));
    expect(secretField()).toHaveValue(SECRET_URL);
    fireEvent.click(screen.getByRole("button", { name: "Hide URL" }));
    const revoke = screen.getByRole("button", { name: "Revoke agent connection" });
    act(() => { fireEvent.click(revoke); fireEvent.click(revoke); });
    expect(f.posts()).toHaveLength(2);
    expect(JSON.parse((f.posts()[1]!.init as { body: string }).body)).toEqual({ agent_connection_id: "agent_new" });
    expect(screen.getByRole("button", { name: "Revoking agent connection…" })).toBeDisabled();
    await act(async () => revocation.resolve(reply(REVOKED)));
    expect(screen.getByText(SAY.agentConnectionRevoked)).toBeTruthy();
    expect(secretField()).toBeNull();
    expect(f.requests.filter(request => request.path === "/owner/connect")).toHaveLength(3);
  });

  it("successful revocation removes the visible URL and refreshes connection status", async () => {
    const f = fixture();
    show(f.api);
    await submitLabel();
    await screen.findByRole("textbox", { name: "Agent connection URL" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" }));
    await screen.findByText(SAY.agentConnectionRevoked);
    expect(secretField()).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke agent connection" })).toBeNull();
    expect(f.requests.filter(request => request.path === "/owner/connect")).toHaveLength(3);
  });

  it("stale connection status cannot restore earlier revoked connections after another setup", async () => {
    const f = fixture({ connection: EXISTING, staleConnection: true });
    show(f.api);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke agent connection" }));
    await screen.findByText(SAY.agentConnectionRevoked);
    expect(screen.queryByRole("button", { name: "Revoke agent connection" })).toBeNull();
    await submitLabel();
    await screen.findByRole("textbox", { name: "Agent connection URL" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" }));
    await screen.findByText(SAY.agentConnectionRevoked);
    expect(screen.queryByRole("button", { name: "Revoke agent connection" })).toBeNull();
    expect(f.posts().filter(request => request.path.endsWith("/revoke")).map(request => JSON.parse((request.init as { body: string }).body))).toEqual([
      { agent_connection_id: "agent_old" }, { agent_connection_id: "agent_new" },
    ]);
  });

  it("does not restore a hidden URL after leaving and returning to Connections", async () => {
    const f = fixture();
    const view = show(f.api);
    await submitLabel();
    await screen.findByRole("textbox", { name: "Agent connection URL" });
    view.go("#/jobs");
    await screen.findByText("No jobs yet.");
    view.go("#/connect");
    await screen.findByRole("textbox", { name: "Agent label" });
    expect(secretField()).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it("cannot expose a late creation result after navigation unmounts the setup", async () => {
    const creation = deferred<Reply>();
    const f = fixture({ create: () => creation.promise });
    const view = show(f.api);
    await submitLabel();
    view.go("#/jobs");
    await screen.findByText("No jobs yet.");
    await act(async () => creation.resolve(reply(CREATED)));
    view.go("#/connect");
    await screen.findByRole("textbox", { name: "Agent label" });
    expect(secretField()).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it("shows a disabled fallback as unavailable without a success claim or automatic retry", async () => {
    const f = fixture({ create: () => reply({ error: "not_found" }, 404) });
    show(f.api);
    await submitLabel();
    await screen.findByText(SAY.agentConnectionUnavailable);
    expect(screen.queryByRole("button", { name: "Create agent connection URL" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(secretField()).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it.each(["create", "revoke"])("a 401 during %s follows the existing sign-in return path", async operation => {
    const unauthorized = () => reply({ error: "sign_in" }, 401);
    const f = fixture({ create: unauthorized, revoke: unauthorized, connection: EXISTING });
    const view = show(f.api);
    if (operation === "create") await submitLabel();
    else fireEvent.click(await screen.findByRole("button", { name: "Revoke agent connection" }));
    await act(async () => {});
    expect(view.signIn).toHaveBeenCalledWith("/auth/sign-in?return_to=%2F%23%2Fconnect");
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
    expect(f.posts()).toHaveLength(1);
  });

  it.each(["lost response", "503", "malformed 200"])("creation with %s stays unconfirmed and is never retried automatically", async failure => {
    const create = () => {
      if (failure === "lost response") throw new TypeError("Connection closed before response");
      return failure === "503" ? reply({ error: "server_error" }, 503) : reply({ url: SECRET_URL });
    };
    const f = fixture({ create });
    show(f.api);
    await submitLabel();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SAY.agentConnectionUnconfirmed);
    expect(alert.textContent).not.toContain("Flight Recorder");
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(secretField()).toBeNull();
    expect(alert.textContent).not.toContain(SECRET_URL);
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(f.posts()).toHaveLength(1);
  });

  it.each(["lost response", "503", "malformed 200", "404"])("revocation with %s keeps the URL and makes no revocation claim", async failure => {
    const revoke = () => {
      if (failure === "lost response") throw new TypeError("Connection closed before response");
      if (failure === "404") return reply({ error: "not_found" }, 404);
      return failure === "503" ? reply({ error: "server_error" }, 503) : reply({ revoked: true });
    };
    const f = fixture({ revoke });
    show(f.api);
    await submitLabel();
    await screen.findByRole("textbox", { name: "Agent connection URL" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`Stage agent: ${SAY.agentConnectionRevocationUnconfirmed}`);
    expect(secretField()).toHaveValue(SECRET_URL);
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(f.posts()).toHaveLength(2);
  });

  it.each(["none", "none-then-stale", "same", "different", "malformed"] as const)("refresh after a lost revocation response reconciles a %s connection snapshot", async snapshot => {
    const current: ConnectState = {
      ...EMPTY, agentConnectionId: CREATED.agent_connection_id,
      agentConnection: { mcpUrl: "https://speedwrit.example/mcp", label: "Stage agent", lastUsedAt: null },
    };
    let createdOnServer = false;
    let revocationAttempted = false;
    let refreshesAfterRevocation = 0;
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const api = new OwnerApi(async (path, init) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path === "/owner/connect") {
        if (!createdOnServer) return reply(EMPTY);
        if (!revocationAttempted || snapshot === "same") return reply(current);
        if (snapshot === "none") return reply(EMPTY);
        if (snapshot === "none-then-stale") return reply(++refreshesAfterRevocation === 1 ? EMPTY : current);
        if (snapshot === "malformed") return reply({ ...current, agentConnectionId: undefined });
        return reply({
          ...current, agentConnectionId: "agent_other",
          agentConnection: { ...current.agentConnection!, label: "Other agent" },
        });
      }
      if (path === "/owner/agent-connections/secret-path-new") {
        createdOnServer = true;
        return reply(CREATED);
      }
      if (path === "/owner/agent-connections/revoke") {
        revocationAttempted = true;
        throw new TypeError("Revocation response lost; the request may have committed");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    show(api);
    await submitLabel();
    await screen.findByRole("textbox", { name: "Agent connection URL" });
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`Stage agent: ${SAY.agentConnectionRevocationUnconfirmed}`);

    const beforeRefresh = calls.length;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh Connections" })); });
    expect(calls.slice(beforeRefresh)).toEqual([{ path: "/owner/connect", method: "GET", body: undefined }]);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();

    if (snapshot === "none" || snapshot === "none-then-stale") {
      expect(screen.getByText(SAY.agentConnectionNoneActive)).toBeTruthy();
      expect(secretField()).toBeNull();
      expect(screen.queryByRole("button", { name: "Revoke agent connection" })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Create agent connection URL" })).toBeEnabled();
      if (snapshot === "none-then-stale") {
        const beforeStaleRefresh = calls.length;
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh Connections" })); });
        expect(calls.slice(beforeStaleRefresh)).toEqual([{ path: "/owner/connect", method: "GET", body: undefined }]);
        expect(secretField()).toBeNull();
        expect(screen.queryByRole("button", { name: "Revoke agent connection" })).toBeNull();
        expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
        expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
      }
    } else if (snapshot === "same") {
      expect(screen.getByText(SAY.agentConnectionStillActive)).toBeTruthy();
      expect(secretField()).toHaveValue(SECRET_URL);
      expect(screen.getByRole("button", { name: "Revoke agent connection" })).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
    } else {
      expect(screen.getByRole("alert").textContent).toBe(`Stage agent: ${SAY.agentConnectionRevocationUnconfirmed}`);
      expect(secretField()).toHaveValue(SECRET_URL);
      expect(screen.queryByText(SAY.agentConnectionNoneActive)).toBeNull();
      expect(screen.queryByText(SAY.agentConnectionStillActive)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Hide URL" }));
      expect(screen.getByRole("button", { name: "Create agent connection URL" })).toBeDisabled();
      // An unresolved target must not silently become the different connection from the snapshot.
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" })); });
      const revokes = calls.filter(call => call.path.endsWith("/revoke"));
      expect(revokes).toHaveLength(2);
      expect(revokes.map(call => JSON.parse(call.body!))).toEqual([
        { agent_connection_id: "agent_new" }, { agent_connection_id: "agent_new" },
      ]);
    }
  });

  it("manual refresh finds a connection after a lost creation response without creating or revoking anything", async () => {
    let created = false;
    const calls: Array<{ path: string; method?: string }> = [];
    const api = new OwnerApi(async (path, init) => {
      calls.push({ path, method: init?.method });
      if (path === "/owner/connect") return reply(created ? {
        ...EXISTING, agentConnectionId: CREATED.agent_connection_id,
        agentConnection: { ...EXISTING.agentConnection!, label: "Stage agent" },
      } : EMPTY);
      if (path === "/owner/agent-connections/secret-path-new") {
        created = true;
        throw new TypeError("The create response was lost after the server committed");
      }
      if (path === "/owner/agent-connections/revoke") return reply(REVOKED);
      throw new Error(`Unexpected request: ${path}`);
    });
    show(api);
    await submitLabel();
    expect((await screen.findByRole("alert")).textContent).toBe(SAY.agentConnectionUnconfirmed);
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh Connections" }));
    await screen.findByRole("button", { name: "Revoke agent connection" });
    expect(calls.slice(before)).toEqual([{ path: "/owner/connect", method: "GET" }]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
    expect(secretField()).toBeNull();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    // Revocation remains a separate, explicit owner action.
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent connection" }));
    await screen.findByText(SAY.agentConnectionRevoked);
    expect(calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
      "/owner/agent-connections/secret-path-new", "/owner/agent-connections/revoke",
    ]);
  });

  it.each([
    ["empty object", {}],
    ["missing agent ID", { ...EXISTING, agentConnectionId: undefined }],
    ["missing stopped state", { ...EXISTING, stopped: undefined }],
  ])("a malformed refresh (%s) after lost creation retains uncertainty and the last confirmed connection", async (_name, malformed) => {
    let reads = 0;
    const calls: Array<{ path: string; method?: string }> = [];
    const api = new OwnerApi(async (path, init) => {
      calls.push({ path, method: init?.method });
      if (path === "/owner/connect") return reply(++reads === 1 ? EXISTING : malformed);
      if (path === "/owner/agent-connections/secret-path-new") throw new TypeError("Creation response lost");
      throw new Error(`Unexpected request: ${path}`);
    });
    show(api);
    await submitLabel();
    expect((await screen.findByRole("alert")).textContent).toBe(SAY.agentConnectionUnconfirmed);
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh Connections" }));
    expect((await screen.findByRole("alert")).textContent).toBe(SAY.agentConnectionUnconfirmed);
    expect(calls.slice(before)).toEqual([{ path: "/owner/connect", method: "GET" }]);
    expect(screen.getByRole("button", { name: "Revoke agent connection" })).toBeEnabled();
    expect(screen.queryByText("No agent connected")).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
    expect(secretField()).toBeNull();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it("an unsuccessful manual refresh stays unconfirmed and never sends a POST", async () => {
    let reads = 0;
    const fetch = vi.fn(async (_path: string, _init?: { method?: string }) => ++reads === 1 ? reply(EMPTY) : reply({ error: "server_error" }, 503));
    show(new OwnerApi(fetch));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh Connections" }));
    expect((await screen.findByRole("alert")).textContent).toBe(SAY.agentConnectionUnconfirmed);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
    expect(screen.queryByText(SAY.agentConnectionCreated)).toBeNull();
    expect(screen.queryByText(SAY.agentConnectionRevoked)).toBeNull();
  });
});
