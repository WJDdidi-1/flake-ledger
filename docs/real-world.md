# Measured on real test runners

`flake-ledger` 0.1.0 was developed against its own examples. This page records
the check against JUnit XML produced by real test runners, so the
`classname`/`name` and failure-element handling is measured rather than assumed.

Measured on 2026-11-09 with:

- Node.js 24.15.0 and `flake-ledger` 0.1.0 from this checkout.
- Python 3.12.2, pytest 9.2.0, and pytest-rerunfailures 16.7.
- Playwright 1.65.0 (`@playwright/test`).

Two fixtures were used. Each had ten runs, one directory per run, and each run
contains one JUnit XML file. The runners were executed with retries on purpose;
the point is to see what their JUnit XML preserves.

## pytest-rerunfailures

### Fixture

`test_checkout.py`:

```python
import os
import pytest

ATTEMPTS = {"applies_coupon": 0}


@pytest.mark.flaky(reruns=2)
def test_applies_coupon():
    ATTEMPTS["applies_coupon"] += 1
    if ATTEMPTS["applies_coupon"] == 1:
        pytest.fail("expected 10% discount, got 0")
    assert True


@pytest.mark.flaky(reruns=1)
def test_always_failing():
    pytest.fail("database is unreachable")


def test_cross_run_flake():
    run = int(os.environ["RUN_ID"])
    if run % 2 == 1:
        pytest.fail("connection reset")
    assert True


def test_stable():
    assert 1 + 1 == 2


@pytest.mark.skip(reason="not supported on this platform")
def test_skipped():
    assert False
```

`pytest.ini`:

```ini
[pytest]
junit_family = xunit2
```

Install the runner and generate ten runs:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install pytest==9.2.0 pytest-rerunfailures==16.7

rm -rf runs
for run in $(seq 1 10); do
  mkdir -p "runs/run-$run"
  RUN_ID=$run python -m pytest -q --junitxml="runs/run-$run/results.xml" || true
done
```

The fixture contains intentional failures, so pytest exits 1 and the loop uses
`|| true`; the XML is still written for every run.

### Scan

From the fixture directory, with `flake-ledger` on `PATH` (or
`node /path/to/flake-ledger/bin/flake-ledger.mjs scan runs`):

```console
$ flake-ledger scan runs
TEST ID                              RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS
test_checkout::test_always_failing   10    20        10        0              10      100.0%  0.722  failed-on-retry
test_checkout::test_applies_coupon   10    20        10        10             0       100.0%  0.722  passed-on-retry
test_checkout::test_cross_run_flake  10    10        5         0              5       50.0%   0.237  cross-run flake
test_checkout::test_skipped          10    10        0         0              0       0.0%    0.000  skipped
test_checkout::test_stable           10    10        0         0              0       0.0%    0.000  stable

10 runs, 5 tests, 70 attempts, 10 XML files.
```

### What it shows

- `test_applies_coupon` failed once and passed on retry in every run. The XML
  has two passing `<testcase>` elements for it and no `<failure>`; the scan
  reads the repeat as retry evidence and reports 20 attempts and 10
  passed-on-retry runs.
- `test_cross_run_flake` alternates pass/fail across runs; the scan reports
  `cross-run flake` in 5 of 10.
- `test_stable` and `test_skipped` stay stable and skipped.
- `test_always_failing` is reported as `failed-on-retry`: pytest writes a
  passing attempt followed by the final failure for a test that exhausts its
  retries.

## Playwright

### Fixture

Install the runner. The tests below do not use a browser page, so no browser
download is needed; the Playwright test runner and its two projects are still
real.

```sh
npm init -y
npm install --save-dev @playwright/test@1.65.0
```

`playwright.config.js` (with retry evidence enabled):

```js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'checkout.spec.js',
  retries: 0,
  workers: 1,
  reporter: [
    ['junit', {
      outputFile: `runs/run-${process.env.RUN_ID}/results.xml`,
      includeRetries: true,
    }],
  ],
  projects: [
    { name: 'chromium' },
    { name: 'firefox' },
  ],
});
```

`checkout.spec.js`:

```js
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

function attemptCount() {
  const info = test.info();
  const dir = path.join(__dirname, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const safeTitle = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const file = path.join(dir, `${process.env.RUN_ID}-${info.project.name}-${safeTitle}.json`);
  let count = 0;
  try {
    count = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  count += 1;
  fs.writeFileSync(file, JSON.stringify(count));
  return count;
}

test.describe('checkout', () => {
  test.describe.configure({ retries: 2 });

  test('applies coupon', async () => {
    if (attemptCount() === 1) {
      throw new Error('expected 10% discount, got 0');
    }
    expect(1 + 1).toBe(2);
  });
});

test.describe('failures', () => {
  test.describe.configure({ retries: 1 });

  test('always failing', async () => {
    throw new Error('database is unreachable');
  });
});

test('cross-run flake', async () => {
  if (Number(process.env.RUN_ID) % 2 === 1) {
    throw new Error('connection reset');
  }
  expect(1 + 1).toBe(2);
});

test('stable', async () => {
  expect(1 + 1).toBe(2);
});

test.skip('skipped', async () => {
  expect(1).toBe(2);
});
```

Generate ten runs:

```sh
rm -rf runs state
for run in $(seq 1 10); do
  mkdir -p "runs/run-$run"
  RUN_ID=$run ./node_modules/.bin/playwright test || true
done
```

The fixture contains intentional failures, so Playwright exits 1 and the loop
uses `|| true`; the XML is still written for every run.

### Scan

```console
$ flake-ledger scan runs
TEST ID                                      RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS
checkout.spec.js::failures › always failing  10    40        10        0              10      100.0%  0.722  always-failing
checkout.spec.js::checkout › applies coupon  10    40        10        10             0       100.0%  0.722  passed-on-retry
checkout.spec.js::cross-run flake            10    20        5         0              5       50.0%   0.237  cross-run flake
checkout.spec.js::skipped                    10    20        0         0              0       0.0%    0.000  skipped
checkout.spec.js::stable                     10    20        0         0              0       0.0%    0.000  stable

10 runs, 5 tests, 140 attempts, 10 XML files.
```

### What it shows

- `checkout › applies coupon` fails its first attempt in each project and then
  passes on retry. With `includeRetries: true`, the XML carries a
  `<flakyError>` for the earlier attempt; the scan reports 40 attempts and 10
  passed-on-retry runs.
- `stable` appears once per project per run, for 20 attempts, and is still
  `stable`. The two `<testsuite>` elements have the same name but different
  `hostname` values (chromium and firefox), so they are separate executions,
  not retries.
- `failures › always failing` carries `<rerunError>` plus the final `<error>`
  and is reported as `always-failing`.
- `cross-run flake` fails in the odd runs and passes in the even runs, for
  `cross-run flake` in 5 of 10.

### Default reporter caveat

Playwright's JUnit reporter only writes retry elements when `includeRetries` is
enabled. With the default reporter, the same ten runs used:

```js
reporter: [['junit', { outputFile: `runs/run-${process.env.RUN_ID}/results.xml` }]],
```

and printed:

```console
$ flake-ledger scan runs
TEST ID                                      RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS
checkout.spec.js::failures › always failing  10    20        10        0              10      100.0%  0.722  always-failing
checkout.spec.js::cross-run flake            10    20        5         0              5       50.0%   0.237  cross-run flake
checkout.spec.js::checkout › applies coupon  10    20        0         0              0       0.0%    0.000  stable
checkout.spec.js::skipped                    10    20        0         0              0       0.0%    0.000  skipped
checkout.spec.js::stable                     10    20        0         0              0       0.0%    0.000  stable

10 runs, 5 tests, 100 attempts, 10 XML files.
```

The recovered test now has 20 attempts, 0 passed-on-retry runs, and class
`stable`: the retry evidence is not in the XML. Set `includeRetries: true` (or
`PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1`) if you want the ledger to see retries.

## Limitations

- This measures pytest-rerunfailures and Playwright. Surefire is covered by the
  checked-in example and the unit tests, not by a live Maven run here.
- JUnit XML is lossy. A scanner can only report retries the runner writes:
  pytest-rerunfailures repeats the passing testcase, Playwright writes
  `flakyError`/`rerunError` only with `includeRetries`, and Surefire writes
  `flakyFailure`/`rerunFailure`.
- The fixtures are not checked in because they need external runners. The
  sources and commands above are enough to recreate them.
