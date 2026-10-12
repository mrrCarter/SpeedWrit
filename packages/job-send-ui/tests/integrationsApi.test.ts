import { describe, expect, it } from "vitest";
import { OwnerApi } from "../src/app/api";

const metadata = { jev: { configured: true, model: "jev-1.13.0" }, dial: { configured: true, live: true, enabled: false, status: "disabled", pending: 0, last_result: null } };
describe("owner integration API", () => {
  it("only explicit preference/test methods POST, with same-origin JSON and minimal bodies", async () => {
    const calls: { path: string; init: unknown }[] = [];
    const api = new OwnerApi(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => path.endsWith("integrations") ? metadata : path.endsWith("preferences") ? { enabled: true } : { queued: true } };
    });
    await expect(api.integrations()).resolves.toEqual(metadata);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: "/owner/integrations", init: { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } } });
    await expect(api.setAlertsEnabled(true)).resolves.toEqual({ enabled: true });
    await expect(api.testAlert()).resolves.toEqual({ queued: true });
    expect(calls.slice(1)).toEqual([
      { path: "/owner/alerts/preferences", init: { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: '{"enabled":true}' } },
      { path: "/owner/alerts/test", init: { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" }, body: '{}' } },
    ]);
  });
  it("malformed successes remain unconfirmed and failed writes never retry", async () => {
    for (const method of ["integrations", "testAlert"] as const) {
      let count = 0;
      const api = new OwnerApi(async () => { count++; return { ok: true, status: 200, json: async () => ({}) }; });
      await expect(api[method]()).rejects.toMatchObject({ code: "unconfirmed_response" });
      expect(count).toBe(1);
    }
    const malformed = new OwnerApi(async () => ({ ok: true, status: 200, json: async () => ({ enabled: "false" }) }));
    await expect(malformed.setAlertsEnabled(false)).rejects.toMatchObject({ code: "unconfirmed_response" });
    let count = 0;
    const lost = new OwnerApi(async () => { count++; throw new Error("lost response"); });
    await expect(lost.testAlert()).rejects.toThrow("lost response");
    expect(count).toBe(1);
  });
  it("expired sessions retain the common sign-in signal", async () => {
    const api = new OwnerApi(async () => ({ ok: false, status: 401, json: async () => ({ error: "sign_in" }) }));
    await expect(api.integrations()).rejects.toMatchObject({ status: 401, code: "sign_in" });
  });
});
