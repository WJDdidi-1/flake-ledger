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

test('scan classifies cross-run flake, passed-on-retry, always-failing, and stable', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('pkg.MatrixTest', 'stable'),
        testcase('pkg.MatrixTest', 'alwaysRed', '<failure message="red"/>'),
        testcase('pkg.MatrixTest', 'crossRun', '<failure message="red once"/>'),
        testcase('pkg.MatrixTest', 'retryAttribute', '<failure message="earlier"/>'),
        '    <testcase classname="pkg.MatrixTest" name="retriesAttribute" retries="2"/>',
        testcase('pkg.MatrixTest', 'repeated', '<failure message="earlier"/>'),
        testcase('pkg.MatrixTest', 'repeated'),
      ].join('\n'),
    ),
  );
  writeFile(
    runs,
    'run-2/results.xml',
    junit(
      [
        testcase('pkg.MatrixTest', 'stable'),
        testcase('pkg.MatrixTest', 'alwaysRed', '<failure message="red again"/>'),
        testcase('pkg.MatrixTest', 'crossRun'),
        testcase('pkg.MatrixTest', 'retriesAttribute'),
        testcase('pkg.MatrixTest', 'repeated'),
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  assert.equal(byId(result, 'pkg.MatrixTest::stable').classification, 'stable');
  assert.equal(byId(result, 'pkg.MatrixTest::alwaysRed').classification, 'always-failing');
  assert.equal(byId(result, 'pkg.MatrixTest::crossRun').classification, 'cross-run flake');
  assert.equal(byId(result, 'pkg.MatrixTest::retriesAttribute').classification, 'passed-on-retry');
  assert.equal(byId(result, 'pkg.MatrixTest::repeated').classification, 'passed-on-retry');
  assert.equal(byId(result, 'pkg.MatrixTest::retryAttribute').classification, 'always-failing');
});

test('rerun aliases and an explicit pass after rerunFailure count as passed-on-retry', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        '    <testcase classname="pkg.RetryTest" name="retries" retries="2"/>',
        '    <testcase classname="pkg.RetryTest" name="rerun" rerun="1"/>',
        '    <testcase classname="pkg.RetryTest" name="declaredPass" status="passed">' +
          '<rerunFailure message="first attempt" type="AssertionError"/></testcase>',
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  for (const name of ['retries', 'rerun', 'declaredPass']) {
    const record = byId(result, `pkg.RetryTest::${name}`);
    assert.equal(record.classification, 'passed-on-retry', name);
    assert.equal(record.passedOnRetryRuns, 1, name);
  }

  const declaredPass = byId(result, 'pkg.RetryTest::declaredPass');
  assert.equal(declaredPass.attempts, 2);
  assert.deepEqual(
    declaredPass.timeline[0].attempts.map((attempt) => attempt.status),
    ['failed', 'passed'],
  );
  assert.equal(declaredPass.timeline[0].attempts[0].message, 'first attempt');
  assert.equal(declaredPass.timeline[0].attempts[1].retried, true);
});

test('terminal table is ranked by the Wilson lower bound, not the raw rate', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 10; run += 1) {
    const body = [];
    body.push(
      run <= 5
        ? testcase('pkg.WilsonTest', 'moreEvidence', '<failure/>')
        : testcase('pkg.WilsonTest', 'moreEvidence'),
    );
    if (run === 1) body.push(testcase('pkg.WilsonTest', 'lessEvidence', '<failure/>'));
    if (run === 2) body.push(testcase('pkg.WilsonTest', 'lessEvidence'));
    writeFile(runs, `run-${String(run).padStart(2, '0')}/results.xml`, junit(body.join('\n')));
  }

  const json = scanJson(runs);
  const more = byId(json, 'pkg.WilsonTest::moreEvidence');
  const less = byId(json, 'pkg.WilsonTest::lessEvidence');
  assert.equal(more.unstableRate, 0.5);
  assert.equal(less.unstableRate, 0.5);
  assert.ok(more.score > less.score, `${more.score} should beat ${less.score}`);
  assert.ok(more.score > 0 && more.score < 1);

  const text = runCli(['scan', runs]);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trim().split('\n');
  assert.match(lines[0], /SCORE/);
  const moreIndex = lines.findIndex((line) => line.includes('moreEvidence'));
  const lessIndex = lines.findIndex((line) => line.includes('lessEvidence'));
  assert.ok(moreIndex > 0 && lessIndex > 0);
  assert.ok(moreIndex < lessIndex, 'the test with more evidence must rank first');
  assert.match(text.stdout, /10 runs, 2 tests, 12 attempts, 10 XML files\./);
});

test('--top truncates the printed table and says how many tests were hidden', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('pkg.TopTableTest', 'flaky', '<failure/>'),
        testcase('pkg.TopTableTest', 'flaky'),
        testcase('pkg.TopTableTest', 'stable'),
      ].join('\n'),
    ),
  );

  const text = runCli(['scan', runs, '--top', '1']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /pkg\.TopTableTest::flaky/);
  assert.doesNotMatch(text.stdout, /pkg\.TopTableTest::stable/);
  assert.match(text.stdout, /showing 1 of 2 tests/);
});

test('explain --json exposes the per-run attempts for machines', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      testcase(
        'pkg.TimelineJsonTest',
        'eventually',
        '<flakyFailure message="first try&amp;failed" type="AssertionError"/>',
      ),
    ),
  );

  const result = runCli(['explain', runs, 'pkg.TimelineJsonTest::eventually', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.tool, 'flake-ledger');
  assert.equal(output.test.id, 'pkg.TimelineJsonTest::eventually');
  assert.equal(output.test.classification, 'passed-on-retry');
  assert.equal(output.test.timeline.length, 1);
  assert.deepEqual(
    output.test.timeline[0].attempts.map((attempt) => attempt.status),
    ['failed', 'passed'],
  );
  assert.equal(output.test.timeline[0].attempts[0].message, 'first try&failed');
});

test('a pass followed by a final failure is classified failed-on-retry', (t) => {
  const { runs } = fixture(t);
  writeFile(
    runs,
    'run-1/results.xml',
    junit(
      [
        testcase('pkg.RetryOutcomeTest', 'regressed'),
        testcase('pkg.RetryOutcomeTest', 'regressed', '<failure message="second attempt failed"/>'),
      ].join('\n'),
    ),
  );

  const result = scanJson(runs);
  const record = byId(result, 'pkg.RetryOutcomeTest::regressed');
  assert.equal(record.classification, 'failed-on-retry');
  assert.equal(record.failedOnRetryRuns, 1);
  assert.equal(record.attempts, 2);
  assert.deepEqual(
    record.timeline[0].attempts.map((attempt) => attempt.status),
    ['passed', 'failed'],
  );
});

test('--group-by file makes every XML document its own run', (t) => {
  const { runs } = fixture(t);
  writeFile(runs, 'run-1/shard-a.xml', junit(testcase('pkg.GroupTest', 'a')));
  writeFile(runs, 'run-1/shard-b.xml', junit(testcase('pkg.GroupTest', 'b')));

  const auto = scanJson(runs);
  assert.equal(auto.totals.runs, 1);
  assert.equal(auto.totals.tests, 2);

  const perFile = scanJson(runs, ['--group-by', 'file']);
  assert.equal(perFile.totals.runs, 2);
  assert.equal(perFile.totals.tests, 2);
  assert.deepEqual(perFile.runs.map((run) => run.id).sort(), ['shard-a', 'shard-b']);
});

test('--group-by parent groups by immediate directory', (t) => {
  const { runs } = fixture(t);
  writeFile(runs, 'run-1/results.xml', junit(testcase('pkg.ParentTest', 'a')));
  writeFile(runs, 'run-1/nested/results.xml', junit(testcase('pkg.ParentTest', 'a')));

  const auto = scanJson(runs);
  assert.equal(auto.totals.runs, 1);
  assert.equal(byId(auto, 'pkg.ParentTest::a').attempts, 2);

  const byParent = scanJson(runs, ['--group-by', 'parent']);
  assert.equal(byParent.totals.runs, 2);
  assert.equal(byId(byParent, 'pkg.ParentTest::a').attempts, 2);
});

test('--group-by run merges one gh run download artifact tree into one run', (t) => {
  const { runs } = fixture(t);
  // `gh run download <id> --dir runs` produces one directory per artifact.
  // These artifact names do not carry the run id, so the user names the run.
  writeFile(
    runs,
    'junit-results-1/results.xml',
    junit(
      [
        testcase('pkg.ArtifactTest', 'flaky', '<failure message="first artifact"/>'),
        testcase('pkg.ArtifactTest', 'stable'),
      ].join('\n'),
    ),
  );
  writeFile(
    runs,
    'junit-results-2/results.xml',
    junit(testcase('pkg.ArtifactTest', 'flaky')),
  );

  const auto = scanJson(runs);
  assert.equal(auto.totals.runs, 2, 'without the flag each artifact looks like its own run');

  const result = scanJson(runs, ['--group-by', 'run', '--run-id', '1234567890']);
  assert.equal(result.totals.files, 2);
  assert.equal(result.totals.runs, 1);
  assert.equal(result.runs[0].id, '1234567890');
  assert.equal(result.runs[0].fileCount, 2);

  const flaky = byId(result, 'pkg.ArtifactTest::flaky');
  assert.equal(flaky.runs, 1, 'both artifacts are shards of one run');
  assert.equal(flaky.attempts, 2);
  assert.equal(flaky.passedOnRetryRuns, 1);
  assert.equal(flaky.classification, 'passed-on-retry');
  assert.deepEqual(flaky.runIds, ['1234567890']);
});

test('scan auto-merges artifact directories that carry the same GitHub run id', (t) => {
  const { runs } = fixture(t);
  // GitHub artifact names often include ${{ github.run_id }} and a shard
  // index. Two directories from that download belong to one run without a flag.
  writeFile(
    runs,
    'junit-1234567890-1/results.xml',
    junit(testcase('pkg.EncodedRunTest', 'eventually', '<failure message="shard one"/>')),
  );
  writeFile(
    runs,
    'junit-1234567890-2/results.xml',
    junit(testcase('pkg.EncodedRunTest', 'eventually')),
  );

  const result = scanJson(runs);
  assert.equal(result.totals.files, 2);
  assert.equal(result.totals.runs, 1);
  assert.equal(result.runs[0].id, '1234567890');
  assert.equal(result.runs[0].fileCount, 2);

  const record = byId(result, 'pkg.EncodedRunTest::eventually');
  assert.equal(record.runs, 1);
  assert.equal(record.attempts, 2);
  assert.equal(record.classification, 'passed-on-retry');
  assert.deepEqual(record.runIds, ['1234567890']);
});

test('--run-id implies a single run and --group-by names supported modes', (t) => {
  const { runs } = fixture(t);
  writeFile(runs, 'junit-a/results.xml', junit(testcase('pkg.LabelTest', 'a')));
  writeFile(runs, 'junit-b/results.xml', junit(testcase('pkg.LabelTest', 'b')));

  const implied = scanJson(runs, ['--run-id', 'run-42']);
  assert.equal(implied.totals.runs, 1);
  assert.equal(implied.runs[0].id, 'run-42');

  const invalid = runCli(['scan', runs, '--group-by', 'artifact-tree']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /auto, file, parent, or run/);
});

test('pytest-rerunfailures repeated passing testcases are passed-on-retry', (t) => {
  const { runs } = fixture(t);
  // pytest-rerunfailures writes one <testcase> per attempt. When the retry
  // recovers the test, the XML contains the same passing testcase twice and
  // no <failure> element: the failure is only in the console output.
  const pytestReport = (timestamp) =>
    `<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2" time="0.018" timestamp="${timestamp}" hostname="runner"><testcase classname="test_real" name="test_retry_then_pass" time="0.000" /><testcase classname="test_real" name="test_retry_then_pass" time="0.000" /><testcase classname="test_real" name="test_stable" time="0.000" /></testsuite></testsuites>`;

  writeFile(runs, 'run-1/results.xml', pytestReport('2026-01-05T10:00:00+00:00'));
  writeFile(runs, 'run-2/results.xml', pytestReport('2026-01-05T10:10:00+00:00'));

  const result = scanJson(runs);
  const retried = byId(result, 'test_real::test_retry_then_pass');
  assert.equal(retried.runs, 2);
  assert.equal(retried.attempts, 4);
  assert.equal(retried.passedOnRetryRuns, 2);
  assert.equal(retried.unstableRuns, 2);
  assert.equal(retried.classification, 'passed-on-retry');
  assert.equal(retried.timeline[0].outcome, 'passed-on-retry');
  assert.deepEqual(
    retried.timeline[0].attempts.map((attempt) => attempt.status),
    ['passed', 'passed'],
  );

  const stable = byId(result, 'test_real::test_stable');
  assert.equal(stable.attempts, 2);
  assert.equal(stable.passedOnRetryRuns, 0);
  assert.equal(stable.classification, 'stable');
});

test('identical passes in separate Playwright project suites are not retries', (t) => {
  const { runs } = fixture(t);
  // Playwright writes one <testsuite> per project for the same spec file. The
  // same testcase in chromium and firefox is two executions of one test, not
  // a failed-then-passed retry, even though the classname/name are identical.
  writeFile(
    runs,
    'run-1/results.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites id="" name="" tests="2" failures="0" skipped="0" errors="0" time="0.2">
  <testsuite name="checkout.spec.ts" timestamp="2026-01-05T10:00:00.000Z" hostname="chromium" tests="1" failures="0" skipped="0" time="0.1" errors="0">
    <testcase name="adds item" classname="checkout.spec.ts" time="0.1"></testcase>
  </testsuite>
  <testsuite name="checkout.spec.ts" timestamp="2026-01-05T10:00:00.000Z" hostname="firefox" tests="1" failures="0" skipped="0" time="0.1" errors="0">
    <testcase name="adds item" classname="checkout.spec.ts" time="0.1"></testcase>
  </testsuite>
</testsuites>`,
  );

  const result = scanJson(runs);
  const record = byId(result, 'checkout.spec.ts::adds item');
  assert.equal(record.attempts, 2);
  assert.equal(record.passedOnRetryRuns, 0);
  assert.equal(record.unstableRuns, 0);
  assert.equal(record.classification, 'stable');
  assert.equal(record.timeline[0].outcome, 'passed');
});

test('scan marks new flakes apart from chronic ones in JSON, the table, and explain', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const newlyUnstable = run >= 4;
    const oldUnstable = run <= 2;
    const body = [
      testcase('pkg.TrendTest', 'newlyFlaky', newlyUnstable ? '<failure message="broke today"/>' : ''),
      testcase('pkg.TrendTest', 'chronic', '<failure message="still red"/>'),
      testcase('pkg.TrendTest', 'recovered', oldUnstable ? '<failure message="old"/>' : ''),
      testcase('pkg.TrendTest', 'stable'),
    ];
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const result = scanJson(runs);
  const newly = byId(result, 'pkg.TrendTest::newlyFlaky');
  assert.equal(newly.classification, 'cross-run flake');
  assert.equal(newly.trend, 'new');
  assert.equal(newly.trendSince, 'run-04');

  const chronic = byId(result, 'pkg.TrendTest::chronic');
  assert.equal(chronic.classification, 'always-failing');
  assert.equal(chronic.trend, 'chronic');
  assert.equal(chronic.trendSince, 'run-01');

  const recovered = byId(result, 'pkg.TrendTest::recovered');
  assert.equal(recovered.classification, 'cross-run flake');
  assert.equal(recovered.trend, 'recovered');
  assert.equal(recovered.trendSince, null);

  const stable = byId(result, 'pkg.TrendTest::stable');
  assert.equal(stable.trend, 'stable');
  assert.equal(stable.trendSince, null);

  const text = runCli(['scan', runs]);
  assert.equal(text.status, 0, text.stderr);
  const header = text.stdout.split('\n')[0];
  assert.match(header, /TREND/);
  const newRow = text.stdout
    .split('\n')
    .find((line) => line.includes('pkg.TrendTest::newlyFlaky'));
  assert.ok(newRow, 'the new flake row is missing');
  assert.match(newRow, /\bnew\b\s*$/);

  const explained = runCli(['explain', runs, 'pkg.TrendTest::newlyFlaky']);
  assert.equal(explained.status, 0, explained.stderr);
  assert.match(explained.stdout, /trend: new \(unstable period started in run-04\)/);
});

test('scan --format github emits one warning per new flake and keeps --json unchanged', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const body = [
      testcase('pkg.TrendTest', 'newlyFlaky', run >= 4 ? '<failure message="broke today"/>' : ''),
      testcase('pkg.TrendTest', 'chronic', '<failure message="still red"/>'),
      testcase('pkg.TrendTest', 'stable'),
    ];
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const output = runCli(['scan', runs, '--format', 'github']);
  assert.equal(output.status, 0, output.stderr);
  const annotations = output.stdout
    .split('\n')
    .filter((line) => line.startsWith('::warning '));
  assert.equal(annotations.length, 1, output.stdout);
  const annotation = annotations[0];
  assert.match(annotation, /^::warning file=/);
  assert.match(annotation, /pkg\.TrendTest::newlyFlaky/);
  assert.ok(
    annotation.includes(path.join(runs, 'run-05', 'results.xml').split(path.sep).join('/')),
    `expected the newest report path in: ${annotation}`,
  );
  assert.doesNotMatch(annotation, /pkg\.TrendTest::chronic/);
  assert.doesNotMatch(annotation, /pkg\.TrendTest::stable/);
  assert.doesNotMatch(output.stdout, /TEST ID/);

  const equalsForm = runCli(['scan', runs, '--format=github']);
  assert.equal(equalsForm.status, 0, equalsForm.stderr);
  assert.equal(equalsForm.stdout, output.stdout);

  const jsonFlag = runCli(['scan', runs, '--json']);
  const jsonFormat = runCli(['scan', runs, '--format', 'json']);
  assert.equal(jsonFormat.status, 0, jsonFormat.stderr);
  assert.equal(jsonFormat.stdout, jsonFlag.stdout);

  const invalid = runCli(['scan', runs, '--format', 'yaml']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--format must be table, json, or github/);
});

test('scan --format github stays silent when only chronic flakes exist', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 3; run += 1) {
    writeFile(
      runs,
      `run-0${run}/results.xml`,
      junit(
        [
          testcase('pkg.ChronicTest', 'stable'),
          testcase('pkg.ChronicTest', 'chronic', '<failure message="red"/>'),
        ].join('\n'),
      ),
    );
  }

  const output = runCli(['scan', runs, '--format', 'github']);
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
});

test('scan --format github points a new flake at the test source file and line', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const failing = run >= 4 ? '<failure message="broke today"/>' : '';
    writeFile(
      runs,
      `run-0${run}/results.xml`,
      junit(
        `<testcase classname="pkg.LocationTest" name="newFlake" file="test/login.test.ts" line="42">${failing}</testcase>`,
      ),
    );
  }

  const expected =
    '::warning file=test/login.test.ts,line=42,title=flake-ledger new flake::' +
    'pkg.LocationTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).';

  const annotated = runCli(['scan', runs, '--format', 'github']);
  assert.equal(annotated.status, 0, annotated.stderr);
  assert.equal(annotated.stdout, `${expected}\n`);

  const result = scanJson(runs);
  const newestAttempt = byId(result, 'pkg.LocationTest::newFlake').timeline.at(-1).attempts.at(-1);
  assert.equal(newestAttempt.file, 'test/login.test.ts');
  assert.equal(newestAttempt.line, 42);
  // The report path is still recorded separately from the source location.
  assert.equal(newestAttempt.source, path.join(runs, 'run-05', 'results.xml'));
});

test('scan --format github emits a source file without a line and reads a failure-child location', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const failing = run >= 4 ? '<failure message="broke today"/>' : '';
    const source = run === 5 ? 'file="test/login.test.ts"' : '';
    writeFile(
      runs,
      `run-0${run}/results.xml`,
      junit(
        `<testcase classname="pkg.FallbackTest" name="fileOnly" ${source}>${failing}</testcase>`,
      ),
    );
  }

  const output = runCli(['scan', runs, '--format', 'github']);
  assert.equal(output.status, 0, output.stderr);
  const annotation = output.stdout.trimEnd();
  assert.match(annotation, /^::warning file=test\/login\.test\.ts,title=flake-ledger new flake::/);
  assert.doesNotMatch(annotation, /,line=/);

  // A location on the failure child is used when the testcase does not carry
  // one. This is the shape some pytest-style reporters emit.
  const childLocation = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const failing =
      run >= 4 ? '<failure message="broke today" file="test/child.test.ts" line="7"/>' : '';
    writeFile(
      childLocation.runs,
      `run-0${run}/results.xml`,
      junit(`<testcase classname="pkg.ChildLocationTest" name="newFlake">${failing}</testcase>`),
    );
  }
  const childOutput = runCli(['scan', childLocation.runs, '--format', 'github']);
  assert.equal(childOutput.status, 0, childOutput.stderr);
  assert.match(
    childOutput.stdout,
    /^::warning file=test\/child\.test\.ts,line=7,title=flake-ledger new flake::/,
  );
});

test('scan --format github emits the exact warning command for a new flake only', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const body = [
      testcase('pkg.AnnotationTest', 'newFlake', run >= 4 ? '<failure message="broke today"/>' : ''),
      testcase('pkg.AnnotationTest', 'chronic', '<failure message="still red"/>'),
    ];
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const reportFile = path.join(runs, 'run-05', 'results.xml').split(path.sep).join('/');
  const expected =
    `::warning file=${reportFile},title=flake-ledger new flake::` +
    'pkg.AnnotationTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).';

  const annotated = runCli(['scan', runs, '--format', 'github']);
  assert.equal(annotated.status, 0, annotated.stderr);
  assert.equal(annotated.stdout, `${expected}\n`);
  assert.doesNotMatch(annotated.stdout, /pkg\.AnnotationTest::chronic/);

  // Annotations alone are report-only; the separate new-only gate is what
  // makes the job fail while keeping the annotation on the pull request.
  const gated = runCli(['scan', runs, '--format', 'github', '--fail-on', 'new']);
  assert.equal(gated.status, 1, gated.stderr);
  assert.equal(gated.stdout, `${expected}\n`);
  assert.match(gated.stderr, /1 new flake matched --fail-on new/);
  assert.doesNotMatch(gated.stdout, /pkg\.AnnotationTest::chronic/);
});

test('scan --format github escapes workflow command data and properties', (t) => {
  const { runs } = fixture(t);
  // A comma and a percent in the report path exercise property escaping; a
  // newline and a percent in the test id exercise data escaping. Without
  // escaping, the newline would start a second workflow command.
  for (let run = 1; run <= 5; run += 1) {
    writeFile(
      runs,
      `run-0${run}/100%,results/results.xml`,
      junit(testcase('pkg.Weird,Test:100%', 'new&#10;flake', run >= 4 ? '<failure/>' : '')),
    );
  }

  const output = runCli(['scan', runs, '--format', 'github']);
  assert.equal(output.status, 0, output.stderr);
  const annotation = output.stdout.trimEnd();
  assert.equal(annotation.split('\n').length, 1, output.stdout);
  assert.match(
    annotation,
    /^::warning file=.*100%25%2Cresults\/results\.xml,title=flake-ledger new flake::/,
  );
  assert.match(annotation, /::pkg\.Weird,Test:100%25::new%0Aflake is a new flake:/);
  assert.doesNotMatch(annotation, /\n/);
});

test('--fail-on new gates only new flakes while --fail-on <rate> is unchanged', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const newlyUnstable = run >= 4;
    const chronicUnstable = run >= 3;
    const body = [
      testcase('pkg.NewGateTest', 'newlyFlaky', newlyUnstable ? '<failure/>' : ''),
      testcase('pkg.NewGateTest', 'chronic', chronicUnstable ? '<failure message="red"/>' : ''),
    ];
    if (run === 5) body.push(testcase('pkg.NewGateTest', 'appearedNow', '<failure/>'));
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const newGate = runCli(['scan', runs, '--fail-on', 'new']);
  assert.equal(newGate.status, 1, newGate.stderr);
  assert.match(newGate.stderr, /pkg\.NewGateTest::newlyFlaky/);
  assert.match(newGate.stderr, /pkg\.NewGateTest::appearedNow/);
  assert.doesNotMatch(newGate.stderr, /pkg\.NewGateTest::chronic/);
  assert.match(newGate.stderr, /2 new flakes matched --fail-on new/);

  const rateGate = runCli(['scan', runs, '--fail-on', '0.4', '--min-runs', '2']);
  assert.equal(rateGate.status, 1, rateGate.stderr);
  assert.match(rateGate.stderr, /pkg\.NewGateTest::newlyFlaky/);
  assert.match(rateGate.stderr, /pkg\.NewGateTest::chronic/);

  const chronicOnly = fixture(t);
  for (let run = 1; run <= 3; run += 1) {
    writeFile(
      chronicOnly.runs,
      `run-0${run}/results.xml`,
      junit(
        [
          testcase('pkg.ChronicOnlyTest', 'stable'),
          testcase('pkg.ChronicOnlyTest', 'chronic', '<failure message="red"/>'),
        ].join('\n'),
      ),
    );
  }
  const noNewFlakes = runCli(['scan', chronicOnly.runs, '--fail-on', 'new']);
  assert.equal(noNewFlakes.status, 0, noNewFlakes.stderr);
});

test('--new-window controls how recent an unstable period must be to count as new', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const body = [testcase('pkg.WindowTest', 'newAtFour', run >= 4 ? '<failure/>' : '')];
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  assert.equal(byId(scanJson(runs), 'pkg.WindowTest::newAtFour').trend, 'new');
  assert.equal(
    byId(scanJson(runs, ['--new-window', '1']), 'pkg.WindowTest::newAtFour').trend,
    'chronic',
  );
  assert.equal(
    byId(scanJson(runs, ['--new-window', '3']), 'pkg.WindowTest::newAtFour').trend,
    'new',
  );

  const oneRunWindow = runCli(['scan', runs, '--fail-on', 'new', '--new-window', '1']);
  assert.equal(oneRunWindow.status, 0, oneRunWindow.stderr);
  const defaultWindow = runCli(['scan', runs, '--fail-on', 'new']);
  assert.equal(defaultWindow.status, 1, defaultWindow.stderr);

  const invalidWindow = runCli(['scan', runs, '--new-window', '0']);
  assert.equal(invalidWindow.status, 2);
  assert.match(invalidWindow.stderr, /must be >= 1/);

  const invalidFailOn = runCli(['scan', runs, '--fail-on', 'sometimes']);
  assert.equal(invalidFailOn.status, 2);
  assert.match(invalidFailOn.stderr, /needs 'new'/);
});

test('a test missing from the newest run is inactive, not a new flake', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const body = [testcase('pkg.InactiveTest', 'stable')];
    if (run <= 4) {
      body.push(testcase('pkg.InactiveTest', 'absentLatest', '<failure message="red"/>'));
    }
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const result = scanJson(runs);
  const record = byId(result, 'pkg.InactiveTest::absentLatest');
  assert.equal(record.classification, 'always-failing');
  assert.equal(record.trend, 'inactive');

  const gate = runCli(['scan', runs, '--fail-on', 'new']);
  assert.equal(gate.status, 0, gate.stderr);
});

test('intermittent flakes stay chronic, but a failure after a green stretch is new', (t) => {
  const { runs } = fixture(t);
  for (let run = 1; run <= 5; run += 1) {
    const alternatingRed = run % 2 === 1;
    const reawakenedRed = run === 1 || run === 5;
    const body = [
      testcase('pkg.HistoryTest', 'alternating', alternatingRed ? '<failure/>' : ''),
      testcase('pkg.HistoryTest', 'reawakened', reawakenedRed ? '<failure/>' : ''),
      testcase('pkg.HistoryTest', 'green'),
    ];
    writeFile(runs, `run-0${run}/results.xml`, junit(body.join('\n')));
  }

  const result = scanJson(runs);
  const alternating = byId(result, 'pkg.HistoryTest::alternating');
  assert.equal(alternating.classification, 'cross-run flake');
  assert.equal(alternating.trend, 'chronic');
  assert.equal(alternating.trendSince, 'run-01');

  const reawakened = byId(result, 'pkg.HistoryTest::reawakened');
  assert.equal(reawakened.classification, 'cross-run flake');
  assert.equal(reawakened.trend, 'new');
  assert.equal(reawakened.trendSince, 'run-05');
});
