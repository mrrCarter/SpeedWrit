import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findNeverSay } from "../src/lib/copy";
import { renderConsentHtml } from "../src/render/consentHtml";
import type { ConsentView } from "../src/screens/Consent";

const VIEW: ConsentView = {
  requestId: "req_9f2c1e0b7a6d5c4b",
  request: {
    clientId: "cli_123",
    clientName: "ChatGPT",
    redirectUri: "https://chatgpt.com/connector/oauth/conn_AbC-12_z",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    state: "st_1",
    scope: "jobs.act",
  },
  ownerEmail: "owner@test.example",
};

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
/** Every control the form would submit: [name, value, type]. */
const namedControls = (doc: Document) =>
  [...doc.querySelectorAll<HTMLInputElement | HTMLButtonElement>("form [name]")].map((el) => [el.name, el.value, el.type]);

describe("renderConsentHtml", () => {
  it("is a whole page: doctype, charset, title, one form posting to /oauth/authorize", () => {
    const html = renderConsentHtml(VIEW);
    expect(html.startsWith("<!doctype html><html lang=\"en\">")).toBe(true);
    const doc = parse(html);
    expect(doc.querySelector("meta[charset]")?.getAttribute("charset")).toBe("utf-8");
    expect(doc.title).toBe("Connect an agent to SpeedWrit");
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(forms[0]?.getAttribute("method")).toBe("post");
    expect(forms[0]?.getAttribute("action")).toBe("/oauth/authorize");
  });

  it("posts only request_id and the decision: no client, redirect, state or challenge fields", () => {
    const doc = parse(renderConsentHtml(VIEW));
    expect(namedControls(doc)).toEqual([
      ["request_id", VIEW.requestId, "hidden"],
      ["decision", "allow", "submit"],
      ["decision", "deny", "submit"],
    ]);
    // A button can override the form's target or method on its own (machine, #514): none may.
    expect(doc.querySelectorAll("[formaction], [formmethod], [formenctype], [formtarget], [form]")).toHaveLength(0);
  });

  it("any scope other than jobs.act renders no allow button, only deny", () => {
    const doc = parse(renderConsentHtml({ ...VIEW, request: { ...VIEW.request, scope: "jobs.act openid" } }));
    expect(namedControls(doc)).toEqual([
      ["request_id", VIEW.requestId, "hidden"],
      ["decision", "deny", "submit"],
    ]);
    expect(doc.querySelector("[role=alert]")?.textContent).toBe("This request asks for something SpeedWrit does not grant.");
  });

  it("shows what Consent shows: the declared name, the owner, ChatGPT's connection id, the exact address, isolated", () => {
    const doc = parse(renderConsentHtml(VIEW));
    const text = doc.body.textContent ?? "";
    expect(text).toContain("ChatGPT (declared) asks to act for owner@test.example");
    expect(text).toContain("connection conn_AbC-12_z");
    expect([...doc.querySelectorAll("bdi")].map((node) => node.textContent)).toEqual(["ChatGPT", VIEW.request.redirectUri]);
    // The view carries the whole request, but the page posts none of it: no client id, state or challenge in the markup.
    for (const secret of [VIEW.request.clientId, VIEW.request.codeChallenge, "st_1"]) expect(renderConsentHtml(VIEW)).not.toContain(secret);
    expect(findNeverSay(text)).toEqual([]);
  });

  it("escapes every value, and carries no script and no inline style, so a strict CSP holds", () => {
    const hostile = {
      ...VIEW,
      request: { ...VIEW.request, clientName: '<script>alert(1)</script><img src=x onerror=alert(2)>' },
      requestId: '"><input name="client_id" value="evil',
    };
    const html = renderConsentHtml(hostile);
    const doc = parse(html);
    expect(doc.querySelectorAll("script, style, img, [style], [onerror], [onclick]")).toHaveLength(0);
    // Nothing loads from anywhere: no link, frame, object or base, and no src or href at all (machine, #514).
    expect(parse(renderConsentHtml(VIEW)).querySelectorAll("[src], [href], link, iframe, object, embed, base")).toHaveLength(0);
    expect(doc.querySelector("bdi")?.textContent).toBe(hostile.request.clientName);
    expect(namedControls(doc)).toEqual([
      ["request_id", hostile.requestId, "hidden"],
      ["decision", "allow", "submit"],
      ["decision", "deny", "submit"],
    ]);
  });
});

/** The external modules reachable from a source file, following relative imports (.ts, .tsx). */
function externalImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const base = resolve(dirname(file), specifier);
      const found = [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find((candidate) => {
        try {
          readFileSync(candidate);
          return true;
        } catch {
          return false;
        }
      });
      if (!found) throw new Error(`unresolved ${specifier} from ${file}`);
      visit(found);
    }
  };
  visit(entry);
  return external;
}

describe("the consent-html entry", () => {
  it("the browser index's whole import graph never reaches react-dom/server (machine, #514)", () => {
    const index = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
    expect([...externalImports(index)].sort()).toEqual(["@writ/job-send/contract", "@writ/job-send/verify", "react"]);
  });

  it("resolves by package name to the renderer, and the browser index does not carry it", async () => {
    const entry = await import("@writ/job-send-ui/consent-html");
    expect(entry.renderConsentHtml).toBe(renderConsentHtml);
    const index = await import("../src/index");
    expect("renderConsentHtml" in index).toBe(false);
    expect(typeof index.ConsentForm).toBe("function");
  });
});
