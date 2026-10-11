import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CHATGPT_REDIRECT, isAllowedRedirectUri, MCP_SCOPE } from "@writ/job-send";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findNeverSay } from "../src/lib/copy";
import { CHATGPT_CALLBACK, CONSENT_SCOPE, Consent, describeRedirect, type ConsentRequest } from "../src/screens/Consent";

afterEach(cleanup);

const REQUEST: ConsentRequest = {
  clientId: "cli_123",
  clientName: "ChatGPT",
  redirectUri: "https://chatgpt.com/connector/oauth/conn_AbC-12_z",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  state: "st_1",
  scope: "jobs.act",
};

describe("Consent", () => {
  it("shows the declared name, the owner, and where the code goes; Allow posts exactly the request shown", () => {
    const onAllow = vi.fn();
    render(<Consent request={REQUEST} ownerEmail="owner@test.example" onAllow={onAllow} onDeny={vi.fn()} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("ChatGPT (declared) asks to act for owner@test.example");
    expect(text).toContain("connection conn_AbC-12_z");
    expect(text).toContain(REQUEST.redirectUri);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onAllow).toHaveBeenCalledWith(REQUEST);
  });

  it("Deny posts the request it refuses", () => {
    const onDeny = vi.fn();
    render(<Consent request={REQUEST} ownerEmail="owner@test.example" onAllow={vi.fn()} onDeny={onDeny} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledWith(REQUEST);
  });

  it("a familiar name on an address that is not ChatGPT's says so beside the name", () => {
    const phish = { ...REQUEST, clientName: "ChatGPT (official)", redirectUri: "https://chatgpt.com.evil.example/connector/oauth/x" };
    render(<Consent request={phish} ownerEmail="owner@test.example" onAllow={vi.fn()} onDeny={vi.fn()} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("ChatGPT (official) (declared)");
    expect(text).toContain("Another address");
    expect(text).not.toContain("connection x");
  });

  it("the declared name and the redirect are direction-isolated, so an override inside cannot reorder '(declared)'", () => {
    const RLO = String.fromCharCode(0x202e);
    render(<Consent request={{ ...REQUEST, clientName: `Chat${RLO}deralced` }} ownerEmail="owner@test.example" onAllow={vi.fn()} onDeny={vi.fn()} />);
    const isolated = [...document.querySelectorAll("bdi")].map((node) => node.textContent);
    expect(isolated).toEqual([`Chat${RLO}deralced`, REQUEST.redirectUri]);
    // "(declared)" sits outside every <bdi>.
    for (const node of document.querySelectorAll("bdi")) expect(node.textContent).not.toContain("(declared)");
    expect(document.body.textContent).toContain("(declared) asks to act for owner@test.example");
  });

  it("any scope other than jobs.act offers no Allow, only Deny", () => {
    for (const scope of ["jobs.act openid", "openid", "", "JOBS.ACT"]) {
      render(<Consent request={{ ...REQUEST, scope }} ownerEmail="owner@test.example" onAllow={vi.fn()} onDeny={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe("This request asks for something WRIT does not grant.");
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
      cleanup();
    }
  });

  it("says nothing the Say / Never-say table forbids", () => {
    render(<Consent request={REQUEST} ownerEmail="owner@test.example" onAllow={vi.fn()} onDeny={vi.fn()} />);
    expect(findNeverSay(document.body.textContent ?? "")).toEqual([]);
  });
});

describe("describeRedirect agrees with the server's redirect allow-list", () => {
  it("the UI's callback and scope are the server's", () => {
    expect(CHATGPT_CALLBACK).toBe(CHATGPT_REDIRECT);
    expect(CONSENT_SCOPE).toBe(MCP_SCOPE);
  });

  it("every address it calls ChatGPT, the server allows; lookalikes are 'Another address'", () => {
    const cases = [
      CHATGPT_REDIRECT,
      "https://chatgpt.com/connector/oauth/conn_1",
      "https://chatgpt.com/connector/oauth/" + "a".repeat(128),
      "https://chatgpt.com/connector/oauth/" + "a".repeat(129),
      "https://chatgpt.com/connector/oauth/conn_1/extra",
      "https://chatgpt.com.evil.example/connector/oauth/conn_1",
      "http://chatgpt.com/connector/oauth/conn_1",
      "https://CHATGPT.com/connector/oauth/conn_1",
      "https://chatgpt.com/connector/oauth/conn_1?x=1",
    ];
    for (const uri of cases) {
      const saysChatGpt = describeRedirect(uri).where === "ChatGPT";
      expect(saysChatGpt, uri).toBe(isAllowedRedirectUri(uri));
    }
  });
});
