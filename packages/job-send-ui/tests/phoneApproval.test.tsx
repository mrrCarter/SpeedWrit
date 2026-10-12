import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneApprovalSettings, type PhoneApprovalSettingsProps } from "../src/screens/PhoneApprovalSettings";
import { IntegrationsCard } from "../src/screens/IntegrationsCard";
import { parseVoiceApprovalPreference, type VoiceApprovalPreference } from "../src/lib/voiceApproval";

afterEach(cleanup);
const snapshot = (enabled = false): VoiceApprovalPreference => ({ configured: true, eligible_owner: true, enabled, disclosure_version: "voice-approval-v1" });
const switchControl = () => screen.getByRole("checkbox", { name: "Enable exact-draft phone approvals" });
const refresh = () => screen.getByRole("button", { name: "Refresh phone approval settings" });
function setup(initial = snapshot(), overrides: Partial<PhoneApprovalSettingsProps> = {}) {
  let current = initial;
  const load = vi.fn(async () => current);
  const setEnabled = vi.fn(async (enabled: boolean) => { current = snapshot(enabled); return current; });
  const props = { load, setEnabled, ...overrides };
  return { ...render(<PhoneApprovalSettings {...props} />), ...props, setSnapshot: (next: VoiceApprovalPreference) => { current = next; } };
}

describe("separate exact-draft phone authority", () => {
  it("loads off and refreshes without opting in or placing a call; disclosure precedes the switch", async () => {
    const h = setup();
    await screen.findByRole("checkbox");
    expect(switchControl()).not.toBeChecked();
    expect(screen.getByText(/whoever controls your configured phone/)).toHaveTextContent("one exact pending draft");
    expect(screen.getByText(/This does not verify a speaker's identity/)).toBeInTheDocument();
    expect(screen.getByText(/Dial receives the exact recipient/)).toHaveTextContent("processes and transcribes");
    expect(screen.getByText(/Automatic calls apply only to future held draft versions/)).toHaveTextContent("STOP or turning this off");
    expect(screen.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
    expect(switchControl()).toHaveAccessibleDescription(/whoever controls your configured phone.*does not verify a speaker.*processes and transcribes.*STOP or turning this off.*cannot undo a decision already applied/s);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Refresh phone approval settings"]);
    fireEvent.click(refresh());
    await waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("changes only after an explicit owner action receives a matching full server confirmation", async () => {
    const h = setup(); await screen.findByRole("checkbox");
    fireEvent.click(switchControl());
    await waitFor(() => expect(switchControl()).toBeChecked());
    expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.load).toHaveBeenCalledTimes(1);
    fireEvent.click(switchControl());
    await waitFor(() => expect(switchControl()).not.toBeChecked());
    expect(h.setEnabled).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("Outstanding phone approval authority is invalidated");
  });

  it("keeps a pending Off at the last confirmed value and blocks duplicate changes, including on rerender", async () => {
    let resolve!: (value: VoiceApprovalPreference) => void;
    const setEnabled = vi.fn(() => new Promise<VoiceApprovalPreference>(done => { resolve = done; }));
    const h = setup(snapshot(true), { setEnabled }); await screen.findByRole("checkbox");
    fireEvent.click(switchControl());
    h.rerender(<PhoneApprovalSettings load={h.load} setEnabled={setEnabled} onSignIn={vi.fn()} />);
    expect(switchControl()).toBeChecked(); expect(switchControl()).toBeDisabled(); expect(refresh()).toBeDisabled();
    fireEvent.click(switchControl());
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => resolve(snapshot(false)));
    await waitFor(() => expect(switchControl()).not.toBeChecked());
  });

  it.each(["lost", "malformed", "mismatch"])("freezes an uncertain %s write until explicit read-only refresh, without retries or raw errors", async failure => {
    const setEnabled = vi.fn(async () => {
      if (failure === "lost") throw new Error("private provider token details");
      return failure === "malformed" ? { enabled: false } as VoiceApprovalPreference : snapshot(true);
    });
    const h = setup(snapshot(true), { setEnabled }); await screen.findByRole("checkbox");
    fireEvent.click(switchControl());
    expect(await screen.findByRole("alert")).toHaveTextContent("status is unconfirmed");
    expect(switchControl()).toBeChecked(); expect(switchControl()).toBeDisabled();
    expect(setEnabled).toHaveBeenCalledTimes(1); expect(h.load).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private provider token details");
    h.setSnapshot(snapshot(false)); fireEvent.click(refresh());
    await waitFor(() => expect(switchControl()).toBeEnabled());
    expect(switchControl()).not.toBeChecked(); expect(setEnabled).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...snapshot(), configured: false },
    { ...snapshot(), configured: false, eligible_owner: false },
  ])("offers no enrollment or authority to an unavailable owner configuration", async value => {
    const h = setup(value); await act(async () => {});
    expect(screen.queryByRole("checkbox")).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("does not reveal controls or arbitrary server fields on an initial read failure", async () => {
    const h = setup(snapshot(), { load: vi.fn(async () => ({ configured: "secret value" } as unknown as VoiceApprovalPreference)) });
    await act(async () => {});
    expect(screen.queryByRole("checkbox")).toBeNull(); expect(document.body.textContent).not.toContain("secret value");
    expect(h.load).toHaveBeenCalledTimes(1); expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("locks previously confirmed authority if refresh fails, and hides it when eligibility is revoked", async () => {
    const load = vi.fn().mockResolvedValueOnce(snapshot(true)).mockRejectedValueOnce(new Error("read lost"))
      .mockResolvedValueOnce({ ...snapshot(), configured: false, eligible_owner: false });
    const h = setup(snapshot(), { load }); await screen.findByRole("checkbox");
    fireEvent.click(refresh()); await screen.findByRole("alert");
    expect(switchControl()).toBeChecked(); expect(switchControl()).toBeDisabled();
    fireEvent.click(refresh()); await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("delegates expired sessions to sign-in and ignores a delayed result after unmount", async () => {
    const onSignIn = vi.fn();
    const h = setup(snapshot(), { load: vi.fn(async () => { throw { status: 401 }; }), onSignIn });
    await waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1)); expect(h.load).toHaveBeenCalledTimes(1); h.unmount();
    let resolve!: (value: VoiceApprovalPreference) => void;
    const delayed = setup(snapshot(), { load: () => new Promise(done => { resolve = done; }) });
    delayed.unmount(); await act(async () => resolve(snapshot(true)));
    expect(screen.queryByRole("checkbox")).toBeNull(); expect(delayed.setEnabled).not.toHaveBeenCalled();
  });

  it("does not inherit generic alert consent or change the generic preference", async () => {
    const genericWrite = vi.fn(async () => ({ enabled: false }));
    const genericTest = vi.fn(async () => ({ queued: true as const }));
    render(<IntegrationsCard load={async () => ({ jev: { configured: true, model: "jev-1.13.0" }, dial: { configured: true, live: true, enabled: true, status: "ready", pending: 0, last_result: null } })} setEnabled={genericWrite} test={genericTest} />);
    const h = setup(); await screen.findByRole("checkbox", { name: "Enable exact-draft phone approvals" });
    expect(screen.getByRole("checkbox", { name: "Enable phone alerts" })).toBeChecked(); expect(switchControl()).not.toBeChecked();
    fireEvent.click(switchControl()); await waitFor(() => expect(switchControl()).toBeChecked());
    expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(genericWrite).not.toHaveBeenCalled(); expect(genericTest).not.toHaveBeenCalled();
  });
});

describe("phone authority response validation", () => {
  it("strips unknown data and rejects unfamiliar or contradictory authority without exposing it", () => {
    expect(parseVoiceApprovalPreference({ ...snapshot(), phone: "private", token: "private" })).toEqual(snapshot());
    for (const delta of [{ configured: "yes" }, { eligible_owner: 1 }, { enabled: "false" }, { disclosure_version: "future" }, { eligible_owner: false }, { configured: false, enabled: true }]) {
      expect(() => parseVoiceApprovalPreference({ ...snapshot(), ...delta })).toThrow("unconfirmed_voice_preference");
    }
    for (const value of [null, [], 1]) expect(() => parseVoiceApprovalPreference(value)).toThrow("unconfirmed_voice_preference");
  });
});
