import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flake-ledger.mjs');

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'flake-ledger-review-'));
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

function junit(timestamp, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pkg.ReviewTest" timestamp="${timestamp}">
${body}
  </testsuite>
</testsuites>
`;
}

function testcase(name, body = '') {
  return `    <testcase classname="pkg.ReviewTest" name="${name}">${body}</testcase>`;
}

function writeRun(runs, run, body) {
  return writeFile(runs, `${run}/results.xml`, junit(`2026-02-${run.slice(-2)}T10:00:00`, body));
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function reviewJson(file, runs, extraArgs = []) {
  const result = runCli(['review', file, runs, '--json', ...extraArgs]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('review releases a quarantined test with no failure in the newest five runs', (t) => {
  const { root, runs } = fixture(t);
  writeRun(runs, 'run-01', testcase('checkout', '<failure message="expected 200, got 503"/>'));
  for (let run = 2; run <= 6; run += 1) {
    writeRun(runs, `run-0${run}`, testcase('checkout'));
  }
  const quarantine = writeFile(root, 'quarantine.txt', 'pkg.ReviewTest::checkout\n');

  const result = runCli(['review', quarantine, runs]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^release pkg\.ReviewTest::checkout \(stable for 5 runs; last failure: run-01\)$/m,
  );

  const output = reviewJson(quarantine, runs);
  assert.equal(output.stableFor, 5);
  assert.equal(output.released.length, 1);
  assert.deepEqual(output.released[0], {
    id: 'pkg.ReviewTest::checkout',
    stableFor: 5,
    lastFailureRun: 'run-01',
    reason: 'no failure in the newest 5 runs',
  });
  assert.deepEqual(output.kept, []);
  assert.deepEqual(output.unknown, []);
});

test('review keeps a quarantined test that is still failing', (t) => {
  const { root, runs } = fixture(t);
  writeRun(runs, 'run-01', testcase('checkout'));
  for (let run = 2; run <= 6; run += 1) {
    writeRun(runs, `run-0${run}`, testcase('checkout', '<failure message="still red"/>'));
  }
  const quarantine = writeFile(root, 'quarantine.txt', 'pkg.ReviewTest::checkout\n');

  const result = runCli(['review', quarantine, runs]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^keep pkg\.ReviewTest::checkout \(stable for 0 of 5 runs; failed in run-06\)$/m,
  );

  const output = reviewJson(quarantine, runs);
  assert.equal(output.released.length, 0);
  assert.equal(output.kept.length, 1);
  assert.equal(output.kept[0].id, 'pkg.ReviewTest::checkout');
  assert.equal(output.kept[0].stableFor, 0);
  assert.equal(output.kept[0].lastFailureRun, 'run-06');
  assert.match(output.kept[0].reason, /failed in run-06/);
});

test('review reports unknown ids without crashing or failing the command', (t) => {
  const { root, runs } = fixture(t);
  writeRun(runs, 'run-01', testcase('stable'));
  const quarantine = writeFile(
    root,
    'quarantine.txt',
    '# ids from an old quarantine\npkg.ReviewTest::stable\npkg.ReviewTest::gone\n',
  );

  const result = runCli(['review', quarantine, runs]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^unknown pkg\.ReviewTest::gone \(not found in the scanned runs\)$/m);

  const output = reviewJson(quarantine, runs);
  assert.equal(output.unknown.length, 1);
  assert.equal(output.unknown[0].id, 'pkg.ReviewTest::gone');
  assert.equal(output.unknown[0].lastFailureRun, null);
  assert.equal(output.unknown[0].reason, 'not found in the scanned runs');
});

test('--stable-for controls how many clean runs release a quarantine', (t) => {
  const { root, runs } = fixture(t);
  writeRun(runs, 'run-01', testcase('checkout', '<failure message="red once"/>'));
  for (let run = 2; run <= 4; run += 1) {
    writeRun(runs, `run-0${run}`, testcase('checkout'));
  }
  const quarantine = writeFile(root, 'quarantine.txt', 'pkg.ReviewTest::checkout\n');

  const five = reviewJson(quarantine, runs);
  assert.equal(five.released.length, 0);
  assert.equal(five.kept.length, 1);
  assert.match(five.kept[0].reason, /only 4 runs observed; needs 5/);

  const three = reviewJson(quarantine, runs, ['--stable-for', '3']);
  assert.equal(three.released.length, 1);
  assert.equal(three.released[0].stableFor, 3);
  assert.equal(three.released[0].lastFailureRun, 'run-01');

  const invalid = runCli(['review', quarantine, runs, '--stable-for', '0']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--stable-for must be >= 1/);
});

test('review reads the file written by scan --quarantine and releases only stale ids', (t) => {
  const { root, runs } = fixture(t);
  const common = [testcase('checkout'), testcase('search'), testcase('report')];

  writeRun(runs, 'run-01', common.join('\n'));
  writeRun(
    runs,
    'run-02',
    [testcase('checkout', '<failure message="red"/>'), testcase('search'), testcase('report')].join(
      '\n',
    ),
  );
  writeRun(
    runs,
    'run-03',
    [testcase('checkout'), testcase('search', '<failure message="red"/>'), testcase('report')].join(
      '\n',
    ),
  );

  const quarantine = path.join(root, 'quarantine.txt');
  const written = runCli(['scan', runs, '--quarantine', quarantine]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(
    readFileSync(quarantine, 'utf8'),
    'pkg.ReviewTest::checkout\npkg.ReviewTest::search\n',
  );

  writeRun(
    runs,
    'run-04',
    [testcase('checkout'), testcase('search'), testcase('report')].join('\n'),
  );
  writeRun(
    runs,
    'run-05',
    [testcase('checkout'), testcase('search'), testcase('report')].join('\n'),
  );

  const output = reviewJson(quarantine, runs, ['--stable-for', '3']);
  assert.deepEqual(
    output.released.map((item) => item.id),
    ['pkg.ReviewTest::checkout'],
  );
  assert.equal(output.released[0].lastFailureRun, 'run-02');
  assert.deepEqual(
    output.kept.map((item) => item.id),
    ['pkg.ReviewTest::search'],
  );
  assert.equal(output.kept[0].lastFailureRun, 'run-03');
  assert.match(output.kept[0].reason, /failed in run-03/);
});

test('review refuses an unreadable quarantine file with a clear exit code', (t) => {
  const { root, runs } = fixture(t);
  writeRun(runs, 'run-01', testcase('stable'));
  const missing = path.join(root, 'missing.txt');

  const result = runCli(['review', missing, runs]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read quarantine file/);

  const usage = runCli(['review', 'only-one-argument']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /review needs a <quarantine-file> and a <runs-dir>/);
});
