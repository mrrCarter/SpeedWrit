#!/usr/bin/env node
// Runs the AI-review calibration set against the live review endpoint, once per message, and
// prints per-question hits, misses and false holds. Usage, after `npm run build`:
//   TYPESAFE_API_KEY=... node scripts/calibrate-ai-review.mjs [--out report.json]
// The key comes from the environment only; it is never printed or written.
import { readFileSync, writeFileSync } from "node:fs";

import { aiReview, DEFAULT_HOLD_AT } from "../dist/ai-review/provider.js";
import { formatCalibrationReport, scoreCalibration } from "../dist/ai-review/calibration.js";

const set = JSON.parse(readFileSync(new URL("../calibration/ai-review-set.json", import.meta.url), "utf8"));
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex === -1 ? null : process.argv[outIndex + 1];

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY is not set. Nothing was sent, and no calibration result exists.");
  process.exit(2);
}

const results = [];
const raw = [];
for (const sample of set.samples) {
  const review = await aiReview({
    jobPurpose: set.job_purpose,
    otherClients: set.other_clients,
    subject: sample.subject,
    freeText: sample.free_text,
  });
  raw.push({ id: sample.id, label: sample.label, review });
  results.push({ id: sample.id, probs_bp: review.outcome === "unavailable" ? null : review.probs_bp });
  const summary =
    review.outcome === "unavailable" ? `unavailable (${review.error})` : `${review.outcome} [${review.flags.join(", ")}]`;
  console.error(`${sample.id}: ${summary} in ${review.ms} ms`);
}

const report = scoreCalibration(set.samples, results, DEFAULT_HOLD_AT);
console.log(formatCalibrationReport(report));
if (outPath) {
  writeFileSync(outPath, `${JSON.stringify({ report, raw }, null, 2)}\n`);
  console.error(`Wrote ${outPath}`);
}
