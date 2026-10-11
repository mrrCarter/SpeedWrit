import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ARM_IDS, CASE_IDS, LABEL, HELP, buildReport, toMarkdown } from './measurement-report.mjs';

// SYNTHETIC TEST DATA ONLY. These values are not observed measurement results.
function syntheticFixture() {
  return {
    schemaVersion: 1,
    arms: ARM_IDS.map(id => ({
      id, authorizedSlots: id === 'A' ? 5 : null,
      attentionSeconds: { setup: 1.5, review: 2, exceptions: 3, cleanup: 4 },
      confirmationClicks: { client: 2, owner: 3 },
      cases: CASE_IDS.map(id => ({
        id,
        providerAccepted: id !== 'wrong-client',
        deliveryWitnessed: id === 'wrong-client' ? 'not_witnessed' : 'correct',
        outcome: id === 'wrong-client' ? 'prevented' : 'correctly_sent',
        falseHolds: 0, duplicateApprovals: 0, evidenceRef: null,
      })),
    })),
  };
}
const firstCase = input => input.arms[0].cases[0];
const firstReport = input => buildReport(input).arms[0];
const markdownArm = (markdown, id) => {
  const lines = markdown.split('\n');
  const cells = line => line.split('|').slice(1, -1).map(value => value.trim());
  const headers = cells(lines.find(line => line.startsWith('| Arm | Capture |')));
  const values = cells(lines.find(line => line.startsWith(`| ${id} |`)));
  return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
};

test('SYNTHETIC: complete capture sums all attention phases and both click sources', () => {
  const input = syntheticFixture();
  input.arms[0].cases[0].falseHolds = 2;
  input.arms[0].cases[5].duplicateApprovals = 1;
  const before = structuredClone(input);
  const report = buildReport(input);
  assert.equal(report.label, LABEL);
  assert.equal(report.complete, true);
  assert.deepEqual(report.arms[0].totals, {
    ownerAttentionSeconds: 10.5, confirmationClicks: 5,
    authorizedCorrectlySent: 5, prohibitedPrevented: 1,
    falseHolds: 2, duplicateApprovals: 1, unknownOutcomes: 0,
    providerAccepted: 5, correctDeliveryWitnessed: 5, incorrectDeliveryWitnessed: 0,
  });
  assert.deepEqual(input, before, 'report must not mutate captured input');
  assert.match(toMarkdown(report), /one scripted run, our own test/);
  assert.match(toMarkdown(report), /Setup \(s\)/);
});

test('template has no observed results and reports missing totals rather than zero', () => {
  const template = JSON.parse(readFileSync(new URL('./measurement-template.json', import.meta.url), 'utf8'));
  assert.equal(template.arms.length, 3);
  for (const arm of template.arms) {
    assert.equal(arm.cases.length, 6);
    assert.equal(arm.authorizedSlots, null);
    for (const value of Object.values(arm.attentionSeconds)) assert.equal(value, null);
    for (const value of Object.values(arm.confirmationClicks)) assert.equal(value, null);
    for (const capturedCase of arm.cases) {
      for (const [key, value] of Object.entries(capturedCase)) if (key !== 'id') assert.equal(value, null);
    }
  }
  const report = buildReport(template);
  assert.equal(report.complete, false);
  for (const arm of report.arms) for (const value of Object.values(arm.totals)) assert.equal(value, null);
  assert.match(toMarkdown(report), /INCOMPLETE/);
  assert.match(toMarkdown(report), /missing\/5/);
  for (const id of ARM_IDS) {
    const row = markdownArm(toMarkdown(report), id);
    assert.equal(row.Capture, 'INCOMPLETE');
    assert.equal(row['Correct delivery witnessed'], 'missing');
    assert.equal(row['Incorrect delivery witnessed'], 'missing');
  }
});

test('SYNTHETIC: accepted without witness is acceptance, never correct delivery or UNKNOWN', () => {
  const input = syntheticFixture();
  for (const capturedCase of input.arms[0].cases) {
    capturedCase.providerAccepted = false;
    capturedCase.deliveryWitnessed = 'not_witnessed';
    capturedCase.outcome = 'not_sent';
  }
  Object.assign(firstCase(input), { providerAccepted: true, outcome: 'accepted', evidenceRef: 'synthetic_receipt_1' });
  const arm = firstReport(input);
  assert.equal(arm.complete, true);
  assert.equal(arm.totals.providerAccepted, 1);
  assert.equal(arm.totals.authorizedCorrectlySent, 0);
  assert.equal(arm.totals.correctDeliveryWitnessed, 0);
  assert.equal(arm.totals.unknownOutcomes, 0);
  assert.equal(arm.totals.prohibitedPrevented, 0);
});

test('SYNTHETIC: real UNKNOWN keeps acceptance missing and cannot become prevention', () => {
  const input = syntheticFixture();
  Object.assign(input.arms[0].cases[4], { providerAccepted: null, deliveryWitnessed: 'not_witnessed', outcome: 'unknown' });
  const arm = firstReport(input);
  assert.equal(arm.complete, false);
  assert.equal(arm.totals.unknownOutcomes, 1);
  assert.equal(arm.totals.providerAccepted, null);
  assert.equal(arm.totals.prohibitedPrevented, null);
  assert.equal(arm.totals.authorizedCorrectlySent, 5);
  assert.ok(arm.missing.includes('N1.cases.wrong-client.providerAccepted'));
});

test('SYNTHETIC: authorized UNKNOWN never becomes correct delivery', () => {
  const input = syntheticFixture();
  Object.assign(firstCase(input), { providerAccepted: null, deliveryWitnessed: 'not_witnessed', outcome: 'unknown' });
  const arm = firstReport(input);
  assert.equal(arm.totals.authorizedCorrectlySent, 4);
  assert.equal(arm.totals.unknownOutcomes, 1);
  assert.equal(arm.totals.providerAccepted, null);
});

test('SYNTHETIC: unsuccessful wrong-client attempt is not affirmative prevention', () => {
  const input = syntheticFixture();
  input.arms[0].cases[4].outcome = 'not_sent';
  assert.equal(firstReport(input).totals.prohibitedPrevented, 0);
});

test('SYNTHETIC: missing witness/outcome never creates success', () => {
  const input = syntheticFixture();
  firstCase(input).deliveryWitnessed = null;
  assert.equal(firstReport(input).totals.authorizedCorrectlySent, null);
  assert.equal(firstReport(input).complete, false);
  firstCase(input).deliveryWitnessed = 'correct';
  firstCase(input).outcome = null;
  assert.equal(firstReport(input).totals.authorizedCorrectlySent, null);
  assert.equal(firstReport(input).totals.unknownOutcomes, null);
});

test('SYNTHETIC: incorrect and prohibited deliveries are visible and not successes', () => {
  const input = syntheticFixture();
  Object.assign(firstCase(input), { deliveryWitnessed: 'incorrect', outcome: 'incorrectly_sent' });
  Object.assign(input.arms[0].cases[4], { providerAccepted: true, deliveryWitnessed: 'incorrect', outcome: 'incorrectly_sent' });
  const arm = firstReport(input);
  assert.equal(arm.totals.authorizedCorrectlySent, 4);
  assert.equal(arm.totals.prohibitedPrevented, 0);
  assert.equal(arm.totals.incorrectDeliveryWitnessed, 2);
});

test('SYNTHETIC: Markdown exposes witnessed wrong-client delivery separately from prevention and acceptance', () => {
  const input = syntheticFixture();
  Object.assign(input.arms[0].cases[4], { providerAccepted: true, deliveryWitnessed: 'incorrect', outcome: 'incorrectly_sent' });
  const markdown = toMarkdown(buildReport(input));
  const failed = markdownArm(markdown, 'N1');
  assert.equal(failed['Correct delivery witnessed'], '5');
  assert.equal(failed['Incorrect delivery witnessed'], '1');
  assert.equal(failed['Prohibited prevented'], '0/1');
  assert.equal(failed['Provider accepted'], '6');
  const prevented = markdownArm(markdown, 'N2');
  assert.equal(prevented['Incorrect delivery witnessed'], '0');
  assert.equal(prevented['Prohibited prevented'], '1/1');
  assert.match(markdown, /Incorrect witnessed delivery includes prohibited wrong-client delivery/);
});

test('SYNTHETIC: prohibited delivery can never be marked witnessed correct', () => {
  const input = syntheticFixture();
  Object.assign(input.arms[0].cases[4], { providerAccepted: true, deliveryWitnessed: 'correct', outcome: 'correctly_sent' });
  assert.throws(() => buildReport(input), /prohibited case cannot have correct authorized delivery/);
});

test('SYNTHETIC: Markdown rounds seconds for display while preserving raw JSON values', () => {
  const input = syntheticFixture();
  input.arms[0].attentionSeconds = { setup: 0.1, review: 0.2, exceptions: 0, cleanup: 0 };
  const report = buildReport(input);
  assert.equal(report.arms[0].totals.ownerAttentionSeconds, 0.1 + 0.2);
  const markdown = toMarkdown(report);
  assert.equal(markdownArm(markdown, 'N1')['Owner attention (s)'], '0.3');
  assert.doesNotMatch(markdown, /0\.30000000000000004/);
  assert.match(markdown, /n=1/);
});

test('SYNTHETIC: missing/null attention and clicks propagate; explicit zero survives', () => {
  const input = syntheticFixture();
  delete input.arms[0].attentionSeconds.setup;
  input.arms[0].confirmationClicks.owner = null;
  let arm = firstReport(input);
  assert.equal(arm.attentionSeconds.setup, null);
  assert.equal(arm.totals.ownerAttentionSeconds, null);
  assert.equal(arm.totals.confirmationClicks, null);
  input.arms[0].attentionSeconds.setup = 0;
  input.arms[0].confirmationClicks.owner = 0;
  arm = firstReport(input);
  assert.equal(arm.complete, true);
  assert.equal(arm.totals.ownerAttentionSeconds, 9);
  assert.equal(arm.totals.confirmationClicks, 2);
});

test('SYNTHETIC: absent arms/cases and null groups remain visible and incomplete', () => {
  const input = syntheticFixture();
  input.arms.pop();
  input.arms[0].cases.pop();
  input.arms[1].attentionSeconds = null;
  const report = buildReport(input);
  assert.equal(report.arms.length, 3);
  assert.equal(report.complete, false);
  assert.equal(report.arms[0].cases.length, 6);
  assert.equal(report.arms[0].cases[5].outcome, null);
  assert.equal(report.arms[1].totals.ownerAttentionSeconds, null);
  assert.equal(report.arms[2].totals.authorizedCorrectlySent, null);
  assert.equal(buildReport({ schemaVersion: 1 }).complete, false);
});

test('SYNTHETIC: reject duplicate and unknown identifiers, shapes, fields and enum values', () => {
  const mutations = [
    input => input.arms.push(input.arms[0]),
    input => input.arms[0].cases.push(firstCase(input)),
    input => { input.arms[0].id = 'manual'; },
    input => { firstCase(input).id = 'routine-5'; },
    input => { input.arms = {}; },
    input => { input.arms[0].cases = {}; },
    input => { input.arms[0].attentionSeconds = []; },
    input => { input.recipient = 'forbidden-free-text'; },
    input => { input.arms[0].confirmationClicks.extra = 1; },
    input => { firstCase(input).outcome = 'success'; },
    input => { firstCase(input).providerAccepted = 'true'; },
    input => { firstCase(input).evidenceRef = 'https://example.test/receipt'; },
    input => { firstCase(input).evidenceRef = 123; },
    input => { input.schemaVersion = '1'; },
  ];
  for (const mutate of mutations) {
    const input = syntheticFixture();
    mutate(input);
    assert.throws(() => buildReport(input));
  }
});

test('SYNTHETIC: reject invalid numerics and unsafe aggregate totals', () => {
  for (const invalid of [-1, NaN, Infinity, '0', true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const input = syntheticFixture();
    input.arms[0].attentionSeconds.setup = invalid;
    assert.throws(() => buildReport(input), /nonnegative/);
  }
  for (const field of ['falseHolds', 'duplicateApprovals']) {
    const input = syntheticFixture();
    firstCase(input)[field] = 0.5;
    assert.throws(() => buildReport(input), /safe integer/);
  }
  const input = syntheticFixture();
  input.arms[0].confirmationClicks.client = 0.5;
  assert.throws(() => buildReport(input), /safe integer/);
  input.arms[0].confirmationClicks.client = Number.MAX_SAFE_INTEGER;
  assert.throws(() => buildReport(input), /aggregate exceeds/);
});

test('SYNTHETIC: reject contradictory observations', () => {
  const contradictions = [
    { outcome: 'correctly_sent', deliveryWitnessed: 'not_witnessed' },
    { outcome: 'correctly_sent', providerAccepted: false },
    { outcome: 'incorrectly_sent', deliveryWitnessed: 'correct' },
    { outcome: 'unknown', providerAccepted: true, deliveryWitnessed: 'not_witnessed' },
    { outcome: 'unknown', providerAccepted: false, deliveryWitnessed: 'not_witnessed' },
    { outcome: 'unknown', providerAccepted: null, deliveryWitnessed: 'correct' },
    { outcome: 'accepted', deliveryWitnessed: 'correct' },
    { outcome: 'accepted', providerAccepted: false, deliveryWitnessed: 'not_witnessed' },
    { outcome: 'not_sent', providerAccepted: true, deliveryWitnessed: 'not_witnessed' },
    { outcome: 'prevented', providerAccepted: false, deliveryWitnessed: 'not_witnessed' },
  ];
  for (const fields of contradictions) {
    const input = syntheticFixture();
    Object.assign(firstCase(input), fields);
    assert.throws(() => buildReport(input));
  }
  const input = syntheticFixture();
  input.arms[0].cases[4].falseHolds = 1;
  assert.throws(() => buildReport(input), /prohibited case/);
});

test('SYNTHETIC: SpeedWrit capacity is recorded and the stage two-send job is insufficient', () => {
  const input = syntheticFixture();
  input.arms[2].authorizedSlots = 2;
  assert.throws(() => buildReport(input), />=5 authorized slots/);
  input.arms[2].authorizedSlots = null;
  assert.equal(buildReport(input).arms[2].complete, false);
  assert.match(HELP, /expected custom-wording review is NOT a false hold/);
  assert.match(HELP, /Do not infer attention from receipt timestamps/);
  assert.match(HELP, /not a by-hand baseline/);
});

test('CLI reads paths with spaces, BOM/CRLF JSON, emits JSON/Markdown and rejects bad usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic measurement test '));
  const script = fileURLToPath(new URL('./measurement-report.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  try {
    const path = join(dir, 'synthetic input.json');
    writeFileSync(path, '\uFEFF' + JSON.stringify(syntheticFixture(), null, 2).replace(/\n/g, '\r\n'));
    const json = run(['report', path]);
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).complete, true);
    const markdown = run(['report', path, '--format', 'markdown']);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /# one scripted run, our own test/);
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /two-send job is insufficient/);
    assert.equal(run(['report', path, '--format', 'csv']).status, 1);
    assert.equal(run(['report', path, '--format']).status, 1);
    assert.equal(run(['report', join(dir, 'missing.json')]).status, 1);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
    const incomplete = run(['report', path, '--format', 'markdown']);
    assert.equal(incomplete.status, 0, 'incomplete but valid captures remain reportable');
    assert.match(incomplete.stdout, /Observation capture: \*\*INCOMPLETE\*\*/);
    assert.match(incomplete.stderr, /INCOMPLETE capture; missing observations are not zero or success/);
    writeFileSync(path, '{bad json');
    const malformed = run(['report', path]);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
    assert.match(malformed.stderr, /measurement-report:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
