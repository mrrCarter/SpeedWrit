import { describe, expect, it } from "vitest";
import { createSigner } from "./crypto";
import { Engine } from "./engine";

const signer = createSigner();
const revision = {
  custom: { subject: "Kickoff?", body: "Hi Dana, does Friday at 10am work?" },
  prompt: "Make it Friday at 10am instead.",
};

async function freshHeldProposal() {
  const engine = new Engine({ latencyMs: 0, signer, seed: "fresh" });
  await engine.ready;
  const connected = await engine.connectAgent("New ChatGPT connection", "oauth");
  if (!connected.connection) throw new Error("Agent connection was not created");
  const connectionId = connected.connection.id;
  const made = await engine.confirmSendJob({
    recipient: "dana@acme.test",
    maxSends: 2,
    expiresAt: engine.getState().clock + 60 * 60 * 1000,
    allowCustom: true,
  }, connectionId);
  if (!made.jobId) throw new Error("Job was not confirmed");
  const held = await engine.proposeSend({
    connectionId,
    jobId: made.jobId,
    to: "dana@acme.test",
    custom: { subject: "Kickoff?", body: "Hi Dana, does Thursday at 2pm work?" },
  });
  expect(held).toMatchObject({ status: "pending_approval", version: 1 });
  if (!held.proposalId) throw new Error("Proposal was not created");
  return { engine, connectionId, proposalId: held.proposalId };
}

describe("revision transcript attribution", () => {
  it("shows version two in a fresh connection's transcript", async () => {
    const { engine, connectionId, proposalId } = await freshHeldProposal();
    const result = await engine.reviseSend(proposalId, revision);

    expect(result).toMatchObject({ status: "pending_approval", version: 2 });
    expect(engine.getState().agentLog[0]).toMatchObject({
      connectionId,
      tool: "revise_proposal",
      prompt: revision.prompt,
      result: { status: "pending_approval", proposalId, version: 2 },
    });
    expect(engine.getState().proposals.find((p) => p.id === proposalId)?.currentVersion).toBe(2);
    expect(engine.getState().providerCalls).toBe(0);
  });

  it("keeps a not-pending refusal in the proposal connection's transcript", async () => {
    const { engine, connectionId, proposalId } = await freshHeldProposal();
    await engine.denyProposal(proposalId);
    const result = await engine.reviseSend(proposalId, revision);

    expect(result).toMatchObject({ status: "denied", reasonCode: "not_pending" });
    expect(engine.getState().agentLog[0]).toMatchObject({
      connectionId,
      tool: "revise_proposal",
      result: { status: "denied", reasonCode: "not_pending" },
    });
    expect(engine.getState().proposals.find((p) => p.id === proposalId)?.currentVersion).toBe(1);
    expect(engine.getState().providerCalls).toBe(0);
  });
});
