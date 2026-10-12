import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIntegrationMetadata, type IntegrationMetadata } from "../src/lib/integrations";
import { IntegrationsCard, type IntegrationsCardProps } from "../src/screens/IntegrationsCard";

afterEach(cleanup);

const snapshot = (enabled = false): IntegrationMetadata => ({
  jev: { configured: true, model: "jev-1.13.0" },
  dial: { configured: true, live: true, enabled, status: enabled ? "ready" : "disabled", pending: 0, last_result: null },
});
function setup(initial = snapshot(), overrides: Partial<IntegrationsCardProps> = {}) {
  let current = initial;
  const load = vi.fn(async () => current);
  const setEnabled = vi.fn(async (enabled: boolean) => {
    current = { ...current, dial: { ...current.dial, enabled, status: enabled ? "ready" : "disabled" } };
    return { enabled };
  });
  const test = vi.fn(async () => ({ queued: true as const }));
  const props = { load, setEnabled, test, ...overrides };
  const rendered = render(<IntegrationsCard {...props} />);
  return { ...rendered, ...props, setSnapshot: (next: IntegrationMetadata) => { current = next; } };
}
const checkbox = () => screen.getByRole("checkbox", { name: "Enable phone alerts" });
const testButton = () => screen.getByRole("button", { name: "Send test call" });
const refresh = () => screen.getByRole("button", { name: "Refresh integrations" });

describe("IntegrationsCard", () => {
  it("mounts and refreshes through GET-only functions; configuration never claims a review ran", async () => {
    const h = setup();
    expect(screen.getByRole("status")).toHaveTextContent("Loading integration status");
    await screen.findByRole("checkbox");
    expect(checkbox()).not.toBeChecked();
    expect(testButton()).toBeDisabled();
    expect(screen.getByText(/Configuration does not confirm that a review ran or succeeded/)).toBeInTheDocument();
    expect(screen.getByText("jev-1.13.0")).toBeInTheDocument();
    fireEvent.click(refresh());
    await waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
    expect(h.setEnabled).not.toHaveBeenCalled();
    expect(h.test).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in and a separate test click, with no automatic test on enable", async () => {
    const h = setup();
    await screen.findByRole("checkbox");
    fireEvent.click(checkbox());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await waitFor(() => expect(testButton()).toBeEnabled());
    expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.test).not.toHaveBeenCalled();
    fireEvent.click(testButton());
    await screen.findByText(/Test request accepted for queuing/);
    expect(h.test).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(3);
  });

  it("keeps Off pending until confirmed and prevents duplicate writes while the response is pending", async () => {
    let resolve!: (value: { enabled: boolean }) => void;
    const setEnabled = vi.fn(() => new Promise<{ enabled: boolean }>(done => { resolve = done; }));
    const h = setup(snapshot(true), { setEnabled });
    await screen.findByRole("checkbox");
    fireEvent.click(checkbox());
    expect(checkbox()).toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(testButton()).toBeDisabled();
    expect(refresh()).toBeDisabled();
    fireEvent.click(checkbox());
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    h.setSnapshot(snapshot(false));
    await act(async () => resolve({ enabled: false }));
    await waitFor(() => expect(checkbox()).not.toBeChecked());
    expect(await screen.findByText("Phone alerts are off.")).toBeInTheDocument();
  });

  it("keeps an uncertain Off at the last confirmed preference and requires GET refresh before another action", async () => {
    const initial = snapshot(true);
    initial.dial.last_result = { at: "2026-10-11T23:00:00.000Z", status: "accepted" };
    const setEnabled = vi.fn(async () => { throw new Error("private failure details"); });
    const h = setup(initial, { setEnabled });
    await screen.findByText(/Dial accepted the call request/);
    fireEvent.click(checkbox());
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh integrations before repeating the action");
    expect(checkbox()).toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(testButton()).toBeDisabled();
    expect(screen.queryByText(/Dial accepted the call request/)).toBeNull();
    expect(document.body.textContent).not.toContain("private failure details");
    expect(setEnabled).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(1);
    h.setSnapshot(snapshot(false));
    fireEvent.click(refresh());
    await waitFor(() => expect(checkbox()).toBeEnabled());
    expect(checkbox()).not.toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending write locked when the sign-in callback changes on rerender", async () => {
    let resolve!: (value: { enabled: boolean }) => void;
    const setEnabled = vi.fn(() => new Promise<{ enabled: boolean }>(done => { resolve = done; }));
    const h = setup(snapshot(true), { setEnabled, onSignIn: vi.fn() });
    await screen.findByRole("checkbox");
    fireEvent.click(checkbox());
    h.rerender(<IntegrationsCard load={h.load} setEnabled={h.setEnabled} test={h.test} onSignIn={vi.fn()} />);
    expect(checkbox()).toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(refresh()).toBeDisabled();
    expect(testButton()).toBeDisabled();
    fireEvent.click(checkbox());
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    h.setSnapshot(snapshot(false));
    await act(async () => resolve({ enabled: false }));
    await waitFor(() => expect(checkbox()).not.toBeChecked());
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it.each(["rejected", "malformed"])("does not retry an uncertain test request (%s)", async failure => {
    const test = vi.fn(async () => {
      if (failure === "rejected") throw new Error("unconfirmed");
      return { queued: false } as unknown as { queued: true };
    });
    const h = setup(snapshot(true), { test });
    await screen.findByRole("checkbox");
    fireEvent.click(testButton());
    await screen.findByRole("alert");
    expect(testButton()).toBeDisabled();
    expect(test).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Test request accepted for queuing/)).toBeNull();
  });

  it("retains a confirmed Off if the follow-up GET cannot confirm the rest of the status", async () => {
    const load = vi.fn().mockResolvedValueOnce(snapshot(true)).mockRejectedValueOnce(new Error("read failed"));
    const h = setup(snapshot(true), { load, setEnabled: vi.fn(async () => ({ enabled: false })) });
    await screen.findByRole("checkbox");
    fireEvent.click(checkbox());
    await screen.findByRole("alert");
    expect(checkbox()).not.toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByText("Phone alerts are off.")).toBeNull();
  });

  it.each(["unconfigured", "not-live"])("disables opt-in and test when %s", async condition => {
    const value = snapshot();
    value.dial.configured = condition !== "unconfigured";
    value.dial.live = false;
    value.dial.status = condition === "unconfigured" ? "unconfigured" : "disabled";
    const h = setup(value);
    await screen.findByRole("checkbox");
    expect(checkbox()).toBeDisabled(); expect(testButton()).toBeDisabled();
    expect(h.setEnabled).not.toHaveBeenCalled(); expect(h.test).not.toHaveBeenCalled();
  });

  it("labels acceptance and unknown as call-request outcomes, and shows the pending count", async () => {
    const value = snapshot(true);
    value.dial.status = "unknown";
    value.dial.pending = 2;
    value.dial.last_result = { at: "2026-10-11T23:00:00.000Z", status: "accepted" };
    setup(value);
    expect(await screen.findByText(/Call outcome unknown/)).toBeInTheDocument();
    expect(screen.getByText("Queued notices: 2")).toBeInTheDocument();
    expect(screen.getByText(/Dial accepted the call request. This does not confirm the call was answered/)).toBeInTheDocument();
  });

  it.each([null, { jev: { configured: "yes", model: "private/raw" }, dial: {} }])("fails closed on malformed metadata without exposing it", async value => {
    const h = setup(snapshot(), { load: vi.fn(async () => value as unknown as IntegrationMetadata) });
    expect(await screen.findByRole("alert")).toHaveTextContent("Integration status is unavailable");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.body.textContent).not.toContain("private/raw");
    expect(h.setEnabled).not.toHaveBeenCalled(); expect(h.test).not.toHaveBeenCalled();
  });

  it("delegates a 401 to sign-in without retrying", async () => {
    const onSignIn = vi.fn();
    const load = vi.fn(async () => { throw { status: 401 }; });
    setup(snapshot(), { load, onSignIn });
    await waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a delayed load after unmount", async () => {
    let resolve!: (value: IntegrationMetadata) => void;
    const h = setup(snapshot(), { load: () => new Promise<IntegrationMetadata>(done => { resolve = done; }) });
    h.unmount();
    await act(async () => resolve(snapshot(true)));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(h.setEnabled).not.toHaveBeenCalled(); expect(h.test).not.toHaveBeenCalled();
  });
});

describe("integration metadata validation", () => {
  it("rejects malformed outcomes and strips unknown fields from accepted metadata", () => {
    const good = snapshot(true);
    expect(parseIntegrationMetadata({ ...good, apiKey: "not-for-the-page" })).toEqual(good);
    for (const delta of [
      { pending: -1 }, { pending: 0.5 }, { status: "delivered" }, { live: false },
      { last_result: { status: "accepted", at: "not a date" } },
      { last_result: { status: "delivered", at: "2026-10-11T23:00:00.000Z" } },
    ]) expect(() => parseIntegrationMetadata({ ...good, dial: { ...good.dial, ...delta } })).toThrow("unconfirmed_integration_response");
  });
});
