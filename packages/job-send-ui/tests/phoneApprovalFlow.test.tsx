import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerApi } from "../src/app/api";
import { OwnerApp } from "../src/app/OwnerApp";

afterEach(cleanup);
function fixture() {
  let enabled = false;
  let expireVoice = false;
  const calls: { path: string; method?: string; body?: string }[] = [];
  const api = new OwnerApi(async (path, init) => {
    calls.push({ path, method: init?.method, ...(init?.body ? { body: init.body } : {}) });
    let data: unknown;
    if (path === "/owner/connect") data = { gmail: null, agentConnection: null, stopped: true, connectionId: null, agentConnectionId: null };
    else if (path === "/owner/integrations") data = { jev: { configured: false, model: "jev-1.13.0" }, dial: { configured: true, live: true, enabled: true, status: "ready", pending: 0, last_result: null } };
    else if (path === "/owner/voice/preferences") {
      if (expireVoice) return { ok: false, status: 401, json: async () => ({ error: "sign_in" }) };
      if (init?.method === "POST") enabled = JSON.parse(init.body!).enabled;
      data = { configured: true, eligible_owner: true, enabled, disclosure_version: "voice-approval-v1" };
    } else throw new Error("unexpected fixture endpoint");
    return { ok: true, status: 200, json: async () => data };
  });
  const signIn = vi.fn();
  render(<OwnerApp api={api} pinned={{ keyId: "0123456789abcdef", publicKeyRaw: new Uint8Array(32) }} contacts={[]}
    jobDefaults={{ templateId: "fixture", purpose: "fixture", autoSend: false }} connectGmailHref="/auth/gmail/connect"
    route="#/connect" navigate={vi.fn()} signIn={signIn} />);
  return { calls, signIn, expire: () => { expireVoice = true; } };
}

describe("real Connections phone preference wiring", () => {
  it("mounts through GET only, keeps generic opt-in separate and writes exactly one explicit versioned consent", async () => {
    const h = fixture();
    const control = await screen.findByRole("checkbox", { name: "Enable exact-draft phone approvals" });
    expect(control).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Enable phone alerts" })).toBeChecked();
    expect(h.calls.every(call => call.method === "GET")).toBe(true);
    fireEvent.click(control);
    await waitFor(() => expect(control).toBeChecked());
    expect(h.calls.filter(call => call.method === "POST")).toEqual([{ path: "/owner/voice/preferences", method: "POST", body: '{"enabled":true,"disclosure_version":"voice-approval-v1"}' }]);
    expect(h.calls.some(call => /\/calls|\/test|\/approve/.test(call.path))).toBe(false);
  });
  it("returns an expired phone preference session to the real Connections path without retrying a write", async () => {
    const h = fixture();
    const control = await screen.findByRole("checkbox", { name: "Enable exact-draft phone approvals" });
    h.expire(); fireEvent.click(control);
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(1));
    expect(new URL(h.signIn.mock.calls[0]![0], "https://fixture.test").searchParams.get("return_to")).toBe("/owner-app/#/connect");
    expect(control).not.toBeChecked(); expect(control).toBeDisabled();
    expect(h.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
});
