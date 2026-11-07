# flake-ledger example

Five CI runs, one JUnit XML report per run, checked in so you can see the ledger
without installing anything first. The reports are small but exercise the
interesting cases: a test that failed and passed on retry, two tests that failed
in some runs and passed in others, a stable test, and a skipped test.

## Run it

From the repository root:

```sh
npm run example
```

or directly:

```sh
node examples/demo.mjs
```

The script runs the real CLI against `examples/runs`, prints four steps, and
exits nonzero if any of the numbers below stop matching. It has no
dependencies and does not write outside a temporary directory.

You can also run the commands yourself:

```sh
node bin/flake-ledger.mjs scan examples/runs
node bin/flake-ledger.mjs explain examples/runs 'com.example.CheckoutTest::appliesCoupon'
node bin/flake-ledger.mjs scan examples/runs --json --top 3
```

## What is in the fixture

```text
examples/runs/
  run-01/results.xml
  run-02/results.xml
  run-03/results.xml
  run-04/results.xml
  run-05/results.xml
```

Each file is a separate run because it sits in its own directory. Every run has
the same five tests:

| Test | Runs | Attempts | Unstable | Pass-on-retry | Classification |
| --- | ---: | ---: | ---: | ---: | --- |
| `com.example.LoginTest::rejectsExpiredToken` | 5 | 5 | 2 | 0 | cross-run flake |
| `com.example.SearchTest::filtersByPrice` | 5 | 5 | 2 | 0 | cross-run flake |
| `com.example.CheckoutTest::appliesCoupon` | 5 | 7 | 2 | 2 | passed-on-retry |
| `com.example.CartTest::addsItem` | 5 | 5 | 0 | 0 | stable |
| `com.example.ReportTest::exportsCsv` | 5 | 5 | 0 | 0 | skipped |

`run-01` and `run-03` contain Surefire-style `<flakyFailure>` evidence for
`CheckoutTest::appliesCoupon`: the report records the failed attempt and the
pass that followed it. That is why the test has seven attempts across five runs
and stays visible after the run went green.

## What to look for

`scan` ranks by a 95% Wilson lower bound on the unstable rate, so the two
cross-run flakes and the passed-on-retry test all score `0.118` from `2/5`
unstable runs, and the stable/skipped tests score `0.000`:

```text
TEST ID                                     RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS
com.example.LoginTest::rejectsExpiredToken  5     5         2         0              2       40.0%  0.118  cross-run flake
com.example.SearchTest::filtersByPrice      5     5         2         0              2       40.0%  0.118  cross-run flake
com.example.CheckoutTest::appliesCoupon     5     7         2         2              0       40.0%  0.118  passed-on-retry
com.example.CartTest::addsItem              5     5         0         0              0       0.0%   0.000  stable
com.example.ReportTest::exportsCsv          5     5         0         0              0       0.0%   0.000  skipped

5 runs, 5 tests, 27 attempts, 5 XML files.
```

`explain` shows why `appliesCoupon` is not just a passing test. Run it yourself
to see the per-run timeline, including the failed attempt, its assertion
message, and the retried pass.

The demo's third step writes the quarantine list and applies the CI gate:

```sh
node bin/flake-ledger.mjs scan examples/runs \
  --quarantine flaky.txt --fail-on 0.2 --min-runs 5
```

Three tests cross 20%, so the command exits 1; `flaky.txt` contains their ids.
Without `--fail-on` the same scan is report-only and exits 0.

## Use your own reports

Point the CLI at the directory where your CI downloads JUnit XML. The first
directory below the path is treated as one run:

```sh
node bin/flake-ledger.mjs scan path/to/runs
```

If your reports are flat files or sharded differently, see the layouts in the
main [README](../README.md#input-layout) and use `--group-by`.
