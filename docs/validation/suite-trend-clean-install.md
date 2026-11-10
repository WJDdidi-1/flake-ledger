# Verified: the suite trend from a clean `npm pack` + install

This page records the third milestone of **Show whether the suite is getting
flakier over time**. The previous milestone added per-run `unstableTests`,
`flakyRate`, and `newFlakes` fields plus the top-level `suite` block. This page
checks that those fields survive `npm pack` and an install into an empty
directory, and that the installed binary prints the same summary line and JSON
on the checked-in five-run fixture.

Measured on 2026-11-10 with Node.js 24.15.0 and npm 11.12.1 on macOS arm64
(Darwin 27.2.0), using the working tree under review.

> The tarball reports version `0.4.0` because `package.json` has not been bumped
> yet. It is the unreleased tree after the per-run fields landed, not the
> published `flake-ledger@0.4.0` tarball. The published baseline without these
> fields is recorded in
> [`suite-trend-0.4.0.md`](suite-trend-0.4.0.md); the release milestone bumps
> the version when this change ships.

## Pack from the checkout and install into an empty directory

Run this from a clean checkout. The only input is the local tarball; the
installed package does not resolve back to the checkout.

```sh
checkout=/path/to/flake-ledger
work=$(mktemp -d)
mkdir -p "$work/dist" "$work/app"

cd "$checkout"
npm pack --pack-destination "$work/dist"

cd "$work/app"
npm init --yes > /dev/null
npm install --no-audit --no-fund "$work"/dist/flake-ledger-*.tgz

node node_modules/flake-ledger/bin/flake-ledger.mjs --version
# 0.4.0
```

The pack included 16 files: `package.json`, `README.md`, `LICENSE`, `bin/`,
`lib/`, and `examples/`. It did not include the test suite or `docs/`, so the
verification below exercises the same subset a registry install would receive.

## Reproduce the fixture through the installed binary

Copy the checked-in five-run fixture next to the installed package. It is plain
JUnit XML, so no test runner is needed:

```sh
cp -R "$checkout/examples/runs" ./runs
node node_modules/flake-ledger/bin/flake-ledger.mjs scan runs
```

The table and summary line are the block documented in the README's "A real
session" section:

```console
TEST ID                                     RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
com.example.LoginTest::rejectsExpiredToken  5     5         2         0              2       40.0%  0.118  cross-run flake  recovered
com.example.SearchTest::filtersByPrice      5     5         2         0              2       40.0%  0.118  cross-run flake  new
com.example.CheckoutTest::appliesCoupon     5     7         2         2              0       40.0%  0.118  passed-on-retry  recovered
com.example.CartTest::addsItem              5     5         0         0              0       0.0%   0.000  stable           stable
com.example.ReportTest::exportsCsv          5     5         0         0              0       0.0%   0.000  skipped          stable

5 runs, 5 tests, 27 attempts, 5 XML files.
Suite trend: improving (first window 30.0%, last window 20.0%).
```

The last line is the suite-level direction. It is separate from the per-test
`TREND` column: a row can be `new` or `recovered` while the suite as a whole is
moving in the other direction.

## Confirm the JSON fields from the installed package

`--json` still carries the original volume counters and adds the flakiness
fields to every run, plus one top-level `suite` object:

```sh
node node_modules/flake-ledger/bin/flake-ledger.mjs scan runs --json > scan.json
node -e '
const r = require("./scan.json");
console.log("top keys:", JSON.stringify(Object.keys(r)));
console.log("run keys:", JSON.stringify(Object.keys(r.runs[0])));
for (const run of r.runs) {
  console.log([
    run.id,
    run.testCount,
    run.attemptCount,
    run.unstableTests,
    run.flakyRate,
    run.newFlakes,
  ].join("\t"));
}
console.log("suite:", JSON.stringify(r.suite));
'
```

```console
top keys: ["tool","version","runsDir","totals","runs","tests","warnings","suite"]
run keys: ["id","path","startedAt","files","fileCount","testCount","attemptCount","unstableTests","flakyRate","newFlakes"]
run-01	5	6	2	0.4	2
run-02	5	5	1	0.2	1
run-03	5	6	1	0.2	0
run-04	5	5	1	0.2	1
run-05	5	5	1	0.2	1
suite: {"trend":"improving","firstWindowRate":0.30000000000000004,"lastWindowRate":0.2}
```

The run window is now readable without walking the per-test timelines:
`unstableTests` is the count of tests whose outcome in that run is unstable,
`flakyRate` is `unstableTests / testCount`, and `newFlakes` is the number of
tests whose current unstable period started in that run. `newFlakes` does not
feed the suite direction; it is a separate "what started here" counter.

## How the two windows are compared

The direction is deliberately simple and deterministic:

1. Order the runs exactly as `scan` prints them: by `<testsuite>` timestamp
   when both runs have one, otherwise by run id and then path.
2. Drop runs with `testCount == 0`; they contain no flakiness signal.
3. Set `windowSize = max(1, floor(observedRuns / 2))`.
4. Average `flakyRate` over the first `windowSize` runs and the last
   `windowSize` runs. When the run count is odd, the middle run is in neither
   window; with one run, both windows are that run.
5. If the last-window average is greater than the first by more than
   `1e-9`, the trend is `worsening`; if it is smaller by that much, it is
   `improving`; otherwise it is `flat`.

For the five-run fixture the window size is `floor(5 / 2) = 2`:

| Window | Runs averaged | Per-run rates | Average |
| --- | --- | --- | ---: |
| first | run-01, run-02 | `2/5 = 40.0%`, `1/5 = 20.0%` | 30.0% |
| last | run-04, run-05 | `1/5 = 20.0%`, `1/5 = 20.0%` | 20.0% |

`run-03` is the middle run and is not part of either window. The last average
is lower than the first, so the result is `improving`. The summary line formats
the averages to one decimal place (`30.0%`, `20.0%`); the JSON keeps the raw
floating-point values.

A single observed run makes both windows the same run, so the result is
`flat` with equal rates. With no runs that contain testcases, both rates are
`0` and the trend is `flat`; there is no earlier point to compare.

These windows are based on the number of runs and are **not** controlled by
`--new-window`. That option only decides whether an individual test's current
unstable period is labeled `new` or `chronic`.

## What the clean install proves

- The installed binary, not the checkout entry point, produced the table,
  summary line, and JSON above.
- Every `runs[]` object has `unstableTests`, `flakyRate`, and `newFlakes` in
  addition to `testCount` and `attemptCount`; the top-level object has `suite`.
- The README's suite summary line and the JSON values match the checked-in
  fixture exactly.
- `npm test` passes on the same tree, including the checked-in fixture
  regression test and the scripted worsening, improving, and flat timelines.
