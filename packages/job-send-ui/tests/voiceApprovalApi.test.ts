import { describe, expect, it } from "vitest";
import { OwnerApi } from "../src/app/api";

const preference = (enabled = false) => ({ configured: true, eligible_owner: true, enabled, disclosure_version: "voice-approval-v1" });
describe("owner phone approval API", () => {
  it("reads without writing and sends only the versioned explicit enable or minimal disable contract", async () => {
    const calls: { path: string; init: unknown }[] = [];
    const api = new OwnerApi(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => preference(init?.body ? JSON.parse(init.body).enabled : false) };
    });
    await expect(api.voiceApprovalPreference()).resolves.toEqual(preference());
    expect(calls).toEqual([{ path: "/owner/voice/preferences", init: { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } } }]);
    await expect(api.setVoiceApprovalsEnabled(true)).resolves.toEqual(preference(true));
    await expect(api.setVoiceApprovalsEnabled(false)).resolves.toEqual(preference());
    expect(calls.slice(1)).toEqual([true, false].map(enabled => ({ path: "/owner/voice/preferences", init: {
      method: "POST", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(enabled ? { enabled: true, disclosure_version: "voice-approval-v1" } : { enabled: false }),
    } })));
  });
  it("never retries a lost write and treats incomplete success as unconfirmed", async () => {
    let count = 0;
    const lost = new OwnerApi(async () => { count++; throw new Error("lost"); });
    await expect(lost.setVoiceApprovalsEnabled(true)).rejects.toThrow("lost"); expect(count).toBe(1);
    const malformed = new OwnerApi(async () => ({ ok: true, status: 200, json: async () => ({ enabled: true }) }));
    await expect(malformed.voiceApprovalPreference()).rejects.toMatchObject({ code: "unconfirmed_response" });
    await expect(malformed.setVoiceApprovalsEnabled(false)).rejects.toMatchObject({ code: "unconfirmed_response" });
  });
  it("retains the shared 401 sign-in signal", async () => {
    const api = new OwnerApi(async () => ({ ok: false, status: 401, json: async () => ({ error: "private detail" }) }));
    await expect(api.voiceApprovalPreference()).rejects.toMatchObject({ status: 401, code: "sign_in" });
    await expect(api.setVoiceApprovalsEnabled(false)).rejects.toMatchObject({ status: 401, code: "sign_in" });
  });
});
