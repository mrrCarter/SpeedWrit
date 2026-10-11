import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerAppBootstrap } from "../src/app/OwnerAppBootstrap";
import type { OwnerAppConfig } from "../src/app/config";

const CONFIG: OwnerAppConfig = {
  jobDefaults: { templateId: "tpl_recap", purpose: "Call recap", autoSend: true },
  contacts: [{ name: "Dana", email: "dana@example.test", company: "Example" }],
  connectGmailHref: "/connect/gmail",
  timeZone: "America/Los_Angeles",
};
const PRIVATE_FIXTURE = "synthetic-private-config-value";
const FAILED = "SpeedWrit could not load. Try again in a moment.";
const response = (config: unknown = CONFIG) => new Response(JSON.stringify(config), { status: 200 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(fetcher: typeof fetch) {
  const child = vi.fn((config: OwnerAppConfig) => <p>Ready: {config.jobDefaults.purpose}</p>);
  return { ...render(<OwnerAppBootstrap fetcher={fetcher}>{child}</OwnerAppBootstrap>), child };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("owner app startup", () => {
  it("renders accessible loading immediately and mounts the app only after a valid same-origin GET", async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    const { child } = setup(fetcher);
    expect(screen.getByRole("main", { name: "SpeedWrit" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Loading SpeedWrit…");
    expect(child).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/owner-app/config.json", {
      method: "GET", credentials: "same-origin", headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    await act(async () => pending.resolve(response()));
    expect(screen.getByText("Ready: Call recap")).toBeVisible();
    expect(child).toHaveBeenCalledWith(CONFIG);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error(PRIVATE_FIXTURE))],
    ["non-success response", () => Promise.resolve(new Response(PRIVATE_FIXTURE, { status: 503 }))],
    ["invalid JSON", () => Promise.resolve(new Response(PRIVATE_FIXTURE, { status: 200 }))],
  ])("shows only fixed safe feedback for %s, without retrying automatically", async (_name, answer) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(answer);
    const { child, container } = setup(fetcher);
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(container.textContent).not.toContain(PRIVATE_FIXTURE);
    expect(child).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["missing job defaults", { ...CONFIG, jobDefaults: null }],
    ["empty template ID", { ...CONFIG, jobDefaults: { ...CONFIG.jobDefaults, templateId: "" } }],
    ["non-text purpose", { ...CONFIG, jobDefaults: { ...CONFIG.jobDefaults, purpose: 7 } }],
    ["non-boolean auto-send", { ...CONFIG, jobDefaults: { ...CONFIG.jobDefaults, autoSend: "true" } }],
    ["missing contacts", { ...CONFIG, contacts: null }],
    ["malformed contact", { ...CONFIG, contacts: [{ name: PRIVATE_FIXTURE }] }],
    ["non-text optional company", { ...CONFIG, contacts: [{ ...CONFIG.contacts[0], company: {} }] }],
    ["non-text Gmail route", { ...CONFIG, connectGmailHref: {} }],
    ["off-site Gmail route", { ...CONFIG, connectGmailHref: "https://example.test/connect/gmail" }],
    ["non-text time zone", { ...CONFIG, timeZone: 7 }],
    ["invalid time zone", { ...CONFIG, timeZone: "Not/A_Time_Zone" }],
  ])("keeps %s out of the owner app after a successful HTTP response", async (_name, config) => {
    const { child, container } = setup(vi.fn<typeof fetch>().mockResolvedValue(response(config)));
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(child).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(PRIVATE_FIXTURE);
  });

  it("accepts empty contacts and absent optional fields without restricting future config additions", async () => {
    const config = { jobDefaults: { ...CONFIG.jobDefaults, purpose: "" }, contacts: [], connectGmailHref: "/connect/gmail", futureOption: "ignored" };
    const { child } = setup(vi.fn<typeof fetch>().mockResolvedValue(response(config)));
    await screen.findByText("Ready:");
    expect(child).toHaveBeenCalledWith(config);
  });

  it("recovers through one explicit GET even when Try again is clicked twice before rerender", async () => {
    const retry = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => retry.promise);
    setup(fetcher);
    const button = await screen.findByRole("button", { name: "Try again" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Loading SpeedWrit…");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => retry.resolve(response()));
    expect(screen.getByText("Ready: Call recap")).toBeVisible();
    expect(fetcher.mock.calls.every(([url, init]) => url === "/owner-app/config.json" && init?.method === "GET" && init.body === undefined)).toBe(true);
  });

  it.each(["request", "body"])("times out a stalled %s, permits manual recovery and ignores the late first result", async (stage) => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const body = deferred<unknown>();
    const first = stage === "request" ? pending.promise : Promise.resolve({ ok: true, json: () => body.promise } as Response);
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => first).mockResolvedValueOnce(response());
    const { child } = setup(fetcher);
    await act(async () => { await Promise.resolve(); });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole("alert")).toHaveTextContent(FAILED);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(screen.getByText("Ready: Call recap")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      const old = { ...CONFIG, jobDefaults: { ...CONFIG.jobDefaults, purpose: "stale" } };
      pending.resolve(response(old));
      body.resolve(old);
    });
    expect(screen.queryByText("Ready: stale")).toBeNull();
    expect(child).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and clears the deadline on unmount without mounting from a late response", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => pending.promise);
    const { child, unmount } = setup(fetcher);
    unmount();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => pending.resolve(response()));
    expect(child).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
