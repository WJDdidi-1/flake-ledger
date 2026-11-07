import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flake-ledger.mjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'flake-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'runs');
  mkdirSync(runs, { recursive: true });
  return { root, runs };
}

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return file;
}

function junit(body, suiteName = 'com.example.FooTest') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${suiteName}">
${body}
  </testsuite>
</testsuites>
`;
}

function testcase(classname, name, body = '') {
  return `    <testcase classname="${classname}" name="${name}">${body}</testcase>`;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function scanJson(runs, extraArgs = []) {
  const result = runCli(['scan', runs, '--json', ...extraArgs]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function byId(result, id) {
  const found = result.tests.find((item) => item.id === id);
  assert.ok(found, `expected ${id} in ${result.tests.map((item) => item.id).join(', ')}`);
  return found;
}

test('scan recursively finds JUnit XML in nested directories', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-a/deep/results.xml',
    junit(testcase('pkg.DeepTest', 'works')),
  );
  writeFile(runs, 'run-a/notes.txt', 'not an XML report');

  const result = scanJson(runs);
  assert.equal(result.totals.files, 1);
  assert.equal(result.totals.runs, 1);
  assert.equal(result.totals.tests, 1);
  assert.equal(result.runs[0].id, 'run-a');
  assert.equal(result.runs[0].fileCount, 1);
  assert.equal(result.tests[0].id, 'pkg.DeepTest::works');
  assert.equal(result.tests[0].classification, 'stable');
});

test('scan merges sharded files belonging to the same run', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/shard-1.xml',
    junit(
      [
        testcase('com.example.FooTest', 'flaky', '<failure message="first attempt"/>'),
        testcase('com.example.FooTest', 'stable'),
      ].join('\n'),
    ),
  );
  writeFile(
    runs,
    'run-1/nested/shard-2.xml',
    junit(
      [
        testcase('com.example.FooTest', 'flaky'),
        testcase('com.example.FooTest', 'red', '<failure message="always"/>'),
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  assert.equal(result.totals.files, 2);
  assert.equal(result.totals.runs, 1);
  assert.equal(result.totals.tests, 3);
  assert.equal(result.runs[0].fileCount, 2);

  const flaky = byId(result, 'com.example.FooTest::flaky');
  assert.equal(flaky.runs, 1);
  assert.equal(flaky.attempts, 2);
  assert.equal(flaky.classification, 'passed-on-retry');
  assert.deepEqual(
    flaky.timeline[0].attempts.map((attempt) => attempt.status),
    ['failed', 'passed'],
  );
  assert.equal(byId(result, 'com.example.FooTest::red').classification, 'always-failing');
  assert.equal(byId(result, 'com.example.FooTest::stable').classification, 'stable');
});

test('scan collapses repeated attempts into one record per test id', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('com.example.FooTest', 'retried', '<failure message="once"/>'),
        testcase('com.example.FooTest', 'retried'),
        testcase('com.example.FooTest', 'retried'),
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  assert.equal(result.totals.tests, 1);
  const record = byId(result, 'com.example.FooTest::retried');
  assert.equal(record.runs, 1);
  assert.equal(record.attempts, 3);
  assert.equal(record.failedAttempts, 1);
  assert.equal(record.passedAttempts, 2);
  assert.equal(record.passedOnRetryRuns, 1);
  assert.equal(record.classification, 'passed-on-retry');
  assert.equal(record.timeline.length, 1);
});

test('scan keeps one record per classname::name across separate runs', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(testcase('com.example.FooTest', 'unstable', '<failure message="red"/>')),
  );
  writeFile(
    runs,
    'run-2/results.xml',
    junit(
      [testcase('com.example.FooTest', 'unstable'), testcase('com.example.FooTest', 'fine')].join('\n'),
    ),
  );

  const result = scanJson(runs);
  assert.equal(result.totals.runs, 2);
  assert.equal(result.totals.tests, 2);

  const unstable = byId(result, 'com.example.FooTest::unstable');
  assert.equal(unstable.runs, 2);
  assert.equal(unstable.failedRuns, 1);
  assert.equal(unstable.passedRuns, 1);
  assert.equal(unstable.classification, 'cross-run flake');
  assert.deepEqual(unstable.runIds, ['run-1', 'run-2']);

  const fine = byId(result, 'com.example.FooTest::fine');
  assert.equal(fine.runs, 1);
  assert.equal(fine.classification, 'stable');
});

test('flat shard names and shard-named run directories merge', (t) => {
  const { runs } = fixture(t);
  writeFile(runs, 'shard-1.xml', junit(testcase('pkg.SharedTest', 'a', '<failure/>')));
  writeFile(runs, 'shard-2.xml', junit(testcase('pkg.SharedTest', 'a')));
  writeFile(runs, 'run-9.xml', junit(testcase('pkg.NineTest', 'b')));
  writeFile(runs, 'run-10.xml', junit(testcase('pkg.TenTest', 'c')));
  writeFile(
    runs,
    'run-7-shard-1/results.xml',
    junit(testcase('pkg.SevenTest', 'd', '<failure/>')),
  );
  writeFile(runs, 'run-7-shard-2/results.xml', junit(testcase('pkg.SevenTest', 'd')));

  const result = scanJson(runs);
  assert.equal(result.totals.files, 6);
  assert.equal(result.totals.runs, 4);
  const shared = byId(result, 'pkg.SharedTest::a');
  assert.equal(shared.runs, 1);
  assert.equal(shared.attempts, 2);
  assert.equal(shared.classification, 'passed-on-retry');

  const seven = byId(result, 'pkg.SevenTest::d');
  assert.equal(seven.runs, 1);
  assert.equal(seven.attempts, 2);
  assert.equal(seven.classification, 'passed-on-retry');

  assert.deepEqual(
    result.runs.map((run) => run.id).sort(),
    ['root', 'run-7', 'run-10', 'run-9'].sort(),
  );
});

test('Surefire flakyFailure becomes a failed attempt followed by a pass', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase(
          'com.example.FooTest',
          'eventuallyGreen',
          '<flakyFailure message="first &amp; failed" type="AssertionError"><stackTrace>trace</stackTrace></flakyFailure>',
        ),
        '    <testcase classname="com.example.FooTest" name="retryAttribute" retry="1"/>',
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  const record = byId(result, 'com.example.FooTest::eventuallyGreen');
  assert.equal(record.attempts, 2);
  assert.equal(record.passedOnRetryRuns, 1);
  assert.equal(record.classification, 'passed-on-retry');
  const attempts = record.timeline[0].attempts;
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ['failed', 'passed'],
  );
  assert.equal(attempts[0].message, 'first & failed');
  assert.match(attempts[0].details, /trace/);

  const attributeRetry = byId(result, 'com.example.FooTest::retryAttribute');
  assert.equal(attributeRetry.classification, 'passed-on-retry');
  assert.equal(attributeRetry.attempts, 1);
  assert.equal(attributeRetry.timeline[0].attempts[0].retried, true);
});

test('Surefire rerunFailure is recorded as a failure', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      testcase(
        'com.example.FooTest',
        'stillRed',
        '<rerunFailure message="failed on the retry" type="AssertionError"/>',
      ),
    ),
  );

  const result = scanJson(runs);
  const record = byId(result, 'com.example.FooTest::stillRed');
  assert.equal(record.attempts, 1);
  assert.equal(record.failedRuns, 1);
  assert.equal(record.classification, 'always-failing');
  assert.equal(record.timeline[0].outcome, 'failed');
});

test('scan handles entities, CDATA, and skipped tests', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('pkg.MixedTest', 'passed'),
        testcase('pkg.MixedTest', 'skipped', '<skipped message="not today &amp; tomorrow"/>'),
        testcase(
          'pkg.MixedTest',
          'failed',
          '<failure message="bad &lt;thing&gt;"><![CDATA[<stack>line</stack>]]></failure>',
        ),
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  assert.equal(result.totals.tests, 3);
  const skipped = byId(result, 'pkg.MixedTest::skipped');
  assert.equal(skipped.classification, 'skipped');
  assert.equal(skipped.timeline[0].attempts[0].message, 'not today & tomorrow');

  const failed = byId(result, 'pkg.MixedTest::failed');
  assert.equal(failed.timeline[0].attempts[0].message, 'bad <thing>');
  assert.match(failed.timeline[0].attempts[0].details, /<stack>line<\/stack>/);
});

test('a malformed XML file warns and does not hide healthy files', (t) => {
  const { runs } = fixture(t);
  writeFile(runs, 'run-1/a-broken.xml', '<testsuite><testcase name="nope">');
  writeFile(runs, 'run-1/b-good.xml', junit(testcase('pkg.GoodTest', 'ok')));

  const result = runCli(['scan', runs, '--json']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /cannot parse JUnit XML/);
  const output = JSON.parse(result.stdout);
  assert.equal(output.warnings.length, 1);
  assert.match(output.warnings[0].message, /a-broken\.xml/);
  assert.equal(output.totals.tests, 1);
  assert.equal(byId(output, 'pkg.GoodTest::ok').classification, 'stable');
});

test('an empty runs directory produces empty totals and a clear message', (t) => {
  const { runs } = fixture(t);
  const json = scanJson(runs);
  assert.deepEqual(json.totals, { files: 0, runs: 0, tests: 0, attempts: 0 });
  assert.deepEqual(json.tests, []);

  const text = runCli(['scan', runs]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /No JUnit XML files found/);
});

test('--top limits displayed and JSON tests but not totals', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [testcase('pkg.TopTest', 'flaky', '<failure/>'), testcase('pkg.TopTest', 'stable')].join('\n'),
    ),
  );
  writeFile(runs, 'run-2/results.xml', junit(testcase('pkg.TopTest', 'flaky')));

  const result = scanJson(runs, ['--top', '1']);
  assert.equal(result.tests.length, 1);
  assert.equal(result.totals.tests, 2);
  assert.equal(result.tests[0].id, 'pkg.TopTest::flaky');
});

test('explain prints the per-run timeline with paths and failure messages', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/shard-1.xml',
    junit(testcase('pkg.TimelineTest', 'eventually', '<failure message="first try failed"/>')),
  );
  writeFile(runs, 'run-1/shard-2.xml', junit(testcase('pkg.TimelineTest', 'eventually')));

  const result = runCli(['explain', runs, 'pkg.TimelineTest::eventually']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pkg\.TimelineTest::eventually/);
  assert.match(result.stdout, /passed-on-retry/);
  assert.match(result.stdout, /shard-1\.xml/);
  assert.match(result.stdout, /shard-2\.xml/);
  assert.match(result.stdout, /first try failed/);
  assert.ok(
    result.stdout.indexOf('shard-1.xml') < result.stdout.indexOf('shard-2.xml'),
    'the failed attempt should be printed before the retry pass',
  );
});

test('--quarantine writes flaky ids only', (t) => {
  const { root, runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('pkg.QTest', 'stable'),
        testcase('pkg.QTest', 'flaky', '<failure/>'),
        testcase('pkg.QTest', 'flaky'),
        testcase('pkg.QTest', 'alwaysRed', '<failure/>'),
      ].join('\n'),
    ),
  );
  const quarantine = path.join(root, 'quarantine.txt');

  const result = runCli(['scan', runs, '--quarantine', quarantine]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /wrote 1 flaky test id/);
  assert.equal(readFileSync(quarantine, 'utf8'), 'pkg.QTest::flaky\n');
});

test('--fail-on exits 1 only when a flaky test crosses the threshold', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [testcase('pkg.CiTest', 'flaky', '<failure/>'), testcase('pkg.CiTest', 'flaky')].join('\n'),
    ),
  );
  writeFile(runs, 'run-2/results.xml', junit(testcase('pkg.CiTest', 'flaky')));

  const over = runCli(['scan', runs, '--fail-on', '0.4', '--min-runs', '2']);
  assert.equal(over.status, 1, over.stderr);
  assert.match(over.stderr, /pkg\.CiTest::flaky/);

  const under = runCli(['scan', runs, '--fail-on', '0.6', '--min-runs', '2']);
  assert.equal(under.status, 0, under.stderr);
});

test('scan of a missing runs directory fails clearly', (t) => {
  const { root } = fixture(t);
  const missing = path.join(root, 'does-not-exist');
  const result = runCli(['scan', missing]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read runs directory/);
});
