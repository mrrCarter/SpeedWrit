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
