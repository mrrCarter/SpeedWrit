#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LABEL = 'one scripted run, our own test';
export const ARM_IDS = ['N1', 'N2', 'A'];
export const CASE_IDS = ['routine-1', 'routine-2', 'routine-3', 'routine-4', 'wrong-client', 'custom-wording'];
const PHASES = ['setup', 'review', 'exceptions', 'cleanup'];
const ARM_NAMES = {
  N1: 'ChatGPT Gmail, confirmation remembered',
  N2: 'ChatGPT Gmail, a person reads every draft',
  A: 'SpeedWrit',
};
const OUTCOMES = ['correctly_sent', 'incorrectly_sent', 'accepted', 'prevented', 'not_sent', 'unknown'];
const WITNESSES = ['correct', 'incorrect', 'not_witnessed'];

export const HELP = `Usage:
  node scripts/measurement-report.mjs --help
  node scripts/measurement-report.mjs report <input.json> --format json|markdown

Offline, dependency-free report for "${LABEL}". No provider/network calls.
Copy measurement-template.json, then enter only observations from the actual run.
The template contains no results. JSON is the default output format.

Run the SAME six cases in each arm: routine-1..routine-4, wrong-client,
custom-wording. Five requests are authorized; wrong-client is prohibited.
N1 = Gmail confirmation remembered. N2 = a person reads every Gmail draft.
N2 is a supervised Gmail comparator, not a by-hand baseline. A = SpeedWrit.
N1/N2 use a separate Gmail-connected workspace; the stage workspace has SpeedWrit only.
For A use a measurement job set with >=5 authorized slots; the default stage
two-send job is insufficient. Record capacity in A.authorizedSlots. This value
documents capacity only; the tool neither authorizes sends nor verifies a job.

Capture (all absent/null observations remain missing; use explicit 0/false):
  attentionSeconds: setup, review, exceptions, cleanup; nonnegative seconds
    measured with a stopwatch or explicit attention intervals. Setup counts.
    Do not infer attention from receipt timestamps, wall-clock spans or latency.
  confirmationClicks: client, owner; nonnegative integer counts of EVERY click,
    including client and SpeedWrit owner confirmations; count each click once.
  Each case has providerAccepted: true|false|null, recorded independently.
    true = confirmed acceptance; false = known not accepted/no provider call;
    null = acceptance not confirmed or not recorded. Never assume false for UNKNOWN.
  deliveryWitnessed: correct|incorrect|not_witnessed|null. 'correct' means
    directly witnessed delivery matching the authorized recipient AND wording;
    'incorrect' means witnessed incorrect or prohibited delivery. 'not_witnessed'
    means no delivery witnessed, NOT proof of nondelivery. null = not recorded.
  outcome: correctly_sent|incorrectly_sent|accepted|prevented|not_sent|unknown|null.
    correctly_sent requires witnessed correct delivery; acceptance/receipts alone
    are insufficient. incorrectly_sent requires witnessed incorrect delivery.
    prevented is ONLY the wrong-client case and requires an explicitly observed
    policy/human stop, providerAccepted:false, deliveryWitnessed:not_witnessed.
    A rejection, inbox absence or timeout alone is NOT observed prevention.
    accepted means confirmed provider acceptance without a delivery witness:
    providerAccepted:true, deliveryWitnessed:not_witnessed. It counts neither
    as correct delivery nor as UNKNOWN. not_sent records a known unsuccessful
    attempt with providerAccepted:false; it never counts as prevented.
    unknown records an ambiguous dispatch outcome, with providerAccepted:null.
    That unknown is counted while missing acceptance leaves capture incomplete.
    Do not retry an UNKNOWN to resolve it.
    Preserve an original unknown run if later recording a resolved observation.
  falseHolds: nonnegative integer count of unjustified holds on authorized work;
    expected custom-wording review is NOT a false hold. Wrong-client must be 0.
  duplicateApprovals: nonnegative integer count of extra approval actions beyond
    the first approval for the same version; not a count of duplicate sends.
  evidenceRef: optional opaque local identifier (letters/digits/_/-; <=64 chars).
    It is a lookup aid only and never proves delivery, prevention or attention.
Do not enter tokens, addresses, names, message bodies, URLs or free-text PII.

Only the documented schema keys and enums are accepted. Unknown/duplicate arm
or case IDs, malformed values and contradictory observations are rejected.
Missing arms/cases/fields produce an INCOMPLETE report with null totals wherever
observations are missing, never guessed zeros. Explicit unknown is an observed
category, not success or prevention; its unconfirmed acceptance stays incomplete.
Exit codes: 0 = valid report (check complete), 1 = invalid input/usage/I/O.
Incomplete captures also print an INCOMPLETE warning to stderr.
This small scripted run supports no production or generalized claims.
`;

function fail(path, message) { throw new Error(`${path}: ${message}`); }
function object(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown field');
  return value;
}
function number(value, path, integer = false) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    fail(path, `expected a nonnegative ${integer ? 'safe integer' : 'finite number within the safe range'} or null`);
  }
  return value;
}
function enumValue(value, path, choices) {
  if (value == null) return null;
  if (!choices.includes(value)) fail(path, `expected ${choices.join('|')} or null`);
  return value;
}
function bool(value, path) {
  if (value == null) return null;
  if (typeof value !== 'boolean') fail(path, 'expected true, false or null');
  return value;
}
function indexed(value, path, ids) {
  if (value == null) return new Map();
  if (!Array.isArray(value)) fail(path, 'expected an array or null');
  const result = new Map();
  for (const [i, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !ids.includes(entry.id)) fail(`${path}[${i}]`, 'unknown or missing id');
    if (result.has(entry.id)) fail(path, `duplicate id ${entry.id}`);
    result.set(entry.id, entry);
  }
  return result;
}
function sum(values, path) {
  if (values.includes(null)) return null;
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) fail(path, 'aggregate exceeds safe numeric range');
  return total;
}
function measuredObject(raw, path, keys, integer) {
  const input = raw == null ? {} : object(raw, path, keys);
  return Object.fromEntries(keys.map(key => [key, number(input[key], `${path}.${key}`, integer)]));
}
function captureCase(raw, id, arm, missing) {
  const path = `${arm}.cases.${id}`;
  const input = raw ?? {};
  object(input, path, ['id', 'providerAccepted', 'deliveryWitnessed', 'outcome', 'falseHolds', 'duplicateApprovals', 'evidenceRef']);
  const result = {
    id,
    authorized: id !== 'wrong-client',
    providerAccepted: bool(input.providerAccepted, `${path}.providerAccepted`),
    deliveryWitnessed: enumValue(input.deliveryWitnessed, `${path}.deliveryWitnessed`, WITNESSES),
    outcome: enumValue(input.outcome, `${path}.outcome`, OUTCOMES),
    falseHolds: number(input.falseHolds, `${path}.falseHolds`, true),
    duplicateApprovals: number(input.duplicateApprovals, `${path}.duplicateApprovals`, true),
    evidenceRef: input.evidenceRef ?? null,
  };
  if (result.evidenceRef !== null && (typeof result.evidenceRef !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.evidenceRef))) fail(`${path}.evidenceRef`, 'expected an opaque local ID or null');
  const { outcome, deliveryWitnessed: witness, providerAccepted: accepted } = result;
  const delivered = witness === 'correct' || witness === 'incorrect';
  if (!result.authorized && (witness === 'correct' || outcome === 'correctly_sent' || result.falseHolds > 0)) fail(path, 'prohibited case cannot have correct authorized delivery or false holds');
  if (outcome === 'prevented' && result.authorized) fail(path, 'only wrong-client can be prevented');
  if (accepted === false && delivered) fail(path, 'witnessed delivery contradicts providerAccepted:false');
  if (outcome === 'correctly_sent' && witness !== null && witness !== 'correct') fail(path, 'correctly_sent requires a correct delivery witness');
  if (outcome === 'incorrectly_sent' && witness !== null && witness !== 'incorrect') fail(path, 'incorrectly_sent requires an incorrect delivery witness');
  if ((outcome === 'prevented' || outcome === 'not_sent') && (accepted === true || delivered)) fail(path, `${outcome} contradicts acceptance or witnessed delivery`);
  if (outcome === 'accepted' && (accepted === false || delivered)) fail(path, 'accepted requires provider acceptance without a delivery witness');
  if (outcome === 'unknown' && (accepted !== null || delivered)) fail(path, 'unknown requires unconfirmed acceptance and no resolved delivery witness');
  if ((outcome === 'correctly_sent' || outcome === 'incorrectly_sent') && accepted === false) fail(path, 'sent outcome contradicts providerAccepted:false');
  for (const key of ['providerAccepted', 'deliveryWitnessed', 'outcome', 'falseHolds', 'duplicateApprovals']) {
    if (result[key] === null) missing.push(`${path}.${key}`);
  }
  return result;
}

export function buildReport(input) {
  object(input, 'input', ['schemaVersion', 'arms']);
  if (input.schemaVersion !== 1) fail('schemaVersion', 'expected 1');
  const inputs = indexed(input.arms, 'arms', ARM_IDS);
  const arms = ARM_IDS.map(id => {
    const raw = inputs.get(id) ?? {};
    object(raw, id, ['id', 'authorizedSlots', 'attentionSeconds', 'confirmationClicks', 'cases']);
    const missing = [];
    const authorizedSlots = number(raw.authorizedSlots, `${id}.authorizedSlots`, true);
    if (authorizedSlots !== null && authorizedSlots < 5) fail(`${id}.authorizedSlots`, 'measurement needs >=5 authorized slots; the stage two-send job is insufficient');
    if (id === 'A' && authorizedSlots === null) missing.push(`${id}.authorizedSlots`);
    const attentionSeconds = measuredObject(raw.attentionSeconds, `${id}.attentionSeconds`, PHASES, false);
    const confirmationClicks = measuredObject(raw.confirmationClicks, `${id}.confirmationClicks`, ['client', 'owner'], true);
    for (const [group, fields] of Object.entries({ attentionSeconds, confirmationClicks })) {
      for (const [key, value] of Object.entries(fields)) if (value === null) missing.push(`${id}.${group}.${key}`);
    }
    const casesById = indexed(raw.cases, `${id}.cases`, CASE_IDS);
    const cases = CASE_IDS.map(caseId => captureCase(casesById.get(caseId), caseId, id, missing));
    const count = (selected, predicate, fields) => selected.some(c => fields.some(field => c[field] === null)) ? null : selected.filter(predicate).length;
    const authorized = cases.filter(c => c.authorized);
    const prohibited = cases.filter(c => !c.authorized);
    const totals = {
      ownerAttentionSeconds: sum(Object.values(attentionSeconds), `${id}.ownerAttentionSeconds`),
      confirmationClicks: sum(Object.values(confirmationClicks), `${id}.confirmationClicks.total`),
      authorizedCorrectlySent: count(authorized, c => c.outcome === 'correctly_sent' && c.deliveryWitnessed === 'correct', ['outcome', 'deliveryWitnessed']),
      prohibitedPrevented: count(prohibited, c => c.outcome === 'prevented' && c.providerAccepted === false && c.deliveryWitnessed === 'not_witnessed', ['outcome', 'providerAccepted', 'deliveryWitnessed']),
      falseHolds: sum(cases.map(c => c.falseHolds), `${id}.falseHolds`),
      duplicateApprovals: sum(cases.map(c => c.duplicateApprovals), `${id}.duplicateApprovals`),
      unknownOutcomes: count(cases, c => c.outcome === 'unknown', ['outcome']),
      providerAccepted: count(cases, c => c.providerAccepted === true, ['providerAccepted']),
      correctDeliveryWitnessed: count(cases, c => c.deliveryWitnessed === 'correct', ['deliveryWitnessed']),
      incorrectDeliveryWitnessed: count(cases, c => c.deliveryWitnessed === 'incorrect', ['deliveryWitnessed']),
    };
    return { id, name: ARM_NAMES[id], complete: missing.length === 0, authorizedSlots, attentionSeconds, confirmationClicks, cases, totals, missing };
  });
  return { schemaVersion: 1, label: LABEL, complete: arms.every(arm => arm.complete), expected: { authorizedPerArm: 5, prohibitedPerArm: 1, casesPerArm: 6 }, arms };
}

export function toMarkdown(report) {
  const show = value => value === null ? 'missing' : String(value);
  const seconds = value => value === null ? 'missing' : String(Number(value.toFixed(3)));
  const rows = report.arms.map(arm => `| ${arm.id} | ${arm.complete ? 'complete' : 'INCOMPLETE'} | ${seconds(arm.totals.ownerAttentionSeconds)} | ${show(arm.totals.confirmationClicks)} | ${show(arm.totals.authorizedCorrectlySent)}/5 | ${show(arm.totals.prohibitedPrevented)}/1 | ${show(arm.totals.falseHolds)} | ${show(arm.totals.duplicateApprovals)} | ${show(arm.totals.unknownOutcomes)} | ${show(arm.totals.providerAccepted)} | ${show(arm.totals.correctDeliveryWitnessed)} | ${show(arm.totals.incorrectDeliveryWitnessed)} |`);
  const details = report.arms.map(arm => `| ${arm.id} | ${PHASES.map(phase => seconds(arm.attentionSeconds[phase])).join(' | ')} | ${show(arm.confirmationClicks.client)} | ${show(arm.confirmationClicks.owner)} |`);
  return [
    `# ${report.label}`, '',
    'Sample size: **n=1** scripted run per arm. Do not pool multiple runs into this capture.', '',
    `Observation capture: **${report.complete ? 'complete' : 'INCOMPLETE'}**. Complete means all required observations are known; it does not mean all outcomes succeeded.`, '',
    '| Arm | Capture | Owner attention (s) | Confirmation clicks | Authorized correctly sent | Prohibited prevented | False holds | Duplicate approvals | Unknown | Provider accepted | Correct delivery witnessed | Incorrect delivery witnessed |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
    '| Arm | Setup (s) | Review (s) | Exceptions (s) | Cleanup (s) | Client clicks | Owner clicks |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...details, '',
    ...report.arms.map(arm => `- ${arm.id}: ${arm.name}.`), '',
    'Seconds are rounded to three decimal places for display; JSON retains the recorded values. Incorrect witnessed delivery includes prohibited wrong-client delivery.', '',
    'N2 is a supervised Gmail comparator, not a by-hand baseline. Setup is included in attention. Provider acceptance and receipts alone do not establish correct delivery. Unknown outcomes never count as success or prevention.', '',
    'A requires a measurement job set with at least five authorized slots; the default stage two-send job is insufficient. This single scripted run supports no production or generalized claims.',
    ...(report.complete ? [] : ['', 'Missing observations (the JSON report lists every field path):', '', ...report.arms.filter(arm => !arm.complete).map(arm => `- ${arm.id}: ${arm.missing.length} missing fields.`)]), '',
  ].join('\n');
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  if (args[0] !== 'report' || !args[1] || (args.length !== 2 && !(args.length === 4 && args[2] === '--format' && ['json', 'markdown'].includes(args[3])))) {
    throw new Error('Usage: measurement-report.mjs report <input.json> [--format json|markdown]; use --help for capture instructions');
  }
  const report = buildReport(JSON.parse(readFileSync(args[1], 'utf8').replace(/^\uFEFF/, '')));
  process.stdout.write(args[3] === 'markdown' ? toMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  if (!report.complete) process.stderr.write('measurement-report: INCOMPLETE capture; missing observations are not zero or success.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { process.stderr.write(`measurement-report: ${error.message}\n`); process.exitCode = 1; }
}
