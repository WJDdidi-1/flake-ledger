#!/usr/bin/env node
// Run the real flake-ledger CLI against the five-run JUnit fixture in
// examples/runs and check the numbers the README claims.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoRoot, 'bin', 'flake-ledger.mjs');
const runsDir = path.join(repoRoot, 'examples', 'runs');
const runsArg = 'examples/runs';

function quote(part) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : JSON.stringify(part);
}

function display(args) {
  return ['node bin/flake-ledger.mjs', ...args.map(quote)].join(' ');
}

function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function show(title, args, result, options = {}) {
  console.log(`\n${title}`);
  console.log(`$ ${display(args)}`);
  if (options.stdout !== false) process.stdout.write(result.stdout);
  if (options.stderr !== false) process.stderr.write(result.stderr);
}

const temporary = mkdtempSync(path.join(tmpdir(), 'flake-ledger-example-'));
const quarantineFile = path.join(temporary, 'flaky.txt');

try {
  console.log('flake-ledger runnable example');
  console.log(`fixtures: ${runsArg} (5 CI runs, one JUnit XML report per run)`);
  console.log('This runs the checked-in CLI, not a mock.');

  // 1. The ranked ledger.
  const scanArgs = ['scan', runsArg];
  const scan = run(scanArgs);
  check(scan.status === 0, `scan exited ${scan.status}: ${scan.stderr}`);
  show('1. Rank every test across the five runs', scanArgs, scan);
  check(
    scan.stdout.includes(
      'com.example.CheckoutTest::appliesCoupon     5     7         2         2              0       40.0%  0.118  passed-on-retry',
    ),
    'scan table is missing the passed-on-retry row',
  );
  check(
    scan.stdout.includes('5 runs, 5 tests, 27 attempts, 5 XML files.'),
    'scan totals changed',
  );

  // 2. The timeline that produced the score.
  const explainArgs = [
    'explain',
    runsArg,
    'com.example.CheckoutTest::appliesCoupon',
  ];
  const explain = run(explainArgs);
  check(explain.status === 0, `explain exited ${explain.status}: ${explain.stderr}`);
  show("2. Show one test's per-run timeline", explainArgs, explain);
  check(
    explain.stdout.includes('run run-01  passed-on-retry  2 attempts'),
    'explain is missing the run-01 retry',
  );
  check(
    explain.stdout.includes('#1 failed') &&
      explain.stdout.includes('expected 10% discount, got 0') &&
      explain.stdout.includes('#2 passed') &&
      explain.stdout.includes('(retried)'),
    'explain is missing the failed-then-passed attempt pair',
  );

  // 3. The CI gate: write the quarantine list and fail on a crossed threshold.
  const gateArgs = [
    'scan',
    runsArg,
    '--quarantine',
    quarantineFile,
    '--fail-on',
    '0.2',
    '--min-runs',
    '5',
  ];
  const gate = run(gateArgs);
  check(gate.status === 1, `gate should exit 1, got ${gate.status}: ${gate.stderr}`);
  show('3. Gate CI on the same ledger', gateArgs, gate, { stdout: false });
  console.log(`exit code 1 (expected: three flaky tests crossed --fail-on 0.2)`);

  const quarantined = readFileSync(quarantineFile, 'utf8').trimEnd().split('\n');
  console.log('\nquarantine file (temporary):');
  console.log(quarantined.join('\n'));
  check(
    quarantined.join('\n') ===
      [
        'com.example.LoginTest::rejectsExpiredToken',
        'com.example.SearchTest::filtersByPrice',
        'com.example.CheckoutTest::appliesCoupon',
      ].join('\n'),
    'quarantine list changed',
  );

  // 4. Machine-readable totals, and the classifications behind the table.
  const jsonArgs = ['scan', runsArg, '--json'];
  const json = run(jsonArgs);
  check(json.status === 0, `scan --json exited ${json.status}: ${json.stderr}`);
  console.log('\n4. Check the machine-readable ledger');
  console.log(`$ ${display(jsonArgs)}`);
  const ledger = JSON.parse(json.stdout);
  console.log(`totals: ${JSON.stringify(ledger.totals)}`);
  check(
    JSON.stringify(ledger.totals) ===
      JSON.stringify({ files: 5, runs: 5, tests: 5, attempts: 27 }),
    `unexpected totals: ${JSON.stringify(ledger.totals)}`,
  );

  const byId = new Map(ledger.tests.map((test) => [test.id, test]));
  const checkout = byId.get('com.example.CheckoutTest::appliesCoupon');
  check(checkout, 'checkout test is missing from JSON');
  check(checkout.classification === 'passed-on-retry', 'checkout is not passed-on-retry');
  check(checkout.runs === 5 && checkout.attempts === 7, 'checkout run/attempt counts changed');
  check(checkout.passedOnRetryRuns === 2, 'checkout retry count changed');
  check(
    byId.get('com.example.LoginTest::rejectsExpiredToken').classification === 'cross-run flake',
    'login test is not a cross-run flake',
  );
  check(
    byId.get('com.example.SearchTest::filtersByPrice').classification === 'cross-run flake',
    'search test is not a cross-run flake',
  );
  check(byId.get('com.example.CartTest::addsItem').classification === 'stable', 'cart test is not stable');
  check(byId.get('com.example.ReportTest::exportsCsv').classification === 'skipped', 'report test is not skipped');

  console.log(`\nAll checks passed. The ledger above comes from ${runsArg}.`);
  console.log('Try editing a fixture (or point the CLI at your own runs) and run this again.');
} catch (error) {
  console.error(`\nexample failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
