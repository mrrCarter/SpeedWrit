import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAY, findNeverSay } from "../src/lib/copy";
import type { Classify, Contact } from "../src/lib/frontDoor";
import { FrontDoor } from "../src/screens/FrontDoor";

afterEach(cleanup);

const CONTACTS: Contact[] = [
  { name: "Dana Ruiz", company: "Acme", email: "dana@acme.com" },
  { name: "Dana Lee", company: "Beta Labs", email: "dana.lee@beta.io" },
  { name: "Sam Ortiz", company: "Acme", email: "sam@acme.com" },
];
const NOW = () => new Date("2026-10-11T16:00:00Z"); // 09:00 in San Francisco

function setup(classify?: Classify) {
  const onUse = vi.fn();
  render(<FrontDoor contacts={CONTACTS} timeZone="America/Los_Angeles" now={NOW} classify={classify} onUse={onUse} />);
  const type = async (text: string) => {
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: text } });
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
  };
  const use = () => screen.getByRole("button", { name: "Use these limits" }) as HTMLButtonElement;
  const line = (text: string) => within(screen.getByRole("listitem", { name: text }));
  return { onUse, type, use, line };
}

describe("FrontDoor", () => {
  it("each line becomes its chip, and 'Use these limits' hands over the draft once the job is complete", async () => {
    const { onUse, type, use, line } = setup();
    await type("only email Dana at Acme");
    expect(line("only email Dana at Acme").getByText("Never: anyone else")).toBeTruthy();
    await type("two sends max");
    expect(line("two sends max").getByText("Never: a third send")).toBeTruthy();
    expect(screen.getByText("Still needed: when it ends.")).toBeTruthy();
    expect(use().disabled).toBe(true);
    await type("expires tonight");
    expect(line("expires tonight").getByText("Never: after that")).toBeTruthy();
    expect(use().disabled).toBe(false);
    fireEvent.click(use());
    expect(onUse).toHaveBeenCalledWith({ recipient: "dana@acme.com", maxSends: 2, expiresAt: "2026-10-12T06:59:00.000Z" });
  });

  it("the starter pack is one tap but still asks who; two matching contacts ask which one", async () => {
    const { onUse, type, use, line } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Starter pack/ }));
    expect(screen.getByText("Still needed: who may receive it.")).toBeTruthy();
    expect(use().disabled).toBe(true);
    await type("only email Dana");
    expect(line("only email Dana").getByText("Needs one detail")).toBeTruthy();
    fireEvent.click(line("only email Dana").getByRole("button", { name: "Dana Lee (Beta Labs) <dana.lee@beta.io>" }));
    expect(line("only email Dana").getByText("Never: anyone else")).toBeTruthy();
    fireEvent.click(use());
    expect(onUse).toHaveBeenCalledWith({
      recipient: "dana.lee@beta.io",
      maxSends: 2,
      expiresAt: "2026-10-12T06:59:00.000Z",
      allowCustomWithApproval: true,
    });
  });

  it("a vague line needs one detail and blocks the draft; the starter pack replaces it", async () => {
    const { type, use, line } = setup();
    await type("don't fuck my shit up");
    expect(line("don't fuck my shit up").getByText("Needs one detail")).toBeTruthy();
    await type("only email Sam");
    await type("two sends max");
    await type("until 6pm");
    expect(use().disabled).toBe(true); // every other field is there; the vague line still blocks
    fireEvent.click(line("don't fuck my shit up").getByRole("button", { name: "Use the starter pack instead" }));
    expect(screen.queryByRole("listitem", { name: "don't fuck my shit up" })).toBeNull();
    expect(use().disabled).toBe(false);
  });

  it("two recipients are flagged and the draft stays off until one is removed", async () => {
    const { type, use } = setup();
    await type("only email Sam");
    await type("only email dana@acme.com");
    await type("two sends max");
    await type("expires tonight");
    expect(screen.getByRole("alert").textContent).toBe("A job emails one person. Keep one recipient line.");
    expect(use().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: 'Remove "only email Sam"' }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(use().disabled).toBe(false);
  });

  it("a classified line still needs one detail; its small form makes the concrete limit", async () => {
    const classify = vi.fn<Classify>(async () => ({ answers: { a: { choice: "count", confidence: 0.9 }, b: { choice: "count", confidence: 0.9 } } }));
    const { type, line } = setup(classify);
    await type("keep it to a couple");
    expect(line("keep it to a couple").getByText("Needs one detail")).toBeTruthy();
    fireEvent.change(line("keep it to a couple").getByRole("spinbutton", { name: "Sends at most" }), { target: { value: "3" } });
    fireEvent.click(line("keep it to a couple").getByRole("button", { name: "Set the limit" }));
    expect(line("keep it to a couple").getByText("Never: a fourth send")).toBeTruthy();
  });

  it("a classifier answer for a line removed meanwhile changes nothing", async () => {
    let answer: (kind: string) => void = () => {};
    const classify: Classify = () =>
      new Promise((resolve) => {
        answer = (kind) => resolve({ answers: { a: { choice: kind, confidence: 0.9 }, b: { choice: kind, confidence: 0.9 } } });
      });
    const { type } = setup(classify);
    await type("keep it short and sweet");
    expect(screen.getByText("Reading the line…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "keep it short and sweet"' }));
    await act(async () => answer("content"));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("an AI-review line is labeled 'AI-reviewed, may miss', and nothing on the screen breaks the Say / Never-say table", async () => {
    const { type, line } = setup(async () => ({ answers: { a: { choice: "content", confidence: 0.9 }, b: { choice: "content", confidence: 0.9 } } }));
    for (const text of ["only email Dana at Acme", "two sends max", "expires tonight", "ask me before custom wording", "no links", "don't sound rude", "be nice to the legal team", "don't fuck my shit up"]) {
      await type(text);
    }
    expect(line("don't sound rude").getByText(SAY.aiReviewed)).toBeTruthy();
    expect(line("be nice to the legal team").getAllByRole("button", { name: /^AI review: / })).toHaveLength(6);
    expect(findNeverSay(document.body.textContent ?? "")).toEqual([]);
  });
});
