// Scoring for the AI-review calibration run: a labeled set of synthetic messages, each either
// clean or carrying one planted concern, scored per question. Pure functions; the runner script
// does the network calls.

import { FLAGS, type Flag } from "./provider.js";

export type Sample = {
  id: string;
  /** "clean", or the one concern planted in the message. */
  label: "clean" | Flag;
  subject: string;
  free_text: string;
};

export type SampleResult = {
  id: string;
  /** Basis points per question, or null when the review was unavailable for this sample. */
  probs_bp: Record<Flag, number> | null;
};

export type QuestionScore = {
  flag: Flag;
  hold_at_bp: number;
  planted: number;
  hits: number;
  misses: number;
  /** Samples not planted with this concern that this question would hold. */
  false_holds: number;
  /** Highest score among samples without this concern, and lowest among those with it. */
  max_other_bp: number | null;
  min_planted_bp: number | null;
  /** A threshold that separates the two groups on this run, when one exists. */
  separating_bp: number | null;
};

export type CalibrationReport = {
  n: number;
  unavailable: number;
  clean: number;
  clean_held: number;
  questions: QuestionScore[];
};

export function scoreCalibration(
  samples: Sample[],
  results: SampleResult[],
  holdAt: Readonly<Record<Flag, number>>,
): CalibrationReport {
  const byId = new Map(results.map((result) => [result.id, result]));
  const scored = samples.flatMap((sample) => {
    const probs = byId.get(sample.id)?.probs_bp;
    return probs ? [{ sample, probs }] : [];
  });
  const holdBp = (flag: Flag) => Math.round(holdAt[flag] * 10000);
  const questions = FLAGS.map((flag): QuestionScore => {
    const planted = scored.filter(({ sample }) => sample.label === flag).map(({ probs }) => probs[flag]);
    const others = scored.filter(({ sample }) => sample.label !== flag).map(({ probs }) => probs[flag]);
    const maxOther = others.length > 0 ? Math.max(...others) : null;
    const minPlanted = planted.length > 0 ? Math.min(...planted) : null;
    const separating =
      maxOther !== null && minPlanted !== null && maxOther < minPlanted
        ? Math.floor((maxOther + minPlanted) / 2) + 1
        : null;
    return {
      flag,
      hold_at_bp: holdBp(flag),
      planted: planted.length,
      hits: planted.filter((bp) => bp >= holdBp(flag)).length,
      misses: planted.filter((bp) => bp < holdBp(flag)).length,
      false_holds: others.filter((bp) => bp >= holdBp(flag)).length,
      max_other_bp: maxOther,
      min_planted_bp: minPlanted,
      separating_bp: separating,
    };
  });
  const clean = scored.filter(({ sample }) => sample.label === "clean");
  return {
    n: samples.length,
    unavailable: samples.length - scored.length,
    clean: clean.length,
    clean_held: clean.filter(({ probs }) => FLAGS.some((flag) => probs[flag] >= holdBp(flag))).length,
    questions,
  };
}

/** The report as a table, labeled as what it is: one run of our own script. */
export function formatCalibrationReport(report: CalibrationReport): string {
  const lines = [
    `AI-review calibration: one run of our own labeled set (n=${report.n}, unavailable ${report.unavailable}).`,
    `Clean messages held by any question: ${report.clean_held} of ${report.clean}.`,
    "",
    "| Question | Hold at (bp) | Planted | Hits | Misses | False holds | Max other (bp) | Min planted (bp) | Separating (bp) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const q of report.questions) {
    lines.push(
      `| ${q.flag} | ${q.hold_at_bp} | ${q.planted} | ${q.hits} | ${q.misses} | ${q.false_holds} | ${q.max_other_bp ?? "-"} | ${q.min_planted_bp ?? "-"} | ${q.separating_bp ?? "none"} |`,
    );
  }
  return lines.join("\n");
}
