import { describe, expect, it } from "vitest";
import { createSigner } from "./crypto";
import { Engine } from "./engine";
import { runScenario, SCENARIOS } from "./scenarios";

const signer = createSigner();

describe("edge cases and failure modes", () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: ${s.title} → ${s.expect}`, async () => {
      const run = await runScenario(s, new Engine({ latencyMs: 0, signer }));
      const failed = run.checks.filter((c) => !c.ok).map((c) => `${c.label} (got ${c.got})`);
      expect(run.error ?? null).toBeNull();
      expect(failed).toEqual([]);
    });
  }
});
