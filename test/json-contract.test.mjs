import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flake-ledger.mjs');

// These are the keys documented under "JSON contract" in README.md. A test
// that only checks the values it happens to read cannot catch a rename, so
// every payload is checked against an explicit key list. Additive fields are
// allowed: the contract only promises that these keys are present.
const SCAN_SCHEMA_VERSION = 1;
const EXPLAIN_SCHEMA_VERSION = 1;

const SCAN_TOP_LEVEL = [
  'schemaVersion',
  'tool',
  'version',
  'runsDir',
  'totals',
  'runs',
  'tests',
  'warnings',
  'suite',
];

const EXPLAIN_TOP_LEVEL = [
  'schemaVersion',
  'tool',
  'version',
  'runsDir',
  'test',
  'warnings',
];

const TOTALS_KEYS = ['files', 'runs', 'tests', 'attempts'];

const RUN_KEYS = [
  'id',
  'path',
  'startedAt',
  'files',
  'fileCount',
  'testCount',
  'attemptCount',
  'unstableTests',
  'flakyRate',
  'newFlakes',
];

const TEST_KEYS = [
  'id',
  'classname',
  'name',
  'runs',
  'attempts',
  'passedAttempts',
  'failedAttempts',
  'errorAttempts',
  'skippedAttempts',
  'passedRuns',
  'failedRuns',
  'errorRuns',
  'skippedRuns',
  'passedOnRetryRuns',
  'failedOnRetryRuns',
  'unstableRuns',
  'eligibleRuns',
  'unstableRate',
  'score',
  'classification',
  'trend',
  'trendSince',
  'timeline',
  'runIds',
];

const TIMELINE_KEYS = [
  'runId',
  'runPath',
  'id',
  'classname',
  'name',
  'outcome',
  'status',
  'attemptCount',
  'attempts',
];

const ATTEMPT_KEYS = [
  'classname',
  'name',
  'id',
  'status',
  'message',
  'type',
  'details',
  'time',
  'retried',
  'file',
  'line',
  'source',
  'suite',
  'suiteKey',
];

const SUITE_KEYS = ['trend', 'firstWindowRate', 'lastWindowRate'];

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'flake-ledger-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'runs');
  mkdirSync(runs, { recursive: true });
  return { runs };
}

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return file;
}

function junit(timestamp, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="com.example.ContractTest" timestamp="${timestamp}">
${body}
  </testsuite>
</testsuites>
`;
}

function testcase(classname, name, body = '') {
  return `    <testcase classname="${classname}" name="${name}">${body}</testcase>`;
}

function runCli(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

// A two-run timeline with one passed-on-retry test, one warning, and one
// stable test gives every documented object shape real content.
function writeContractFixture(runs) {
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      '2026-01-01T00:00:00Z',
      [
        testcase(
          'pkg.ContractTest',
          'eventually',
          '<flakyFailure message="first try failed" type="AssertionError"/>',
        ),
        testcase('pkg.ContractTest', 'stable'),
      ].join('\n'),
    ),
  );
  writeFile(
    runs,
    'run-2/results.xml',
    junit(
      '2026-01-02T00:00:00Z',
      [testcase('pkg.ContractTest', 'eventually'), testcase('pkg.ContractTest', 'stable')].join(
        '\n',
      ),
    ),
  );
  writeFile(runs, 'run-1/broken.xml', '<testsuite><testcase name="nope">');
}

function assertHasKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  assert.deepEqual(missing, [], `${label} is missing documented key(s): ${missing.join(', ')}`);
}

function findTest(result, id) {
  const found = result.tests.find((item) => item.id === id);
  assert.ok(found, `expected ${id} in ${result.tests.map((item) => item.id).join(', ')}`);
  return found;
}

test('scan --json matches the documented versioned contract', (t) => {
  const { runs } = fixture(t);
  writeContractFixture(runs);

  const run = runCli(['scan', runs, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);

  assert.equal(output.schemaVersion, SCAN_SCHEMA_VERSION);
  assert.equal(output.tool, 'flake-ledger');
  assert.equal(typeof output.version, 'string');
  assertHasKeys(output, SCAN_TOP_LEVEL, 'scan');
  assertHasKeys(output.totals, TOTALS_KEYS, 'scan.totals');
  assertHasKeys(output.runs[0], RUN_KEYS, 'scan.runs[0]');
  assertHasKeys(output.suite, SUITE_KEYS, 'scan.suite');

  const record = findTest(output, 'pkg.ContractTest::eventually');
  assertHasKeys(record, TEST_KEYS, 'scan.tests[0]');
  assertHasKeys(record.timeline[0], TIMELINE_KEYS, 'scan.tests[0].timeline[0]');
  for (const [index, attempt] of record.timeline[0].attempts.entries()) {
    assertHasKeys(attempt, ATTEMPT_KEYS, `scan.tests[0].timeline[0].attempts[${index}]`);
  }

  assert.equal(output.warnings.length, 1);
  assertHasKeys(output.warnings[0], ['file', 'message'], 'scan.warnings[0]');
  // runId appears when the warning belongs to a run; directory-level warnings
  // have no run to name, so the key is optional by contract.
  if (Object.hasOwn(output.warnings[0], 'runId')) {
    assert.equal(typeof output.warnings[0].runId, 'string');
  }
});

test('explain --json matches the documented versioned contract', (t) => {
  const { runs } = fixture(t);
  writeContractFixture(runs);

  const run = runCli(['explain', runs, 'pkg.ContractTest::eventually', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);

  assert.equal(output.schemaVersion, EXPLAIN_SCHEMA_VERSION);
  assert.equal(output.tool, 'flake-ledger');
  assert.equal(typeof output.version, 'string');
  assertHasKeys(output, EXPLAIN_TOP_LEVEL, 'explain');
  assertHasKeys(output.test, TEST_KEYS, 'explain.test');
  assertHasKeys(output.test.timeline[0], TIMELINE_KEYS, 'explain.test.timeline[0]');
  for (const [index, attempt] of output.test.timeline[0].attempts.entries()) {
    assertHasKeys(attempt, ATTEMPT_KEYS, `explain.test.timeline[0].attempts[${index}]`);
  }
});

test('scan and explain share one schemaVersion and one test record shape', (t) => {
  const { runs } = fixture(t);
  writeContractFixture(runs);

  const scanRun = runCli(['scan', runs, '--json']);
  assert.equal(scanRun.status, 0, scanRun.stderr);
  const scan = JSON.parse(scanRun.stdout);

  const explainRun = runCli(['explain', runs, 'pkg.ContractTest::eventually', '--json']);
  assert.equal(explainRun.status, 0, explainRun.stderr);
  const explain = JSON.parse(explainRun.stdout);

  assert.equal(scan.schemaVersion, explain.schemaVersion);
  assert.equal(scan.tool, explain.tool);

  const scanTest = findTest(scan, 'pkg.ContractTest::eventually');
  assert.deepEqual(Object.keys(explain.test).sort(), Object.keys(scanTest).sort());
});
