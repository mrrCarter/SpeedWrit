import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveJobForm } from "../src/screens/LiveJobForm";

afterEach(cleanup);

const CONTACTS = [
  { name: "Dana", company: "Acme", email: "Dana@acme.test" },
  { name: "Bo", email: "bo@example.test" },
];
const NOW = () => new Date("2026-10-11T16:00:00.000Z");
const setup = (contacts = CONTACTS, now = NOW, timeZone = "America/Los_Angeles") => {
  const onUse = vi.fn();
  const result = render(<LiveJobForm contacts={contacts} now={now} timeZone={timeZone} onUse={onUse} />);
  return { ...result, onUse, review: () => screen.getByRole("button", { name: "Review this job" }) };
};

describe("LiveJobForm", () => {
  it("resolves typed content rules into review of every message, without granting authority", () => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "don't sound rude\nno promises of discounts" } });
    expect(screen.getAllByText("AI-reviewed, may miss")).toHaveLength(2);
    expect(screen.getByText(/All six built-in AI checks/)).toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxSends: 3, allowCustomWithApproval: true, aiReview: "all_free_text" }));
  });

  it.each(["make it amazing", "only send max 3", "two sends max until tonight", "only email nobody"])('requires clarification of %j even with complete structured controls', (rule) => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: rule } });
    expect(screen.getByText("Needs one detail")).toBeInTheDocument();
    expect(review()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /starter pack/i })).toBeNull();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "" } });
    expect(review()).toBeEnabled();
  });

  it("matches the structured count and narrows expiry in the resolved draft", () => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "three sends max\nuntil 5pm\nonly email Dana" } });
    expect(screen.getByText("More than 3 sends")).toBeInTheDocument();
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ recipient: "dana@acme.test", maxSends: 3, expiresAt: "2026-10-12T00:00:00.000Z" }));
  });

  it.each([["3.5 sends max", "5"], ["1,000 sends max", "1"], ["-3 sends max", "3"], ["3 sends max except on Friday", "3"]])("never silently changes the meaning of %j", (rule, count) => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sends at most" }), { target: { value: count } });
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: rule } });
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it("requires multiple typed count lines to agree with the control", () => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "three sends max\ntwo sends max" } });
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it("blocks a typed two-send limit against the structured three without changing either", () => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "two sends max" } });
    expect(review()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("The typed send limit disagrees");
    expect(screen.getByRole("spinbutton", { name: "Sends at most" })).toHaveValue(3);
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sends at most" }), { target: { value: "2" } });
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ maxSends: 2 }));
  });

  it("blocks a conflicting recipient and does not let text enable unchecked custom permission", () => {
    const { onUse, review } = setup();
    const input = screen.getByRole("textbox", { name: "Custom rules in your words" });
    fireEvent.change(input, { target: { value: "only email Bo" } });
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "ask me before custom wording" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ask me before custom wording" }));
    expect(review()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Custom wording is switched off");
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it("keeps typed expiry fixed and rechecks it when submitting later", () => {
    let clock = NOW();
    const { onUse, review } = setup(CONTACTS, () => clock);
    fireEvent.change(screen.getByRole("textbox", { name: "Custom rules in your words" }), { target: { value: "until 10am" } });
    expect(review()).toBeEnabled();
    clock = new Date("2026-10-11T17:01:00.000Z");
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The resolved expiry has passed");
  });

  it("previews three sends and custom approval, then hands a complete draft to the existing review flow", () => {
    const { onUse, review } = setup();
    expect(screen.getByRole("spinbutton", { name: "Sends at most" })).toHaveValue(3);
    expect(screen.getByRole("checkbox", { name: "Ask me before custom wording" })).toBeChecked();
    expect(screen.getByText("More than 3 sends")).toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledExactlyOnceWith({
      recipient: "dana@acme.test",
      maxSends: 3,
      expiresAt: "2026-10-12T06:59:00.000Z",
      allowCustomWithApproval: true,
    });
  });

  it("uses the selected contact, one-send limit and explicit refusal of custom wording", () => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Recipient" }), { target: { value: "bo@example.test" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sends at most" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Ask me before custom wording" }));
    expect(screen.getByText("Custom wording is refused.")).toBeInTheDocument();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledExactlyOnceWith({
      recipient: "bo@example.test",
      maxSends: 1,
      expiresAt: "2026-10-12T06:59:00.000Z",
      allowCustomWithApproval: false,
    });
  });

  it.each(["", "0", "11", "1.5"])("does not submit invalid count %j, even if the form is submitted directly", (value) => {
    const { onUse, review } = setup();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sends at most" }), { target: { value } });
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 10.");
  });

  it("accepts the upper count boundary and computes tonight in the owner's time zone", () => {
    const { onUse, review } = setup(CONTACTS, NOW, "America/New_York");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Sends at most" }), { target: { value: "10" } });
    fireEvent.click(review());
    expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ maxSends: 10, expiresAt: "2026-10-12T03:59:00.000Z" }));
  });

  it("cannot create a draft without a configured contact", () => {
    const { onUse, review } = setup([]);
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a recipient from your contacts.");
  });

  it("does not retain a selected recipient after that contact is removed", () => {
    const { onUse, rerender, review } = setup();
    rerender(<LiveJobForm contacts={[CONTACTS[1]!]} now={NOW} timeZone="America/Los_Angeles" onUse={onUse} />);
    expect(review()).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
  });

  it("rechecks expiry on submit and does not extend an overnight draft to the next day", () => {
    let clock = NOW();
    const { onUse, review } = setup(CONTACTS, () => clock);
    expect(review()).toBeEnabled();
    clock = new Date("2026-10-12T07:00:00.000Z");
    fireEvent.submit(screen.getByRole("form", { name: "New job" }));
    expect(onUse).not.toHaveBeenCalled();
    expect(review()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Tonight's expiry has passed.");
  });
});
