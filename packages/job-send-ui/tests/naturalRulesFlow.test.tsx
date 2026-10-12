import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Job } from "@writ/job-send/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerApi } from "../src/app/api";
import { OwnerApp } from "../src/app/OwnerApp";

afterEach(cleanup);
const SHA = "a".repeat(64);
const authority: Job = {
  v: 1, job_id: "job_rules", policy_version: 1, owner: "own_rules", connection: "con_rules", agent_connection: "ac_rules",
  provider: "gmail", sender: "owner@example.test", recipient: "dana@example.test", purpose: "Send the recap.",
  template: { id: "tpl_recap", sha256: SHA }, field_rules: { recap: { max: 600, required: true, free_text: true } },
  max_sends: 2, expires_at: "2026-10-12T06:59:00.000Z", auto_send: true, allow_custom_with_approval: true, ai_review: "all_free_text",
};
function setup() {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const api = new OwnerApi(async (path, init) => {
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(init.body!) as Record<string, unknown> });
    const body = path === "/owner/connect" ? {
      gmail: { address: "owner@example.test", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"] },
      agentConnection: { mcpUrl: "https://example.test/mcp", label: "ChatGPT", lastUsedAt: null },
      stopped: false, connectionId: "con_rules", agentConnectionId: "ac_rules",
    } : path === "/owner/jobs" ? { job: authority, authoritySha256: SHA }
      : path === "/owner/jobs/confirm" ? { policyVersion: 1, receipt_id: "rcp_rules" } : {};
    return { ok: true, status: 200, json: async () => body };
  });
  render(<OwnerApp api={api} pinned={{ keyId: "0123456789abcdef", publicKeyRaw: new Uint8Array(32) }}
    jobDefaults={{ templateId: "tpl_recap", purpose: authority.purpose, autoSend: true }}
    contacts={[{ name: "Dana", email: "dana@example.test" }]} connectGmailHref="/connect/gmail"
    timeZone="America/Los_Angeles" now={() => new Date("2026-10-11T16:00:00Z")} route="#/new" navigate={vi.fn()} signIn={vi.fn()} />);
  return posts;
}

describe("natural rules through the real owner API client", () => {
  it("shows a compact whole count and submits that same count for server review", async () => {
    const posts = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "3sends max" } });
    expect(within(screen.getByRole("list", { name: "Resolved custom rules" })).getByText(/fourth send/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review this job" }));
    await screen.findByRole("button", { name: "Confirm job" });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: "/owner/jobs", body: { max_sends: 3 } });
    expect(screen.getByText("More than 2 sends")).toBeInTheDocument();
  });

  it.each(["0.5emails", "-3messages", "1,000emails"].flatMap((count) =>
    ["avoid rude tone", "no links", "until tonight"].map((rule) => `${count}, ${rule}`),
  ))("never submits the structured default after dropping compact count intent in %j", async (value) => {
    const posts = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Custom rules in your words" }), { target: { value } });
    expect(screen.getByRole("button", { name: "Review this job" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(screen.queryByRole("button", { name: "Confirm job" })).toBeNull();
    expect(posts).toEqual([]);
  });

  it.each(["max2emails", "no more than2emails", "emailsmax2"].flatMap((count) =>
    ["avoid rude tone", "no links", "until tonight"].map((rule) => `${count}, ${rule}`),
  ))("does not submit default authority after ignoring an attached count qualifier in %j", async (value) => {
    const posts = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Custom rules in your words" }), { target: { value } });
    expect(screen.getByRole("button", { name: "Review this job" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(screen.queryByRole("button", { name: "Confirm job" })).toBeNull();
    expect(posts).toEqual([]);
  });

  it("compiles typed rules to the draft POST, then confirms only the server-returned authority", async () => {
    const posts = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "don't sound rude\nno links" } });
    expect(posts).toEqual([]);
    expect(screen.queryByRole("button", { name: "Confirm job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review this job" }));
    const confirm = await screen.findByRole("button", { name: "Confirm job" });
    expect(posts).toEqual([{ path: "/owner/jobs", body: {
      connection_id: "con_rules", agent_connection_id: "ac_rules", recipient: "dana@example.test", purpose: "Send the recap.",
      template_id: "tpl_recap", max_sends: 3, expires_at: "2026-10-12T06:59:00.000Z", auto_send: true,
      allow_custom_with_approval: true, ai_review: "all_free_text",
    } }]);
    // Returned authority deliberately differs from requested count. The review must show the server's two.
    expect(screen.getByText("More than 2 sends")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Ask me" })).getByText(/AI-review flag, or AI review being unavailable/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ path: "/owner/jobs/confirm", body: { job_id: "job_rules", authority_sha256: SHA } });
  });

  it("makes no draft or confirmation request for unsupported or ambiguous wording", async () => {
    const posts = setup();
    const input = await screen.findByRole("textbox", { name: "Custom rules in your words" });
    for (const value of ["make it special", "two sends max until tonight"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("button", { name: "Review this job" })).toBeDisabled();
      fireEvent.submit(screen.getByRole("form", { name: "New job" }));
      expect(screen.queryByRole("button", { name: "Confirm job" })).toBeNull();
      expect(posts).toEqual([]);
    }
  });
});
